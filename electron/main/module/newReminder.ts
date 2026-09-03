/**
 * 全新提醒引擎（替代 job.ts 中的旧 reminder 调度）
 *
 * - 数据全部落在 newSql.ts 的 `reminders` 表（仅此 module 操作该表）。
 * - 三种模式：定点(time) / 周期(interval) / 多状态(stateful)。
 * - 待办截止提醒也已并入本引擎（syncTodoReminders，source='todo'），统一调度/触发/免打扰/重启恢复。
 * - 多状态（番茄钟）时间线由本进程持有，通过 `tips-state-change`(A：状态进入=提醒到了，
 *   弹通知+写记录) 与 `tips-state-sync`(B：仅补偿/恢复/停止，不弹不记) 两条通道下发，
 *   渲染端只消费 store，绝不再自行计算「下次时间」。
 * - 布尔字段（recordAfter/lockScreen/sequential/continueLoop/loop/enabled）以 1/0 存库。
 * - 数组字段（states/weekDays）以 JSON 字符串存库。
 *
 * 事件通道统一以 `tips-*` 前缀，与旧 `reminder-*` 完全隔离。
 */

import { BrowserWindow, ipcMain } from "electron";
import { win, focusAppToTop, hideApp, isMainWindowVisible } from "./mainWindow.ts";
import { query, upsert, del as sqlDel, myDb, ensureTableExists } from "./newSql.ts";

const TABLE = "reminders";

/** 多状态运行时（每条 stateful 提醒一条） */
interface StatefulRT {
  reminder: any;
  index: number; // 当前所处的序列状态在 states 中的下标
  startedAt: number; // 当前状态真实进入时刻
  nextTime: number | null; // 当前状态结束（下一状态进入）时刻
  cycleStart: number; // 本轮第 1 个序列状态的绝对进入时刻
  injected?: { state: any; resumeIndex: number }; // 被注入的非序列状态
  stopped?: boolean; // 序列已结束（loop=0 跑完一轮）
}

// 定时器索引：定点/周期用 setTimeout/setInterval；多状态推进用 setTimeout
const timers: Record<string, NodeJS.Timeout> = {};
// 多状态运行时索引
const statefulRT: Record<string, StatefulRT> = {};
// 渲染端在运行时尚未建好时请求过状态 → 建好后补发首帧
let pendingStateRequest = false;

// ============================ 工具 ============================

function getWin(): BrowserWindow | undefined {
  if (win && !win.isDestroyed()) return win;
  return BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
}

// 把内存中的提醒对象序列化为 DB 行（1/0 数值 + JSON 字符串）
function serialize(r: any) {
  const row: any = { ...r };
  row.enabled = Number(r.enabled) ? 1 : 0;
  row.recordAfter = Number(r.recordAfter) ? 1 : 0;
  row.loop = Number(r.loop) ? 1 : 0;
  row.states = r.states ? JSON.stringify(r.states) : null;
  row.weekDays = r.weekDays && r.weekDays.length ? JSON.stringify(r.weekDays) : null;
  // 空闲时间（免打扰时段）：数组字段，以 JSON 字符串存库，格式 [{start:"HH:mm",end:"HH:mm"}]
  row.idleTime = r.idleTime && Array.isArray(r.idleTime) && r.idleTime.length
    ? JSON.stringify(r.idleTime)
    : null;
  for (const k of ["startTime", "interval", "unit", "minute", "dayOfMonth", "month"]) {
    if (row[k] === undefined || row[k] === null || row[k] === "") row[k] = null;
    else row[k] = Number(row[k]);
  }
  return row;
}

// 把 DB 行解析回内存对象（1/0 数值 + 解析 JSON）
// 兼容两种输入：① 数据库行（states/weekDays 是 JSON 字符串）；
// ② 渲染端直接传来的纯对象（states/weekDays 已是数组/对象）。
// 注意：渲染端 tips-save 传入的 reminder 里的 states 是真实数组，
// 不能对它再 JSON.parse，否则会把数组 toString 后解析失败 → 变成 []，
// 进而被 tips-save 的"空数组保护"用旧库值覆盖，导致编辑不落库。
function parseJsonField(v: any, fallback: any[]): any[] {
  if (Array.isArray(v)) return v;           // 已是数组：原样保留
  if (v && typeof v === "object") return [v];
  if (typeof v === "string" && v.trim()) {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? parsed : parsed == null ? fallback : [parsed];
    } catch {
      return fallback;
    }
  }
  return fallback;
}

function parse(row: any) {
  const r: any = { ...row };
  r.enabled = Number(row.enabled) === 1 ? 1 : 0;
  r.recordAfter = Number(row.recordAfter) === 1 ? 1 : 0;
  r.loop = Number(row.loop) === 1 ? 1 : 0;
  r.states = parseJsonField(row.states, []);
  r.weekDays = parseJsonField(row.weekDays, []);
  r.idleTime = parseJsonField(row.idleTime, []);
  return r;
}

// ============================ 空闲时间（免打扰时段） ============================
//
// 数据形态：idleTime 为数组，元素为 { start: "HH:mm", end: "HH:mm" } 的每日固定时段。
// 当前时间落在任一时段内 → 视为「空闲中」，该提醒不触发（定点/周期不通知；
// 多状态不进入状态/不弹/不写）。空闲时段结束 → 立即开始新的或新一轮提醒。
// 时段支持跨午夜（start > end，如 22:00-06:00）。

// 将 "HH:mm" 转为当日分钟数；非法返回 -1
function toMinOfDay(t?: string): number {
  if (!t || typeof t !== "string") return -1;
  const parts = t.split(":").map((n) => Number(n));
  if (parts.length < 2 || parts.some((n) => isNaN(n))) return -1;
  return parts[0] * 60 + parts[1];
}

// 判断给定时刻是否处于空闲时段内
function isInIdlePeriod(idle: any, now: Date): boolean {
  if (!Array.isArray(idle) || idle.length === 0) return false;
  const cur = now.getHours() * 60 + now.getMinutes();
  for (const w of idle) {
    const s = toMinOfDay(w?.start);
    const e = toMinOfDay(w?.end);
    if (s < 0 || e < 0) continue;
    if (s > e) {
      // 跨午夜：晚段 [s,24) 或 早段 [0,e)
      if (cur >= s || cur < e) return true;
    } else if (s <= e) {
      if (cur >= s && cur < e) return true;
    }
  }
  return false;
}

// 若当前正处于某个空闲时段内，返回该时段结束的绝对时间戳（用于挂「空闲结束」唤醒定时器）；否则返回 null
function nextIdleEnd(idle: any, now: Date): number | null {
  if (!Array.isArray(idle) || idle.length === 0) return null;
  const cur = now.getHours() * 60 + now.getMinutes();
  const mk = (dayOffset: number, h: number, m: number) => {
    const d = new Date(now);
    d.setDate(d.getDate() + dayOffset);
    d.setHours(h, m, 0, 0);
    return d.getTime();
  };
  for (const w of idle) {
    const s = toMinOfDay(w?.start);
    const e = toMinOfDay(w?.end);
    if (s < 0 || e < 0) continue;
    if (s > e) {
      // 跨午夜
      if (cur >= s) return mk(1, Math.floor(e / 60), e % 60); // 晚段 → 次日结束
      if (cur < e) return mk(0, Math.floor(e / 60), e % 60); // 早段 → 当日结束
    } else if (s <= e) {
      if (cur >= s && cur < e) return mk(0, Math.floor(e / 60), e % 60);
    }
  }
  return null;
}

// 若当前未在空闲时段内，返回「下一个空闲时段开始」的绝对时间戳（用于在空闲开始
// 那一刻即时挂起，而不是等到下一个状态边界才被空闲闸捕获，避免「继续上一轮」）。
// 已在空闲中时返回 null（无需监听开始）。
function nextIdleStart(idle: any, now: Date): number | null {
  if (!Array.isArray(idle) || idle.length === 0) return null;
  if (isInIdlePeriod(idle, now)) return null; // 已在空闲中
  const cur = now.getHours() * 60 + now.getMinutes();
  const mk = (dayOffset: number, h: number, m: number) => {
    const d = new Date(now);
    d.setDate(d.getDate() + dayOffset);
    d.setHours(h, m, 0, 0);
    return d.getTime();
  };
  let best: number | null = null;
  for (const w of idle) {
    const s = toMinOfDay(w?.start);
    const e = toMinOfDay(w?.end);
    if (s < 0 || e < 0) continue;
    let ts: number;
    if (s > e) {
      // 跨午夜：当前在 (e, s) 区间（必不在空闲中）→ 今天晚段开始
      ts = cur < s ? mk(0, Math.floor(s / 60), s % 60) : mk(1, Math.floor(s / 60), s % 60);
    } else {
      ts = cur < s ? mk(0, Math.floor(s / 60), s % 60) : mk(1, Math.floor(s / 60), s % 60);
    }
    if (best == null || ts < best) best = ts;
  }
  return best;
}

// 空闲结束唤醒：立即开始新的（定点/周期）或新一轮（多状态）
function resumeAfterIdle(r: any): void {
  const now = Date.now();
  // 安全兜底：若仍处空闲（极端时钟漂移），重新挂唤醒
  if (isInIdlePeriod(r.idleTime, new Date(now))) {
    scheduleIdleWakeup(r);
    return;
  }
  if (r.mode === "stateful") {
    // 多状态：空闲结束立即重开新一轮。运行时已存在则重启轮次；否则（如冷启动即在空闲中、
    // 从未建过运行时）直接启动，由 startStatefulReminder 进入首个状态。
    if (statefulRT[r.id]) restartStatefulRound(r.id);
    else startStatefulReminder(r);
    return;
  }
  // 定点/周期：立即触发一次，并重新排程后续
  broadcastTrigger({ ...r, triggerTime: now });
  scheduleReminder(r);
}

// 挂「空闲结束」一次性唤醒定时器（key 与正常定时器区分，避免互相覆盖）
function scheduleIdleWakeup(r: any): void {
  const key = "idle-" + r.id;
  if (timers[key]) return; // 已挂，去重
  const end = nextIdleEnd(r.idleTime, new Date());
  if (!end) return;
  const delay = Math.max(0, end - Date.now());
  timers[key] = setTimeout(() => {
    delete timers[key];
    resumeAfterIdle(r);
  }, delay);
}

// 清除某提醒的空闲唤醒定时器
function clearIdleWakeup(id: string): void {
  const key = "idle-" + id;
  if (timers[key]) {
    clearTimeout(timers[key]);
    delete timers[key];
  }
}

// ============================ 广播 ============================

function broadcastChange(payload: any) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (w && !w.isDestroyed() && w.webContents) w.webContents.send("tips-state-change", payload);
  }
}

function broadcastSync(payload: any) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (w && !w.isDestroyed() && w.webContents) w.webContents.send("tips-state-sync", payload);
  }
}

function broadcastTrigger(payload: any) {
  const w = getWin();
  if (!w || !w.webContents) return;
  // 待办截止提醒（source='todo'）改走 todo-reminder-trigger，App.vue 监听弹通知（逻辑不变）
  if (payload?.source === "todo") {
    w.webContents.send("todo-reminder-trigger", {
      key: payload.refKey,
      title: payload.title,
      dueDate: payload.dueDate,
      triggerTime: payload.triggerTime,
    });
    return;
  }
  w.webContents.send("tips-trigger", payload);
}

function sendStarttimeUpdated(id: string, startTime: number) {
  const w = getWin();
  if (w && w.webContents) w.webContents.send("tips-starttime-updated", { id, startTime });
}

// ============================ 持久化 ============================

async function persistReminder(r: any): Promise<void> {
  await upsert({ tableName: TABLE, data: serialize(r), config: { primaryKey: "id", primaryKeyType: "TEXT" } });
}

async function loadAll(): Promise<any[]> {
  const rows = await query({ tableName: TABLE });
  return (rows || []).map(parse);
}

async function loadOne(id: string): Promise<any | null> {
  const rows = await query({ tableName: TABLE, conditions: { id } });
  if (rows && rows.length) return parse(rows[0]);
  return null;
}

// ============================ 内置番茄钟 ============================

function makePomodoroSeed(): any {
  return {
    id: "pomodoro",
    mode: "stateful",
    title: "番茄钟",
    content: "",
    enabled: 1,
    startTime: Date.now(),
    loop: 1,
    recordAfter: 0,
    states: [
      { key: "work", label: "工作", content: "", duration: 35, unit: 60 * 1000, record: 1, lockScreen: 0, sequential: 1, continueLoop: 1 },
      { key: "rest", label: "休息", content: "", duration: 5, unit: 60 * 1000, record: 1, lockScreen: 0, sequential: 1, continueLoop: 1 },
      // 非序列状态：强制锁屏。lockScreen=1 进入时锁屏；sequential=0 不进循环；
      // duration=0 永久（需手动解除）；continueLoop=0 → 解锁后开始新循环（按用户定义）。
      { key: "lock", label: "强制锁屏", content: "已开启强制锁屏，请输入密码解除", duration: 0, unit: 1000, record: 1, lockScreen: 1, sequential: 0, continueLoop: 0 },
    ],
  };
}

async function seedPomodoro(): Promise<void> {
  const all = await loadAll();
  // 找到内置番茄钟行（id 固定为 "pomodoro"）
  const pomodoro = all.find((r) => r.id === "pomodoro");
  // 仅当「不存在」或「states 已损坏（空/非序列）」时才插入/覆盖默认种子。
  // 否则保留用户可能调整过的配置（如自定义状态时长），不强制还原。
  if (!pomodoro || !Array.isArray(pomodoro.states) || pomodoro.states.length === 0) {
    const seed = makePomodoroSeed();
    if (pomodoro) {
      // 行已存在但 states 损坏：保留其 startTime（不重置轮次），仅用默认 states 覆盖重写
      seed.startTime = pomodoro.startTime && !isNaN(Number(pomodoro.startTime))
        ? pomodoro.startTime
        : Date.now();
    }
    await persistReminder(seed);
  }
}

/**
 * 修复历史上被错误建表的 reminders（旧逻辑把 id 建成 INTEGER 主键，
 * 而本系统 id 是字符串如 "pomodoro"，导致插字符串进 INTEGER 主键报 SQLITE_MISMATCH）。
 * 在错误 schema 下数据根本无法落库（写入即报错），故表必为空，直接删表后由后续
 * ensureTableExists 以 TEXT 主键重建即可，无数据可丢失。
 */
async function repairRemindersSchema(): Promise<void> {
  const db = myDb?.db;
  if (!db) return;
  const meta = await new Promise<any>((res) =>
    db.get("SELECT sql FROM sqlite_master WHERE type='table' AND name=?", [TABLE], (_e: any, r: any) => res(r || null))
  );
  if (!meta) return; // 首次运行：交给 ensureTableExists 用 TEXT 主键创建
  if (!/INTEGER PRIMARY KEY/i.test(meta.sql || "")) return; // 已是正确的 TEXT 主键，无需处理
  await new Promise<void>((res) => db.run("DROP TABLE IF EXISTS " + TABLE, () => res()));
}

// ============================ 调度入口 ============================

async function scheduleAll(): Promise<void> {
  for (const id in timers) {
    clearTimeout(timers[id]);
    clearInterval(timers[id] as any);
    delete timers[id];
  }
  const all = await loadAll();
  for (const r of all) {
    if (!r.enabled) continue;
    scheduleReminder(r);
  }
}

// ============ 待办截止提醒并入本引擎 ============
// 原 job.ts 的 todoReminderJobs（cron）已迁移至此：待办截止提醒复用 newReminder 的
// 调度/触发/免打扰/重启恢复，形成单一提醒引擎。每条待办按 count×interval 在 dueDate
// 前生成多个 once 型触发点，写成 reminders 表行（id=todo:<key>:#<i>，source='todo'），
// 由 scheduleReminder/nextFireTime 统一调度；到点经 broadcastTrigger 的 source 分支
// 改发 todo-reminder-trigger（App.vue 监听，弹通知逻辑不变）。
export async function syncTodoReminders(key?: string): Promise<void> {
  const db = myDb?.db;
  if (!db) return;

  // 1) 清掉受影响的旧 todo: 行（先停定时器再删库行）
  let oldIds: string[] = [];
  try {
    const oldRows = (await query({
      tableName: TABLE,
      SqlStr: `SELECT id, refKey FROM ${TABLE} WHERE source = 'todo'`,
    })) as any[] | null;
    oldIds = ((oldRows || []) as any[])
      .filter((r) => !key || r.refKey === key)
      .map((r) => r.id);
  } catch {
    // 首次运行 source 列尚未创建（由下方 upsert 自动补列），无旧行可清
    oldIds = [];
  }
  for (const id of oldIds) {
    stopReminder(id);
    await sqlDel({ tableName: TABLE, condition: { id } });
  }

  // 2) 读待办，按「到期前 count 次 / 间隔 interval」重新生成触发点
  const todos = await new Promise<any[]>((resolve) => {
    db.all("SELECT * FROM todo_list", [], (err: any, rows: any[]) => {
      resolve(err ? [] : (rows || []));
    });
  });
  const now = Date.now();
  for (const todo of (todos || [])) {
    if (key && todo.key !== key) continue;
    const isDone = todo.status
      ? todo.status === "completed" || todo.status === "cancelled"
      : Number(todo.completed) === 1;
    if (isDone) continue;
    if (Number(todo.deadlineReminder) !== 1) continue;
    const due = new Date(String(todo.dueDate).replace(" ", "T")).getTime();
    if (isNaN(due) || due <= now) continue; // 已过期不排程

    const intervalMs =
      Number(
        todo.remindIntervalUnit === "hour"
          ? Number(todo.remindInterval) * 3600000
          : Number(todo.remindInterval) * 60000
      ) || 30 * 60000;
    const count = Math.min(50, Math.max(1, Number(todo.remindCount) || 1));

    for (let i = 0; i < count; i++) {
      const t = due - i * intervalMs;
      if (t <= now + 1000) continue; // 仅排程未来时间点（留 1s 余量）
      const fire = new Date(t);
      const y = fire.getFullYear();
      const mo = String(fire.getMonth() + 1).padStart(2, "0");
      const d = String(fire.getDate()).padStart(2, "0");
      const h = String(fire.getHours()).padStart(2, "0");
      const mi = String(fire.getMinutes()).padStart(2, "0");
      const row = {
        id: `todo:${todo.key}#${i}`,
        source: "todo",
        refKey: todo.key,
        title: todo.title || "待办事项",
        content: "",
        dueDate: todo.dueDate,
        mode: "time",
        repeat: "once",
        date: `${y}-${mo}-${d}`,
        time: `${h}:${mi}`,
        enabled: 1,
        recordAfter: 0,
        loop: 0,
      };
      await upsert({ tableName: TABLE, data: row, config: { primaryKey: "id" } });
      scheduleReminder(row);
    }
  }
}

function stopReminder(id: string): void {
  if (timers[id]) {
    clearTimeout(timers[id]);
    clearInterval(timers[id] as any);
    delete timers[id];
  }
  clearIdleWakeup(id); // 一并清理空闲唤醒定时器
  delete statefulRT[id];
}

function scheduleReminder(r: any): void {
  // enabled=0：关闭后取消该提醒的全部执行（定时器 + 多状态运行时 + 空闲唤醒），
  // 并下发 stopped 同步让渲染端 UI 复位。这是覆盖三种模式的单一拦截点：
  // stateful 不再 tick、time/interval 定时器被清、下次触发不再排程。
  if (!r.enabled) {
    const rt = statefulRT[r.id];
    const st = rt && rt.reminder && rt.reminder.states ? rt.reminder.states[rt.index] : null;
    stopReminder(r.id); // 清定时器 + 删多状态运行时 + 清空闲唤醒
    broadcastSync({
      reminderId: r.id,
      stopped: true,
      stateKey: st ? st.key : null,
      stateLabel: st ? st.label : null,
    });
    return;
  }
  // 重新排程前先清掉旧的空闲唤醒定时器，下面会按当前空闲状态重新评估
  clearIdleWakeup(r.id);

  // 空闲时段（免打扰）：不排程任何触发，仅挂「空闲结束」唤醒定时器。
  // 空闲结束后由 resumeAfterIdle 立即开始新的（定点/周期）或新一轮（多状态）提醒。
  if (r.idleTime?.length && isInIdlePeriod(r.idleTime, new Date())) {
    scheduleIdleWakeup(r);
    // 多状态：若已有运行时，停止其推进定时器并下发「空闲中」同步（不弹不记、不进入状态）
    if (r.mode === "stateful" && statefulRT[r.id]) {
      clearTimeout(timers[r.id]);
      delete timers[r.id];
      broadcastIdleSync(r.id, statefulRT[r.id]);
    }
    return;
  }

  if (r.mode === "stateful") {
    const futureStart = Number(r.startTime) > Date.now();
    if (statefulRT[r.id] && !futureStart) {
      // 运行中且开始时间已到（含过去）：原地重算，保留运行时（不删 statefulRT）。
      // 终止旧的推进定时器（克隆表达式）由 rescheduleStatefulAdvance 负责，无需整体销毁运行时。
      const rt = statefulRT[r.id];
      rt.reminder = r; // 原地替换配置（含新时长）
      // 注意：不要在此处无条件覆盖 rt.cycleStart —— recomputeRuntime 会根据情形
      // （整轮过期→开新轮时把 cycleStart 对齐到 now 并写库；运行中→沿用旧 cycleStart）
      // 自行维护 cycleStart，避免运行时 cycleStart 与库里 startTime 脱节导致反复判过期、
      // 状态错乱（表现为连续进入同态）。
      realignStatefulRuntime(rt, Date.now()); // 新时长重算当前态；整轮过期→开新轮
      rescheduleStatefulAdvance(r.id); // 终止旧定时器，按新 nextTime 重新排程
      emitCurrentStateful(r.id); // channel B：仅刷 UI，不弹不记
      // 注意：编辑重算属于「配置变更、非状态流转」，不触发窗口置顶/隐藏行为，
      // 避免用户在设置页改时长时误把应用置顶锁定或隐藏。
    } else {
      // 全新启动 / 开始时间在未来：销毁旧运行时后按未来首轮重建
      if (statefulRT[r.id]) delete statefulRT[r.id];
      startStatefulReminder(r);
    }
    return;
  }
  // 定点/周期：清旧定时器后重排
  stopReminder(r.id);
  if (r.mode === "interval") {
    const gap = Number(r.interval) * Number(r.unit);
    if (!gap || gap <= 0) return;
    timers[r.id] = setInterval(() => {
      // 空闲时段：本次不触发，挂唤醒定时器，空闲结束立即开始新一轮
      if (isInIdlePeriod(r.idleTime, new Date())) {
        scheduleIdleWakeup(r);
        return;
      }
      broadcastTrigger({ ...r, triggerTime: Date.now() });
    }, gap);
  } else if (r.mode === "time") {
    const next = nextFireTime(r);
    if (!next) return;
    const delay = Math.max(0, next - Date.now());
    timers[r.id] = setTimeout(() => {
      // 空闲时段：本次不触发，挂唤醒定时器，空闲结束立即开始新一轮
      if (isInIdlePeriod(r.idleTime, new Date())) {
        scheduleIdleWakeup(r);
        return;
      }
      broadcastTrigger({ ...r, triggerTime: Date.now() });
      scheduleReminder(r); // 排下一次
    }, delay);
  }
}

// 定点模式：计算下一个未来触发时刻（纯 JS，对齐渲染端 nextCronTime）
function nextFireTime(r: any): number | null {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const toTs = (yr: number, mo: number, da: number, h: number, mi: number) =>
    new Date(yr, mo - 1, da, h, mi, 0, 0).getTime();
  const [h, m] = (r.time || "09:00").split(":").map(Number);

  if (r.repeat === "hourly") {
    const mi = r.minute ?? 0;
    let t = new Date(now);
    t.setMinutes(mi, 0, 0);
    if (t.getTime() <= now.getTime()) t = new Date(t.getTime() + 3600000);
    return t.getTime();
  }
  if (r.repeat === "daily") {
    let t = toTs(now.getFullYear(), now.getMonth() + 1, now.getDate(), h, m);
    if (t <= now.getTime()) t += 86400000;
    return t;
  }
  if (r.repeat === "weekly") {
    const days = r.weekDays || [];
    for (let add = 0; add < 8; add++) {
      const d = new Date(now.getTime() + add * 86400000);
      if (days.includes(d.getDay())) {
        const t = toTs(d.getFullYear(), d.getMonth() + 1, d.getDate(), h, m);
        if (t > now.getTime()) return t;
      }
    }
    return null;
  }
  if (r.repeat === "monthly") {
    const dom = r.dayOfMonth || 1;
    for (let add = 0; add < 62; add++) {
      const d = new Date(now.getTime() + add * 86400000);
      if (d.getDate() === dom) {
        const t = toTs(d.getFullYear(), d.getMonth() + 1, d.getDate(), h, m);
        if (t > now.getTime()) return t;
      }
    }
    return null;
  }
  if (r.repeat === "yearly") {
    const mon = r.month || 1;
    const dom = r.dayOfMonth || 1;
    for (let add = 0; add < 400; add++) {
      const d = new Date(now.getTime() + add * 86400000);
      if (d.getMonth() + 1 === mon && d.getDate() === dom) {
        const t = toTs(d.getFullYear(), d.getMonth() + 1, d.getDate(), h, m);
        if (t > now.getTime()) return t;
      }
    }
    return null;
  }
  if (r.repeat === "once") {
    const parts = (r.date || "").split("-").map(Number);
    if (parts.length < 3) return null;
    const t = toTs(parts[0], parts[1], parts[2], h, m);
    return t > now.getTime() ? t : null;
  }
  return null;
}

// ============================ 多状态引擎 ============================

function isSeq(s: any): boolean {
  return Number(s.sequential) !== 0;
}

function sequentialIndices(reminder: any): number[] {
  const states = reminder.states || [];
  const idx: number[] = [];
  states.forEach((s: any, i: number) => {
    if (isSeq(s)) idx.push(i);
  });
  return idx;
}

// 序列状态循环里取 index 的下一个下标（loop 时回首位；无后续返回 -1）
function nextSequentialIndex(reminder: any, index: number): number {
  const seqStates = sequentialIndices(reminder);
  if (seqStates.length === 0) return -1;
  const pos = seqStates.indexOf(index);
  if (pos < 0) return seqStates[0]; // 当前是非序列状态，从首个序列状态继续
  return pos + 1 < seqStates.length ? seqStates[pos + 1] : reminder.loop ? seqStates[0] : -1;
}

// 第 fromIdx 到第 toIdx 在周期内的累计偏移（毫秒）
function seqOffsetFromCycleStart(reminder: any, fromIdx: number, toIdx: number): number {
  const seqIdx = sequentialIndices(reminder);
  if (fromIdx === toIdx) return 0;
  const posFrom = seqIdx.indexOf(fromIdx);
  const posTo = seqIdx.indexOf(toIdx);
  if (posFrom < 0 || posTo < 0) return 0;
  let offset = 0;
  let cursor = posFrom;
  while (cursor !== posTo) {
    const i = seqIdx[cursor];
    const s = reminder.states[i];
    offset += Number(s.duration) * Number(s.unit);
    cursor = cursor + 1 < seqIdx.length ? cursor + 1 : 0;
    if (cursor === posFrom) break;
  }
  return offset;
}

// 进入状态时的窗口干预：
//  - lockScreen===1：强制置顶全屏（专注锁屏），用户无法切走。
//  - lockScreen===0：解除置顶并隐藏应用（退出锁屏态，释放钉死，开始专注/休息）。
//    仅当窗口当前可见时才隐藏，避免对已是隐藏/最小化的窗口重复操作。
function applyStateWindowBehavior(state: any) {
  if (!state) return;
  if (Number(state.lockScreen) === 1) {
    focusAppToTop();
  } else {
    // 非锁屏态：解除置顶 + 隐藏应用。
    // 用 isMainWindowVisible 做护栏：仅当窗口确实对用户可见时才隐藏，
    // 既满足「进入工作态隐藏主窗口」的预期，又不重复 hide/不误伤已隐藏的窗口。
    if (isMainWindowVisible()) {
      hideApp();
    }
  }
}

/**
 * 将运行时按当前时间对齐到正确轮次：
 *  - 整轮已过期（cycleStart + 整轮时长 ≤ now）：开始新一轮，cycleStart/startTime/startedAt 对齐到 now，
 *    并直接写库（persistReminder），满足「刷新开始时间为当前时间，开始新一轮」。
 *  - 未过期：续跑当前状态，保持 cycleStart/startTime 不动。
 * 统一入口，避免分散实现导致 nextTime 倒流。
 */
// ============================ 多状态运行时统一计算 ============================
//
// 总计算函数 recomputeRuntime(rt, now) 按情形分派到三个子函数，
// 计算「给定当前时间 now，运行时应处于哪个状态、已进入多久、下一状态何时」，
// 写回 rt.index / rt.startedAt / rt.nextTime。
//
// 核心约定：rt.startedAt 是「进入【当前正在运行】状态的真实时刻」（历史事实，
// 不受编辑时长影响）。编辑时长后用【新时长】以 startedAt 为锚点向后递推，
// 即可精确得出「当前状态 + 已运行时长」，且 nextTime 永远落在未来，杜绝空转。
//
// 例：序列 A(3) B(1) C(2)，当前在 B（真实已跑 0.7min，startedAt=进入B时刻）。
//     改 A(2) B(0.5) C(3) 后：B 新时长 0.5，0.7 溢出 0.2 → 当前 C、已跑 0.2min。
//     若 cycleStart + 新整轮(2+0.5+3) ≤ now → 开新一轮 A（0min）。

// 子函数1：注入态（非序列状态被强制插入）。不进入序列递推，直接返回该注入态。
function caseInjected(rt: any): { index: number; startedAt: number; nextTime: number | null } {
  const idx = rt.reminder.states.indexOf(rt.injected.state);
  // 注入态 duration 通常为 0（如强制锁屏），nextTime 由注入/结束流程单独管理，
  // 这里不排程推进（rescheduleStatefulAdvance 对 injected 短路）。
  return { index: idx, startedAt: rt.startedAt, nextTime: null };
}

// 子函数2：整轮已过期 → 开始新一轮（首个序列状态，startedAt 对齐到 now）。
function caseWholeRoundExpired(rt: any, now: number): { index: number; startedAt: number; nextTime: number | null } {
  const seqIdx = sequentialIndices(rt.reminder);
  const firstIdx = seqIdx[0];
  const firstGap = Number(rt.reminder.states[firstIdx].duration) * Number(rt.reminder.states[firstIdx].unit);
  rt.cycleStart = now;
  rt.reminder.startTime = now;
  // 直接写库，不依赖渲染端回写（避免启动补偿时渲染端监听未就绪导致丢失）
  persistReminder(rt.reminder).catch((e) => console.error("persistStartTime 失败:", e));
  sendStarttimeUpdated(rt.reminder.id, now);
  return {
    index: firstIdx,
    startedAt: now,
    nextTime: firstGap > 0 ? now + firstGap : null,
  };
}

// 子函数3：运行中，以【进入当前状态的真实时刻 rt.startedAt】为锚点，用【新时长】向后递推，
// 找 now 落在哪个状态（处理溢出到下一状态、多状态溢出、序列结束溢出开新轮）。
function caseRunningFromAnchor(rt: any, now: number): { index: number; startedAt: number; nextTime: number | null } {
  const reminder = rt.reminder;
  // 锚点：进入当前正在运行状态的真实时刻，不被编辑改变。
  let t = rt.startedAt;
  let cursor = rt.index;
  let remain = now - t; // 从锚点起已过去的真实时间
  if (remain < 0) remain = 0; // 防御：时钟回拨等极端情况

  const maxSteps = sequentialIndices(reminder).length * 2 + 2;
  for (let step = 0; step < maxSteps; step++) {
    const state = reminder.states[cursor];
    if (!state) break;
    const dur = Number(state.duration) * Number(state.unit);
    if (dur <= 0) {
      // 零时长状态：视为瞬时，直接作为「当前态」，不占时间
      return { index: cursor, startedAt: t, nextTime: null };
    }
    if (remain < dur) {
      // now 落在 cursor 区间内，已运行 remain。
      // 关键：startedAt 必须是「真正进入当前态的时刻」= now - remain，
      // 而不是锚点递推链的 t（t 可能远早于 now，导致 nextTime 倒流/推进错位）。
      // 这样 nextTime = now - remain + dur ≥ now，永远落在未来，杜绝空转与重复同态。
      return { index: cursor, startedAt: now - remain, nextTime: now - remain + dur };
    }
    // 溢出，推进到下一序列状态
    remain -= dur;
    t += dur;
    const next = nextSequentialIndex(reminder, cursor);
    if (next < 0) {
      // 序列已结束（loop=0）仍溢出整轮 → 开新一轮
      return caseWholeRoundExpired(rt, now);
    }
    cursor = next;
  }
  // 兜底（理论上不会到）：回到首个状态，以 now 为新起点
  const seqIdx = sequentialIndices(reminder);
  const firstIdx = seqIdx[0];
  const firstGap = Number(reminder.states[firstIdx].duration) * Number(reminder.states[firstIdx].unit);
  return { index: firstIdx, startedAt: now, nextTime: firstGap > 0 ? now + firstGap : null };
}

// 子函数4：未来首轮（开始时间 startTime 在 now 之后，尚未进入任何状态）。
// 此时不排程推进，也不下发「当前状态」，由 startStatefulReminder 在到点后正式进入。
function caseFutureStart(rt: any, now: number): { index: number; startedAt: number; nextTime: number | null } {
  const seqIdx = sequentialIndices(rt.reminder);
  const firstIdx = seqIdx[0];
  return { index: firstIdx, startedAt: Number(rt.reminder.startTime), nextTime: null };
}

// 总计算函数：按情形分派，写回 rt.index / rt.startedAt / rt.nextTime。
// 返回计算结果，便于调用方在需要时读取（如调试）。
function recomputeRuntime(rt: any, now: number): { index: number; startedAt: number; nextTime: number | null } {
  const reminder = rt.reminder;
  const seqIdx = sequentialIndices(reminder);
  if (seqIdx.length === 0) {
    rt.index = 0;
    rt.startedAt = now;
    rt.nextTime = null;
    return { index: 0, startedAt: now, nextTime: null };
  }

  // 情形1：注入态（非序列状态强制插入）——不进序列递推
  if (rt.injected) {
    const r = caseInjected(rt);
    rt.index = r.index;
    rt.startedAt = r.startedAt;
    rt.nextTime = r.nextTime;
    return r;
  }

  // 整轮时长（用新时长累加序列态）
  const cycleDuration = seqIdx.reduce((sum: number, i: number) => {
    const s = reminder.states[i];
    return sum + Number(s.duration) * Number(s.unit);
  }, 0);

  // 情形F：未来首轮（开始时间 startTime 在 now 之后，尚未进入任何状态）。
  // 不排程推进、不下发当前状态，由 startStatefulReminder 在到点后正式进入首个状态。
  const startTs = Number(reminder.startTime);
  if (!isNaN(startTs) && startTs > now) {
    const r = caseFutureStart(rt, now);
    rt.index = r.index;
    rt.startedAt = r.startedAt;
    rt.nextTime = r.nextTime;
    return r;
  }

  const cycleStart = rt.cycleStart;

  // 情形2：整轮已过期（开始时间 + 新整轮时长 ≤ now）→ 开新一轮
  if (cycleDuration > 0 && cycleStart + cycleDuration <= now) {
    const r = caseWholeRoundExpired(rt, now);
    rt.index = r.index;
    rt.startedAt = r.startedAt;
    rt.nextTime = r.nextTime;
    return r;
  }

  // 情形3：运行中，从锚点递推
  const r = caseRunningFromAnchor(rt, now);
  rt.index = r.index;
  rt.startedAt = r.startedAt;
  rt.nextTime = r.nextTime;
  return r;
}

// 对外兼容别名：历史调用方（scheduleReminder / startStatefulReminder / requestTipsState）
// 仍使用 realignStatefulRuntime 名字，内部统一委托 recomputeRuntime。
function realignStatefulRuntime(rt: any, now: number) {
  return recomputeRuntime(rt, now);
}

function startStatefulReminder(reminder: any) {
  // 防御性双保险：关闭状态（enabled=0）不应启动任何多状态运行时
  if (!reminder.enabled) return;
  if (!reminder.states || !reminder.states.length) return;
  const seqIdx = sequentialIndices(reminder);
  if (seqIdx.length === 0) return;
  const firstIdx = seqIdx[0];
  const now = Date.now();

  // 空闲时段（免打扰）：不进入状态、不构建/推进运行时；仅挂唤醒定时器，
  // 空闲结束由 resumeAfterIdle 重开新一轮。保持「空闲中（已暂停）」占位态。
  if (reminder.idleTime?.length && isInIdlePeriod(reminder.idleTime, new Date(now))) {
    scheduleIdleWakeup(reminder);
    if (statefulRT[reminder.id]) {
      clearTimeout(timers[reminder.id]);
      delete timers[reminder.id];
      broadcastIdleSync(reminder.id, statefulRT[reminder.id]);
    }
    return;
  }

  if (!(reminder.startTime && !isNaN(reminder.startTime))) {
    reminder.startTime = now;
    persistReminder(reminder).catch(() => {});
  }

  // 已存在运行时（重复触发 / 编辑配置）：对齐 + 静默恢复，不弹通知
  if (statefulRT[reminder.id]) {
    const rt = statefulRT[reminder.id];
    rt.reminder = reminder;
    realignStatefulRuntime(rt, now);
    rescheduleStatefulAdvance(reminder.id);
    emitCurrentStateful(reminder.id);
    // 恢复已有运行时属于「非状态流转」，不触发窗口置顶/隐藏行为。
    return;
  }

  // 新建运行时：以 startTime 为轮次基准初始化，交给 recomputeRuntime 统一分派
  // （覆盖情形 C 整轮过期开新轮 / F 未来首轮 / D 运行中续跑 / E 首次启动），
  // 消除此处原先与 recompute 重复且不一致的整轮过期手写逻辑。
  statefulRT[reminder.id] = {
    reminder,
    index: firstIdx,
    startedAt: Number(reminder.startTime) || now,
    cycleStart: Number(reminder.startTime) || now,
    nextTime: null,
  };
  realignStatefulRuntime(statefulRT[reminder.id], now);
  const rt = statefulRT[reminder.id];

  if (rt.nextTime === null && rt.startedAt > now) {
    // 情形F：未来首轮 —— 排程到点后正式进入首个状态（按 lockScreen 触发行为）
    const delay = Math.max(0, rt.startedAt - now);
    if (timers[reminder.id]) {
      clearTimeout(timers[reminder.id]);
      delete timers[reminder.id];
    }
    timers[reminder.id] = setTimeout(() => {
      const cur = statefulRT[reminder.id];
      if (cur) emitStatefulEnter(reminder.id, firstIdx);
    }, delay);
    emitCurrentStateful(reminder.id);
    return;
  }

  // 整轮过期开新轮（caseWholeRoundExpired 已将 cycleStart/startTime 对齐到 now）：
  // 睡眠错过整轮后不要立刻弹锁屏，延迟 30s 再进入首个状态。
  const justStartedNewRound = rt.cycleStart >= now - 100;
  if (justStartedNewRound && rt.nextTime !== null) {
    emitCurrentStateful(reminder.id); // 先刷 UI（不落库、不弹）
    if (timers[reminder.id]) {
      clearTimeout(timers[reminder.id]);
      delete timers[reminder.id];
    }
    timers[reminder.id] = setTimeout(() => {
      const cur = statefulRT[reminder.id];
      if (cur) emitStatefulEnter(reminder.id, firstIdx); // 延迟 30s 进入首个状态
    }, 30000);
    return;
  }

  // 运行中 / 上一轮仍在进行（含首次启动 startTime≈now）：恢复展示 + 排程推进，
  // 属于「非状态流转」恢复，不触发窗口置顶/隐藏行为，也不重复落库。
  rescheduleStatefulAdvance(reminder.id);
  emitCurrentStateful(reminder.id);
}

// 进入指定状态并排程推进（channel A：状态进入=提醒到了）
// skipIdle=true 表示用户手动触发（强制切状态/解锁注入态/空闲结束恢复），绕过空闲免打扰闸。
function emitStatefulEnter(id: string, index: number, skipIdle = false): void {
  const rt = statefulRT[id];
  if (!rt) return;
  // 空闲时段：自动状态流转不触发，不进入状态、不弹、不记；挂唤醒定时器，空闲结束重开新一轮
  if (!skipIdle && rt.reminder?.idleTime?.length && isInIdlePeriod(rt.reminder.idleTime, new Date())) {
    scheduleIdleWakeup(rt.reminder);
    broadcastIdleSync(id, rt); // 仅刷新 UI 为「空闲中」
    return;
  }
  const states = rt.reminder.states;
  const state = states[index];
  if (!state) return;
  const gap = Number(state.duration) * Number(state.unit);

  // 关键：记录「真实进入该状态的时刻」，否则后续 nextTime 会基于陈旧的 startedAt
  // 算出过去值，导致 rescheduleStatefulAdvance 的 delay 恒为 0 → 状态机在
  // 工作/休息间以 0ms 间隔无限互切、疯狂弹通知（页面卡死）。
  rt.startedAt = Date.now();
  rt.index = index;

  const next = computeNextState(rt, index, false);
  const nextAbsTime = gap > 0 ? rt.startedAt + gap : null;
  rt.nextTime = nextAbsTime;

  applyStateWindowBehavior(state);

  const payload = buildPayload(rt, state, next.nextState, false, nextAbsTime);
  broadcastChange(payload);

  // 排程推进（永久态不排程）
  if (gap > 0) {
    rescheduleStatefulAdvance(id);
  }
}

// 仅下发状态切换（不排程推进）：用于永久态（duration=0）进入
// skipIdle=true 表示用户手动触发（强制锁屏注入），绕过空闲免打扰闸。
function emitStatefulEvent(id: string, index: number, isInjected: boolean, nextTime: number | null, skipIdle = false): void {
  const rt = statefulRT[id];
  if (!rt) return;
  // 空闲时段：自动状态流转不触发；手动注入（skipIdle）可绕过
  if (!skipIdle && rt.reminder?.idleTime?.length && isInIdlePeriod(rt.reminder.idleTime, new Date())) {
    scheduleIdleWakeup(rt.reminder);
    broadcastIdleSync(id, rt);
    return;
  }
  const states = rt.reminder.states;
  const state = states[index];
  if (!state) return;
  const next = computeNextState(rt, index, isInjected);
  applyStateWindowBehavior(state);
  const payload = buildPayload(rt, state, next.nextState, isInjected, nextTime);
  broadcastChange(payload);
}

// 重发当前状态（channel B：仅刷新，不弹不记）
function emitCurrentStateful(id: string): void {
  const rt = statefulRT[id];
  if (!rt) return;
  // 空闲时段：不下发真实状态，仅下发「空闲中」同步，让 UI 展示已暂停
  if (rt.reminder?.idleTime?.length && isInIdlePeriod(rt.reminder.idleTime, new Date())) {
    broadcastIdleSync(id, rt);
    return;
  }
  const states = rt.reminder.states;
  let state: any;
  let isInjected = false;
  let nextState: any = null;
  if (rt.injected) {
    state = rt.injected.state;
    isInjected = true;
    const seqStates = sequentialIndices(rt.reminder);
    const pos = seqStates.indexOf(rt.injected.resumeIndex);
    const nextSeqIndex = pos >= 0 && pos + 1 < seqStates.length ? seqStates[pos + 1] : rt.reminder.loop ? seqStates[0] : -1;
    nextState = nextSeqIndex >= 0 ? states[nextSeqIndex] : null;
  } else {
    state = states[rt.index];
    const nextIndex = nextSequentialIndex(rt.reminder, rt.index);
    nextState = nextIndex >= 0 ? states[nextIndex] : null;
  }
  if (!state) return;
  const payload = buildPayload(rt, state, nextState, isInjected, rt.injected ? null : rt.nextTime);
  broadcastSync(payload);
}

// 计算下一状态（注入态归位到 resumeIndex 的下一个序列状态；序列态按循环推进）
function computeNextState(rt: any, index: number, isInjected: boolean): { nextState: any } {
  const states = rt.reminder.states;
  if (isInjected && rt.injected) {
    const seqStates = sequentialIndices(rt.reminder);
    const pos = seqStates.indexOf(rt.injected.resumeIndex);
    const nextSeqIndex = pos >= 0 && pos + 1 < seqStates.length ? seqStates[pos + 1] : rt.reminder.loop ? seqStates[0] : -1;
    return { nextState: nextSeqIndex >= 0 ? states[nextSeqIndex] : null };
  }
  const nextIndex = nextSequentialIndex(rt.reminder, index);
  return { nextState: nextIndex >= 0 ? states[nextIndex] : null };
}

function buildPayload(rt: any, state: any, nextState: any, isInjected: boolean, nextTime: number | null) {
  return {
    reminderId: rt.reminder.id,
    idle: false,
    stateKey: state.key,
    stateLabel: state.label,
    nextStateKey: nextState ? nextState.key : null,
    nextStateLabel: nextState ? nextState.label : null,
    stateStartTime: rt.startedAt,
    nextTime,
    injected: isInjected,
    title: rt.reminder.title || "提醒",
    content: state.content && String(state.content).trim() ? state.content : `${state.label}提醒到了`,
    recordable: Number(state.record) !== 0,
  };
}

// 下发「空闲中」同步（channel B）：用于空闲时段内让渲染端展示「空闲中（已暂停）」，
// 不弹通知、不写记录、不进入状态。仅作 UI 刷新用途。
function broadcastIdleSync(id: string, rt: any) {
  if (!rt || !rt.reminder) return;
  const states = rt.reminder.states;
  let state: any;
  let isInjected = false;
  if (rt.injected) {
    state = rt.injected.state;
    isInjected = true;
  } else {
    state = states?.[rt.index];
  }
  broadcastSync({
    reminderId: id,
    idle: true,
    stateKey: state ? state.key : null,
    stateLabel: state ? state.label : null,
    nextStateKey: null,
    nextStateLabel: null,
    stateStartTime: rt.startedAt,
    nextTime: null,
    injected: isInjected,
    title: rt.reminder.title || "提醒",
    content: "",
    recordable: 0,
  });
}

function rescheduleStatefulAdvance(id: string): void {
  if (timers[id]) {
    clearTimeout(timers[id]);
    delete timers[id];
  }
  const rt = statefulRT[id];
  if (!rt || rt.injected || !rt.nextTime) return;

  // 空闲时段（免打扰）：不排程推进。若本状态结束前会先进入空闲，则把推进定时器
  // 提前到「空闲开始」那一刻触发，触发后立即挂起并显示「空闲中」，以免空闲期间
  // 仍按上一轮继续倒计时（即「继续上一轮」）。空闲结束仍由 resumeAfterIdle 重开新一轮。
  const idle = rt.reminder?.idleTime;
  if (Array.isArray(idle) && idle.length) {
    const now = Date.now();
    if (isInIdlePeriod(idle, new Date(now))) {
      scheduleIdleWakeup(rt.reminder); // 补挂空闲结束唤醒（幂等）
      broadcastIdleSync(id, rt); // 已在空闲中：立即挂起，不下发真实状态
      return;
    }
    const idleStart = nextIdleStart(idle, new Date(now));
    if (idleStart != null && idleStart < rt.nextTime) {
      const delay = Math.max(0, idleStart - now);
      timers[id] = setTimeout(() => {
        delete timers[id];
        // 时间漂移校验：此刻确实进入空闲才挂起，否则重新评估
        if (isInIdlePeriod(idle, new Date())) {
          scheduleIdleWakeup(rt.reminder); // 挂「空闲结束」唤醒，空闲结束重开新一轮
          broadcastIdleSync(id, rt); // 挂起：显示「空闲中（已暂停）」
        } else {
          rescheduleStatefulAdvance(id);
        }
      }, delay);
      return;
    }
  }

  const delay = Math.max(0, rt.nextTime - Date.now());
  timers[id] = setTimeout(() => advanceStateful(id), delay);
}

// 状态推进：自动流转到下一个状态
function advanceStateful(id: string): void {
  const rt = statefulRT[id];
  if (!rt || rt.stopped) return;
  if (rt.injected) {
    // 注入态结束 → 按 continueLoop 归位或开新一轮
    endInjectedState(id);
    return;
  }
  const nextIndex = nextSequentialIndex(rt.reminder, rt.index);
  if (nextIndex < 0) {
    // 序列已结束（loop=0 跑完一轮）→ 停止
    rt.stopped = true;
    broadcastSync({
      reminderId: id,
      stopped: true,
      stateKey: rt.reminder.states[rt.index]?.key,
      stateLabel: rt.reminder.states[rt.index]?.label,
    });
    return;
  }
  emitStatefulEnter(id, nextIndex);
}

// 强制切换多状态提醒到指定状态（如快捷键强制回到工作）
function forceReminderState(reminderId: string, stateKey: string): void {
  const rt = statefulRT[reminderId];
  if (!rt) return;
  const idx = rt.reminder.states.findIndex((s: any) => s.key === stateKey);
  if (idx < 0) return;
  rt.injected = undefined;
  rt.stopped = false;
  rt.index = idx;
  rt.startedAt = Date.now();
  const gap = Number(rt.reminder.states[idx].duration) * Number(rt.reminder.states[idx].unit);
  rt.nextTime = gap > 0 ? rt.startedAt + gap : null;
  emitStatefulEnter(reminderId, idx, true); // 用户手动强制切状态，绕过空闲免打扰
}

// 运行时强制插入一个非序列状态（如强制锁屏）
function injectStatefulState(reminderId: string, stateKey: string): void {
  const rt = statefulRT[reminderId];
  if (!rt) return;
  const idx = rt.reminder.states.findIndex((s: any) => s.key === stateKey);
  if (idx < 0) return;
  const state = rt.reminder.states[idx];
  if (isSeq(state)) return; // 只有非序列状态可被注入
  rt.injected = { state, resumeIndex: rt.index };
  rt.startedAt = Date.now();
  const gap = Number(state.duration) * Number(state.unit);
  rt.nextTime = gap > 0 ? rt.startedAt + gap : null;
  emitStatefulEvent(reminderId, idx, true, rt.nextTime, true); // 用户手动注入，绕过空闲免打扰
  // 有确定时长（非永久）的注入态：到点自动归位
  if (gap > 0) {
    if (timers[reminderId]) {
      clearTimeout(timers[reminderId]);
      delete timers[reminderId];
    }
    timers[reminderId] = setTimeout(() => advanceStateful(reminderId), gap);
  }
}

// 手动解除被注入的非序列状态：按 continueLoop 决定归位序列或开新一轮
function endInjectedState(reminderId: string): void {
  const rt = statefulRT[reminderId];
  if (!rt || !rt.injected) return;
  const injectedState = rt.injected.state;
  const continueLoop = Number(injectedState.continueLoop) === 1;
  const resumeIndex = rt.injected.resumeIndex;
  rt.injected = undefined;
  rt.stopped = false;

  if (continueLoop) {
    // 继续之前未完成的循环
    rt.index = resumeIndex;
    rt.startedAt = Date.now();
    const gap = Number(rt.reminder.states[resumeIndex].duration) * Number(rt.reminder.states[resumeIndex].unit);
    rt.nextTime = gap > 0 ? rt.startedAt + gap : null;
    emitStatefulEnter(reminderId, resumeIndex, true); // 用户手动解锁，绕过空闲免打扰
  } else {
    // 开始新循环（锁屏解锁后的默认行为）
    const seqIdx = sequentialIndices(rt.reminder);
    const firstIdx = seqIdx[0];
    rt.cycleStart = Date.now();
    rt.reminder.startTime = rt.cycleStart;
    persistReminder(rt.reminder).catch((e) => console.error("persistStartTime 失败:", e));
    sendStarttimeUpdated(reminderId, rt.cycleStart);
    rt.index = firstIdx;
    rt.startedAt = Date.now();
    const gap = Number(rt.reminder.states[firstIdx].duration) * Number(rt.reminder.states[firstIdx].unit);
    rt.nextTime = gap > 0 ? rt.startedAt + gap : null;
    emitStatefulEnter(reminderId, firstIdx, true); // 用户手动解锁，绕过空闲免打扰
  }
}

// 暴露当前多状态提醒的运行态状态（兼容注入态），供主进程隐藏逻辑判断
export function getStatefulCurrentState(reminderId = "pomodoro"): { key: string; lockScreen: number } | null {
  const rt = statefulRT[reminderId];
  if (!rt || !rt.reminder) return null;
  const state = rt.injected ? rt.injected.state : rt.reminder.states?.[rt.index];
  if (!state) return null;
  return { key: state.key, lockScreen: Number(state.lockScreen) };
}

// 重新开始多状态提醒的一轮轮次：回到首个序列状态并重置 cycleStart/startTime，
// 复用现有「开始新的一轮」逻辑（与锁屏解锁后默认行为一致），不产生重复定时器。
export function restartStatefulRound(reminderId = "pomodoro"): void {
  const rt = statefulRT[reminderId];
  if (!rt || !rt.reminder) return;
  rt.injected = undefined;
  rt.stopped = false;
  const seqIdx = sequentialIndices(rt.reminder);
  if (!seqIdx.length) return;
  const firstIdx = seqIdx[0];
  rt.cycleStart = Date.now();
  rt.reminder.startTime = rt.cycleStart;
  persistReminder(rt.reminder).catch((e) => console.error("persistStartTime 失败:", e));
  sendStarttimeUpdated(reminderId, rt.cycleStart);
  rt.index = firstIdx;
  rt.startedAt = Date.now();
  const gap = Number(rt.reminder.states[firstIdx].duration) * Number(rt.reminder.states[firstIdx].unit);
  rt.nextTime = gap > 0 ? rt.startedAt + gap : null;
  emitStatefulEnter(reminderId, firstIdx, true); // 空闲结束/手动重开：绕过空闲免打扰，立即进入首状态
}

// 渲染端请求当前状态（补偿启动竞态）
// 注意：本函数属于「查询/补偿当前状态」，不是状态流转，严禁调用
// applyStateWindowBehavior —— 否则渲染端初始化（如从 home 跳到设置页）拉取状态时会
// 误把应用置顶锁定或隐藏，与用户预期（lockScreen 仅在状态自动切换时生效）相悖。
function requestTipsState(reminderId?: string): void {
  const now = Date.now();
  if (reminderId && statefulRT[reminderId]) {
    const rt = statefulRT[reminderId];
    // 运行时存在但已关闭：取消执行，避免残留 disabled 运行时被续命
    if (!rt.reminder || !rt.reminder.enabled) {
      stopReminder(reminderId);
      return;
    }
    realignStatefulRuntime(rt, now);
    rescheduleStatefulAdvance(reminderId);
    emitCurrentStateful(reminderId);
    return;
  }
  if (reminderId) {
    // 运行时尚未建好：若该提醒已启用则启动
    loadOne(reminderId).then((r) => {
      if (r && r.enabled && r.mode === "stateful") startStatefulReminder(r);
    });
    return;
  }
  // 未指定 id：补偿全部
  let has = false;
  for (const id in statefulRT) {
    const rt = statefulRT[id];
    // 已关闭的运行时不再续命（防御性，正常路径下 disabled 运行时已被 stopReminder 移除）
    if (!rt.reminder || !rt.reminder.enabled) {
      stopReminder(id);
      continue;
    }
    has = true;
    realignStatefulRuntime(rt, now);
    rescheduleStatefulAdvance(id);
    emitCurrentStateful(id);
  }
  if (!has) pendingStateRequest = true;
}

// ============================ IPC ============================

function registerIpc(): void {
  // 渲染端初始化读取全部提醒
  ipcMain.handle("get-tips", async () => {
    const all = await loadAll();
    // 过滤引擎托管的待办截止提醒（source='todo'），避免污染用户提醒列表
    return (all || []).filter((r: any) => r.source !== "todo");
  });

  // 渲染端新增/编辑/切换启用：落库 + 重排程
  ipcMain.handle("tips-save", async (_e, reminder: any) => {
    const r = parse(reminder);
    const existing = await loadOne(r.id);
    // 编辑场景：若未提供开始时间，沿用库中原有值，避免误判为新轮次
    if (!(r.startTime && !isNaN(Number(r.startTime)))) {
      if (existing && existing.startTime && !isNaN(Number(existing.startTime))) {
        r.startTime = existing.startTime;
      }
    }
    // 多状态：states 绝不可能是空数组（至少含工作/休息等序列状态）。
    // 若解析后为空，说明传入数据异常（如序列化丢失）——记录错误，并仅在库中存在
    // 有效 states 时兜底沿用，防止把内置番茄钟覆盖成 [] 导致轮次停滞；
    // 若无任何有效来源则直接拒绝保存并返回错误，避免静默吞掉异常。
    if (r.mode === "stateful" && (!Array.isArray(r.states) || r.states.length === 0)) {
      console.error("[tips-save] 多状态提醒 states 为空数组，这不应发生：", { id: r.id });
      if (existing && Array.isArray(existing.states) && existing.states.length > 0) {
        r.states = existing.states; // 防御性兜底：沿用库里有效配置
      } else {
        return { ok: false, error: "states 为空，保存被拒绝（数据异常）" };
      }
    }
    // 系统内置番茄钟（id=pomodoro）保护：内置状态 work/rest/lock 不可被删除。
    // 若传入的 states 缺少任一内置状态，从种子配置补回（保留用户自定义状态及已有配置），
    // 防止渲染端漏拦的「删内置状态」请求落库后破坏核心番茄钟流程。
    if (r.id === "pomodoro" && Array.isArray(r.states)) {
      const seed = makePomodoroSeed();
      const haveKeys = new Set(r.states.map((s: any) => s && s.key));
      const missing = seed.states.filter((s: any) => !haveKeys.has(s.key));
      if (missing.length > 0) {
        console.warn("[tips-save] 番茄钟缺少内置状态，已从种子补回：", missing.map((s: any) => s.key));
        r.states = [...missing, ...r.states];
      }
    }
    await persistReminder(r);
    scheduleReminder(r);
    return { ok: true };
  });

  // 渲染端删除
  ipcMain.on("tips-delete", (_e, id: string) => {
    stopReminder(id);
    sqlDel({ tableName: TABLE, condition: { id } });
  });

  // 强制切换状态
  ipcMain.on("tips-force-state", (_e, { reminderId, stateKey }: { reminderId: string; stateKey: string }) => {
    forceReminderState(reminderId, stateKey);
  });

  // 注入非序列状态
  ipcMain.on("tips-inject-state", (_e, { reminderId, stateKey }: { reminderId: string; stateKey: string }) => {
    injectStatefulState(reminderId, stateKey);
  });

  // 解除注入态
  ipcMain.on("tips-end-injected-state", (_e, { reminderId }: { reminderId: string }) => {
    endInjectedState(reminderId);
  });

  // 请求当前状态补偿
  ipcMain.on("request-tips-state", (_e, arg?: { reminderId?: string }) => {
    requestTipsState(arg?.reminderId);
  });

  // 全量重排程（如批量变更后）
  ipcMain.on("tips-reload", () => {
    scheduleAll();
  });

  // 待办新增/编辑/删除/完成切换后，渲染端发 update-todo-reminders 触发截止提醒重排
  // （保持渲染端零改动：沿用旧 IPC 名，此处转调引擎的 syncTodoReminders 全量同步）
  ipcMain.on("update-todo-reminders", () => {
    syncTodoReminders();
  });
}

// ============================ 启动 ============================

export async function initNewReminder(): Promise<void> {
  await repairRemindersSchema();
  // 确保 reminders 表以 TEXT 主键存在（先于任何 query/upsert，避免被默认 INTEGER 主键重建）
  await ensureTableExists(TABLE, undefined, "id", { primaryKeyType: "TEXT" });
  await seedPomodoro();
  await scheduleAll();
  // 启动时把待办截止提醒接入引擎（替代旧 job.ts restoreTodoReminders）
  await syncTodoReminders();
  registerIpc();
  // 若启动前渲染端已请求过状态（极端竞态），补发首帧
  if (pendingStateRequest) {
    pendingStateRequest = false;
    requestTipsState();
  }
}

/**
 * 重复任务引擎（主进程）
 * - 在应用启动与每日 00:00 扫描 todo_list 中的「重复模板」，按「天」懒生成实例（只生成当天的，不预生成未来）
 * - 每次保存重复待办后，渲染端发送 recurrence:sync 立即生成当天实例
 * - 生成完成后调用 newReminder 的 syncTodoReminders 重新排程截止提醒
 *
 * 数据模型：模板行 recurrenceRule 非空且 recurrenceId 为空；实例行 recurrenceId=模板key、isRecurrenceInstance=1
 * 读取/写入均走 newSql 的 query/upsert（不使用危险通道）。
 */
import { ipcMain } from 'electron';
import { CronJob } from 'cron';
import moment from 'moment';
import { randomUUID } from 'crypto';
import { query, upsert } from './newSql.ts';
import { syncTodoReminders } from './newReminder.ts';

/** 向前预生成多少天（已废弃：改为「按天懒生成」，每次只生成当天实例，由每日 00:00 定时任务补次日） */

interface RawTodo {
  key: string;
  title: string;
  description: string;
  tags: string;
  priority: string;
  dueDate: string;
  deadlineReminder: number;
  remindCount: number;
  remindInterval: number;
  remindIntervalUnit: string;
  recurrenceRule: string;
  recurrenceInterval: number;
  recurrenceWeekdays: string | null;
  recurrenceEnd: string | null;
  createTime: string;
}

/** 取所有重复模板（recurrenceRule 非空且非实例） */
async function getTemplates(): Promise<RawTodo[]> {
  const rows = await query({
    tableName: 'todo_list',
    SqlStr:
      "SELECT * FROM todo_list WHERE recurrenceRule IN ('daily','weekly') AND (recurrenceId IS NULL OR recurrenceId = '')",
  });
  return (rows || []) as RawTodo[];
}

/** 取某模板已有的实例（按 recurrenceId） */
async function getInstances(templateKey: string): Promise<string[]> {
  const rows = await query({
    tableName: 'todo_list',
    SqlStr: `SELECT dueDate FROM todo_list WHERE recurrenceId = '${templateKey}'`,
  });
  return ((rows || []) as { dueDate: string }[]).map((r) => (r.dueDate || '').slice(0, 10));
}

/** 计算模板锚点（用于推算周期）：优先 dueDate 的日期，回退 createTime 日期 */
function anchorDate(t: RawTodo): moment.Moment {
  const base = t.dueDate || t.createTime;
  if (base) {
    const m = moment(base, 'YYYY-MM-DD HH:mm:ss');
    if (m.isValid()) return m;
  }
  return moment();
}

/** 取锚点的时分秒（无则默认 09:00:00） */
function timeOfDay(t: RawTodo): string {
  if (t.dueDate && moment(t.dueDate, 'YYYY-MM-DD HH:mm:ss').isValid()) {
    return moment(t.dueDate).format('HH:mm:ss');
  }
  return '09:00:00';
}

/**
 * 按「天」懒生成：只生成「今天」当天应存在的实例（已存在的按日期去重跳过）
 * 不预生成未来——未来某天的实例交由每日 00:00 的定时任务在其当天开始(00:00)时生成，
 * 避免一次性刷出大量实例。
 */
async function generateForTemplate(t: RawTodo) {
  const anchor = anchorDate(t);
  const tod = timeOfDay(t);
  const interval = Math.max(1, Number(t.recurrenceInterval) || 1);
  const end = moment().endOf('day');
  const endStr = t.recurrenceEnd ? moment(t.recurrenceEnd, 'YYYY-MM-DD').format('YYYY-MM-DD') : null;
  const start = moment().startOf('day');

  let weekdays: number[] = [];
  if (t.recurrenceRule === 'weekly') {
    try {
      weekdays = (JSON.parse(t.recurrenceWeekdays || '[]') as number[]).filter((n) => n >= 0 && n <= 6);
    } catch {
      weekdays = [];
    }
    if (!weekdays.length) weekdays = [anchor.day()];
  }

  const existingDays = new Set(await getInstances(t.key));
  const toCreate: moment.Moment[] = [];

  for (let d = start.clone(); d.isSameOrBefore(end); d.add(1, 'day')) {
    const daysDiff = d.diff(anchor, 'days');
    let hit = false;
    if (t.recurrenceRule === 'daily') {
      hit = daysDiff >= 0 && daysDiff % interval === 0;
    } else if (t.recurrenceRule === 'weekly') {
      // 仅当落在目标星期，且距锚点周数为间隔整数倍时生成
      if (!weekdays.includes(d.day())) continue;
      const wdiff = Math.floor(Math.abs(d.diff(anchor, 'days')) / 7);
      hit = wdiff % interval === 0;
    }
    if (!hit) continue;

    const dayStr = d.format('YYYY-MM-DD');
    if (endStr && dayStr > endStr) break;
    if (existingDays.has(dayStr)) continue;
    toCreate.push(d.clone());
  }

  for (const occ of toCreate) {
    const due = `${occ.format('YYYY-MM-DD')} ${tod}`;
    const instance = {
      key: randomUUID(),
      title: t.title,
      description: t.description || '',
      tags: t.tags || '[]',
      completed: 0,
      completedTime: '',
      priority: t.priority || 'medium',
      dueDate: due,
      status: 'not_started',
      deadlineReminder: Number(t.deadlineReminder) || 0,
      remindCount: Number(t.remindCount) || 1,
      remindInterval: Number(t.remindInterval) || 30,
      remindIntervalUnit: t.remindIntervalUnit === 'hour' ? 'hour' : 'minute',
      createTime: moment().format('YYYY-MM-DD HH:mm:ss'),
      updateTime: moment().format('YYYY-MM-DD HH:mm:ss'),
      parentIds: null,
      sortOrder: 0,
      recurrenceRule: t.recurrenceRule,
      recurrenceInterval: interval,
      recurrenceWeekdays: t.recurrenceWeekdays || null,
      recurrenceEnd: t.recurrenceEnd || null,
      recurrenceId: t.key,
      isRecurrenceInstance: 1,
    };
    await upsert({ tableName: 'todo_list', data: instance, config: { primaryKey: 'key' } });
  }
}

/** 全量补生成所有模板「当天」的实例，并刷新提醒排程 */
export async function generateRecurrenceInstances() {
  try {
    const templates = await getTemplates();
    for (const t of templates) {
      await generateForTemplate(t);
    }
    syncTodoReminders();
  } catch (e) {
    console.error('[recurrence] 生成实例失败:', e);
  }
}

export function initRecurrence() {
  // 启动时仅补生成「当天」实例
  generateRecurrenceInstances();

  // 渲染端保存重复待办后触发即时补生成
  ipcMain.on('recurrence:sync', () => {
    generateRecurrenceInstances();
  });

  // 每日 00:00 补生成未来实例
  try {
    new CronJob(
      '0 0 0 * * *',
      () => generateRecurrenceInstances(),
      null,
      true,
      'Asia/Shanghai',
    );
  } catch (e) {
    console.error('[recurrence] 定时任务注册失败:', e);
  }
}

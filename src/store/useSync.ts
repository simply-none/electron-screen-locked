/**
 * 局域网同步 store（Pinia setup 风格）
 *
 * 职责：设备列表 / 表选择 / 同步日志 的状态收敛与动作封装；
 * 页面与组件只消费 store，不直接触碰 IPC（数据层在 views/sync/api）。
 */
import { defineStore } from "pinia";
import { ref } from "vue";

import { syncApi } from "@/views/sync/api/syncApi";
import type { SyncLogItem, SyncPeerDevice, SyncStatus, SyncTableResult } from "@/views/sync/types";

/** 可同步表白名单（与主进程 SYNCABLE_TABLES 保持一致） */
export const SYNC_TABLES = [
  "habit_def",
  "habit_checkin",
  "todo_list",
  "todo_tags",
  "note_book",
  "basic_info",
  "countdown",
  "qr_history",
  "qr_template",
  // 主题对话三表（INTEGER 自增 id 主键，主进程按 tablePk 适配）
  "conversation_theme",
  "conversation",
  "conversation_tag",
] as const;

export const useSync = defineStore("sync", () => {
  /** 本机服务状态 */
  const status = ref<SyncStatus | null>(null);
  /** 已知对端（扫描结果 + 手动添加），按 ip 去重 */
  const peers = ref<SyncPeerDevice[]>([]);
  /** 各表勾选状态（默认全选） */
  const selectedTables = ref<Record<string, boolean>>(
    Object.fromEntries(SYNC_TABLES.map((t) => [t, true])),
  );
  /** 同步日志（新→旧） */
  const logs = ref<SyncLogItem[]>([]);
  const scanning = ref(false);
  const busy = ref(false);

  function log(msg: string, level: SyncLogItem["level"] = "info") {
    const time = new Date().toTimeString().slice(0, 8);
    logs.value.unshift({ time, msg, level });
    if (logs.value.length > 50) logs.value.pop();
  }

  /** 拉取本机状态（页面挂载时调用） */
  async function loadStatus() {
    try {
      const res = await syncApi.status();
      if (res.success && res.data) status.value = res.data;
    } catch (e) {
      log(`读取同步服务状态失败：${e}`, "error");
    }
  }

  /** UDP 广播扫描局域网对端 */
  async function scan() {
    scanning.value = true;
    try {
      const res = await syncApi.scan();
      if (res.success && res.data) {
        // 保留手动添加的设备（platform === '-'），合并扫描结果
        const manual = peers.value.filter((p) => p.platform === "-");
        const merged = new Map<string, SyncPeerDevice>();
        for (const p of [...manual, ...res.data]) merged.set(p.ip, p);
        peers.value = [...merged.values()];
        log(`扫描到 ${res.data.length} 台设备`);
      }
    } catch (e) {
      log(`扫描失败：${e}`, "error");
    } finally {
      scanning.value = false;
    }
  }

  /** 手动添加设备（模拟器等广播不可达场景） */
  function addManual(ip: string) {
    const clean = ip.trim();
    if (!clean || peers.value.some((p) => p.ip === clean)) return;
    peers.value.push({ ip: clean, name: "手动添加", id: clean, platform: "-" });
    log(`已添加设备 ${clean}`);
  }

  /** 勾选中的表名列表 */
  function checkedTables(): string[] {
    return SYNC_TABLES.filter((t) => selectedTables.value[t]);
  }

  /** 执行单表结果 → 日志 */
  function logResults(results: SyncTableResult[], verb: string) {
    for (const r of results) {
      log(
        r.ok
          ? `${verb} ${r.table}：${r.count} 行`
          : `${verb} ${r.table} 失败：${r.error ?? "未知错误"}`,
        r.ok ? "ok" : "error",
      );
    }
  }

  /** 推送选中表到指定对端 */
  async function push(peerIp: string) {
    const tables = checkedTables();
    if (!tables.length) return log("未勾选任何表", "error");
    busy.value = true;
    try {
      const res = await syncApi.push(peerIp, tables);
      if (res.success && res.data) logResults(res.data, "推送");
    } catch (e) {
      log(`推送失败：${e}`, "error");
    } finally {
      busy.value = false;
    }
  }

  /** 从指定对端拉取选中表 */
  async function pull(peerIp: string) {
    const tables = checkedTables();
    if (!tables.length) return log("未勾选任何表", "error");
    busy.value = true;
    try {
      const res = await syncApi.pull(peerIp, tables);
      if (res.success && res.data) logResults(res.data, "拉取");
    } catch (e) {
      log(`拉取失败：${e}`, "error");
    } finally {
      busy.value = false;
    }
  }

  return {
    status,
    peers,
    selectedTables,
    logs,
    scanning,
    busy,
    log,
    loadStatus,
    scan,
    addManual,
    push,
    pull,
  };
});

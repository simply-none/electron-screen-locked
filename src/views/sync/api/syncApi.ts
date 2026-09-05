/**
 * 局域网同步数据层（功能化）：封装与主进程 sync 模块的 IPC 通信。
 *
 * 通道清单（主进程 electron/main/module/sync/syncModule.ts 注册）：
 * - `sync:status` → 本机服务状态（设备名/端口）
 * - `sync:scan`   → UDP 广播扫描局域网对端（3 秒窗口）
 * - `sync:push`   → 推送选中表到对端（读本地 → POST 对端 /sync）
 * - `sync:pull`   → 从对端拉取选中表（GET 对端 /export → 幂等 upsert 本地）
 */

import type { SyncPeerDevice, SyncStatus, SyncTableResult } from "../types";

interface IpcResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

/** 统一经 preload 的 handlePromise 与主进程交互（args 必传，preload 类型签名如此） */
function invoke<T = unknown>(channel: string, args: Record<string, unknown> = {}): Promise<IpcResult<T>> {
  return window.ipcRenderer.handlePromise(channel, args);
}

export const syncApi = {
  /** 本机同步服务状态 */
  status: () => invoke<SyncStatus>("sync:status"),

  /** 扫描局域网对端 */
  scan: () => invoke<SyncPeerDevice[]>("sync:scan"),

  /** 推送选中表到指定对端 */
  push: (peerIp: string, tables: string[]) =>
    invoke<SyncTableResult[]>("sync:push", { peerIp, tables }),

  /** 从指定对端拉取选中表 */
  pull: (peerIp: string, tables: string[]) =>
    invoke<SyncTableResult[]>("sync:pull", { peerIp, tables }),
};

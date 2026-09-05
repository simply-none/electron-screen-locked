/**
 * 局域网同步模块公共类型（渲染端）
 *
 * 与主进程 syncModule.ts 的 SyncPeer / SyncTableResult 同构；
 * 协议细节见 electron/main/module/sync/syncModule.ts 头注释。
 */

/** 局域网对端设备 */
export interface SyncPeerDevice {
  ip: string;
  name: string;
  id: string;
  platform: string;
}

/** 单表同步结果 */
export interface SyncTableResult {
  table: string;
  ok: boolean;
  count: number;
  error?: string;
}

/** 本机同步服务状态 */
export interface SyncStatus {
  name: string;
  id: string;
  platform: string;
  discoveryPort: number;
  dataPort: number;
}

/** 同步日志条目 */
export interface SyncLogItem {
  time: string;
  msg: string;
  /** ok=成功 error=失败 info=普通 */
  level: "ok" | "error" | "info";
}

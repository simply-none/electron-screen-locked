/**
 * 文件互传模块公共类型（渲染端）
 *
 * 与主进程 transferModule.ts 的字段同构；协议细节见
 * electron/main/module/transfer/transferModule.ts 头注释。
 */

/** 局域网对端设备（复用 sync 的发现结果） */
export interface TransferPeerDevice {
  ip: string;
  name: string;
  id: string;
  platform: string;
}

/** 发送进度快照（主进程 file-transfer:progress 事件载荷） */
export interface TransferProgress {
  tid: string;
  fid: string;
  name: string;
  sent: number;
  total: number;
  /** data=传输中 done=单文件完成 failed=失败 canceled=已取消 */
  phase: "data" | "done" | "failed" | "canceled";
}

/** 本地已选待发文件（渲染端维护，size 由主进程在发送时回传） */
export interface LocalFileItem {
  path: string;
  name: string;
  size: number;
}

/** 文件互传历史记录（与 file_transfer 表逐列对齐） */
export interface TransferHistoryItem {
  key: string;
  tid: string;
  fid: string;
  direction: "send" | "receive";
  peer_name: string;
  peer_ip: string;
  file_name: string;
  size: number;
  mime: string | null;
  path: string;
  status: "done" | "failed" | "canceled";
  /** 失败原因（size mismatch / hash mismatch / 连接拒绝等），成功或取消时为空 */
  error?: string | null;
  created_at: string;
}

/** 本机文件互传服务状态 */
export interface TransferStatus {
  name: string;
  id: string;
  platform: string;
  receiveDir: string;
  autoAccept: boolean;
  /** 重名策略：rename=追加 (n) / overwrite=覆盖 */
  rename: "rename" | "overwrite";
  /** 传输加密开关 */
  enc: boolean;
  /** 已记忆的最近设备数量 */
  recentCount: number;
}

/** 最近设备（持久化，离线也显示） */
export interface RecentPeer {
  ip: string;
  name: string;
  id: string;
  platform: string;
  lastSeen: number;
}

/** 发送结果（transfer:send 返回） */
export interface TransferSendResult {
  ok: boolean;
  okCount: number;
  failCount: number;
  /** 是否被用户取消 */
  canceled: boolean;
  /** 批次号（取消时用；发送中也会经 file-transfer:progress 事件带出） */
  tid: string;
  message: string;
}

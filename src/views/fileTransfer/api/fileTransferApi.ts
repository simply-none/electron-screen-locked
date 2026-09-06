/**
 * 文件互传数据层（功能化）：封装与主进程 transferModule 的 IPC 通信。
 *
 * 通道清单（主进程 electron/main/module/transfer/transferModule.ts 注册）：
 * - transfer:status         → 本机信息 / 接收目录 / 自动接收开关
 * - transfer:scan           → 复用 sync 的 UDP 广播扫描
 * - transfer:pick-files     → 系统「选文件」对话框（仅文件，可多选）
 * - transfer:pick-folders   → 系统「选文件夹」对话框（仅文件夹，可多选）
 *   （Windows 原生对话框无法同时选文件+文件夹，故拆成两个；二者返回结构一致）
 * - transfer:send           → {peerIp, filePaths[]} 触发批量发送（流式 + 进度事件）
 * - transfer:cancel         → {tid} 取消正在发送的批次（中止流式上传，记 canceled）
 * - transfer:history        → 历史记录（created_at 倒序）
 * - transfer:open-received  → 在资源管理器打开接收目录
 * - transfer:open-file       → 按系统关联程序打开指定历史文件
 * - transfer:open-folder     → 在资源管理器定位（显示所在文件夹并选中）指定文件
 * - transfer:set-auto-accept → 持久化自动接收开关
 */

import type {
  TransferPeerDevice,
  TransferStatus,
  TransferHistoryItem,
  TransferSendResult,
  RecentPeer,
  SelectedEntry,
} from "../types";

interface IpcResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

/** 统一经 preload 的 handlePromise 与主进程交互（args 必传，preload 类型签名如此） */
function invoke<T = unknown>(channel: string, args: Record<string, unknown> = {}): Promise<IpcResult<T>> {
  return window.ipcRenderer.handlePromise(channel, args);
}

export const fileTransferApi = {
  /** 本机文件互传服务状态 */
  status: () => invoke<TransferStatus>("transfer:status"),

  /** 扫描局域网对端（复用 sync 发现） */
  scan: () => invoke<TransferPeerDevice[]>("transfer:scan"),

  /** 系统「选文件」对话框（仅文件，可多选）→ 返回原始选择项 */
  pickFiles: () => invoke<SelectedEntry[]>("transfer:pick-files"),

  /** 系统「选文件夹」对话框（仅文件夹，可多选）→ 返回原始选择项 */
  pickFolders: () => invoke<SelectedEntry[]>("transfer:pick-folders"),

  /** 批量发送：触发后主进程经 file-transfer:progress/received/batch-done 推事件 */
  send: (peerIp: string, filePaths: string[]) =>
    invoke<TransferSendResult>("transfer:send", { peerIp, filePaths }),

  /**
   * 取消正在发送的批次（tid 由 file-transfer:progress 事件带出）。
   * transfer:send 的 handle 要等整批结束才返回，所以取消只能靠事件拿到的 tid 发起。
   */
  cancel: (tid: string) => invoke<{ success: boolean }>("transfer:cancel", { tid }),

  /** 历史记录（created_at 倒序，支持分页） */
  history: (limit?: number, offset?: number) =>
    invoke<{ data: TransferHistoryItem[]; total: number }>("transfer:history", {
      limit: limit ?? 200,
      offset: offset ?? 0,
    }),

  /** 在资源管理器打开接收目录 */
  openReceived: () => invoke<unknown>("transfer:open-received"),

  /** 按系统关联程序打开指定历史文件 */
  openFile: (path: string) => invoke<unknown>("transfer:open-file", { path }),

  /** 在资源管理器定位（显示所在文件夹并选中）指定文件 */
  openFolder: (path: string) => invoke<unknown>("transfer:open-folder", { path }),

  /** 持久化自动接收开关 */
  setAutoAccept: (value: boolean) =>
    invoke<{ autoAccept: boolean }>("transfer:set-auto-accept", { value }),

  /** 持久化重名策略 */
  setRename: (value: "rename" | "overwrite") =>
    invoke<{ rename: "rename" | "overwrite" }>("transfer:set-rename", { value }),

  /** 持久化传输加密开关 */
  setEnc: (value: boolean) =>
    invoke<{ enc: boolean }>("transfer:set-enc", { value }),

  /** 读取最近设备（#11） */
  recentPeers: () => invoke<RecentPeer[]>("transfer:recent-peers"),

  /** 忘记某最近设备 */
  forgetPeer: (ip: string) => invoke<unknown>("transfer:forget-peer", { ip }),

  /** 询问模式（#15）：答复是否接收 */
  answerOffer: (tid: string, accept: boolean) =>
    invoke<unknown>("transfer:answer-offer", { tid, accept }),
};

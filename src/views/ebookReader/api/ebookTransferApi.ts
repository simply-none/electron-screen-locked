/**
 * 电子书跨端传书数据层（PC ↔ 手机），封装与主进程 ebookTransfer 模块的 IPC 通信。
 *
 * 通道清单（主进程 electron/main/module/ebookTransfer.ts 注册）：
 * - `ebook:transfer-scan`     → UDP 广播扫描局域网对端（复用 sync 的发现协议）
 * - `ebook:transfer-list`     → 拉取对端（手机）书架上真实存在的 epub/txt
 * - `ebook:transfer-download` → 批量从对端下载并落库（按 content_hash 去重）
 * - `ebook:transfer-upload`   → 批量把本机书推送给对端
 *
 * 与移动端 `lib/features/ebook/services/ebook_transfer.dart` 对称，共用 47124 数据面的
 * /ebook/list、/ebook/download、/ebook/upload 三个端点，身份键均为内容 sha256。
 */

/** 局域网对端设备（与 sync 的 SyncPeer 一致） */
export interface TransferPeer {
  ip: string;
  name: string;
  id: string;
  platform: string;
}

/** 对端书目条目（与移动端 RemoteBook 字段一致） */
export interface RemoteEbook {
  filePath: string;
  name: string;
  format: string;
  title: string;
  size: number;
  contentHash: string;
}

/** 单本传输结果 */
export interface TransferOneResult {
  ok: boolean;
  title: string;
  error?: string;
  deduped?: boolean;
}

/** 本机待上传的书（传 filePath + 元信息即可，主进程会校验文件存在性） */
export interface LocalEbookPick {
  filePath: string;
  name?: string;
  title?: string;
  format?: string;
}

interface IpcResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

/** 统一经 preload 的 handlePromise 与主进程交互（args 必传，preload 类型签名如此） */
function invoke<T = unknown>(
  channel: string,
  args: Record<string, unknown> = {},
): Promise<IpcResult<T>> {
  return window.ipcRenderer.handlePromise(channel, args);
}

export const ebookTransferApi = {
  /** 扫描局域网对端 */
  scan: () => invoke<TransferPeer[]>('ebook:transfer-scan'),

  /** 拉取对端书目 */
  listRemote: (peerIp: string) =>
    invoke<RemoteEbook[]>('ebook:transfer-list', { peerIp }),

  /** 批量从对端下载 */
  download: (peerIp: string, books: RemoteEbook[]) =>
    invoke<TransferOneResult[]>('ebook:transfer-download', { peerIp, books }),

  /** 批量推送到对端 */
  upload: (peerIp: string, books: LocalEbookPick[]) =>
    invoke<TransferOneResult[]>('ebook:transfer-upload', { peerIp, books }),
};

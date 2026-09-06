/**
 * 文件互传模块（PC 端）—— 与 Flutter 移动端 feature/file_transfer 同协议
 * ----------------------------------------------------------------------------
 * 复用 syncModule 的 47124 数据面（经 registerDataRoute 注入 /file/*，不新开端口）：
 *   POST /file/offer  → 发→收：JSON {tid, from, files:[{fid,name,size,mime?}], enc?}
 *   POST /file/data   → 发→收：原始字节流（带 Content-Length，流式不落内存）
 *                       ?from=N 续传（从字节 N 起，接收端追加写）
 *   POST /file/end    → 发→收：.part 改名去重 + 写历史 + 推接收事件
 * 发送端（PC → 手机）：transfer:send 串行 offer→data→end，按字节回调节度进度。
 * 取消/并发/询问/磁盘/续传/加密均在此模块内闭环。
 *
 * 已实现的增强（2026-09-06 之后）：
 *   #9  重名策略：store._transfer_rename = 'rename'(默认) | 'overwrite'
 *   #11 最近设备：扫描到的对端持久化到 store._transfer_recent（离线也显示）
 *   #13 断点续传：offer 响应带回各文件已收 .part 偏移；data 支持 from= 追加写
 *   #14 会话加密（默认关）：offer 协商 AES-256-CTR 会话密钥，data 字节流加密传输
 *   #15 接收端询问模式：关「自动接收」时不再直接拒绝，emit 事件等渲染端答复
 *   #16 磁盘预估：接收前按 offer 总大小 vs 接收目录剩余空间，不足直接拒
 *   #17 并发守卫：同一时刻仅一个收发批次，其余被拒
 *   #20 历史分页/清理：transfer:history 支持 limit/offset；超阈值自动清理最旧
 *
 * 接收目录：<fileCachePath>/文件互传/（回退 documents）。
 * 事件（webContents.send，渲染端经 preload 的 on 监听）：
 *   file-transfer:progress  {tid,fid,name,sent,total,phase}
 *   file-transfer:received  {name,path,size,from}
 *   file-transfer:batch-done {tid,ok,fail,canceled}
 *   file-transfer:incoming-ask {tid,name,count,total}  ← 询问模式
 *
 * ⚠️ 改本文件必须重启 Electron。
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { Transform, Readable } from "node:stream";
import { app, dialog, ipcMain, shell } from "electron";
import { store } from "../store.ts";
import { query, upsert, ensureTableExists, del, count } from "../newSql.ts";
import { registerDataRoute } from "../sync/syncModule.ts";
import { scanPeers, type SyncPeer } from "../sync/syncModule.ts";
import { win } from "../mainWindow.ts";

const DATA_PORT = 47124;

/** 进度回调节流间隔 */
const PROGRESS_THROTTLE_MS = 100;
/** 待收批次（offer）最长存活时间，超时回收并清掉它的 .part */
const OFFER_TTL_MS = 30 * 60 * 1000;
/** 孤立 .part 最长存活时间（取消 / 网络中断残留），超时删除 */
const PART_TTL_MS = 30 * 60 * 1000;
/** 陈旧清理扫描间隔 */
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
/** 历史自动清理阈值（超过则删最旧，保留此数量） */
const MAX_HISTORY_ROWS = 1000;
/** 接收端询问模式超时（毫秒）：超时未答复按拒绝处理 */
const ASK_TIMEOUT_MS = 60_000;

/** 文件互传历史列（与移动端 file_transfer 表逐列对齐） */
const FILE_TRANSFER_COLUMNS = [
  "tid",
  "fid",
  "direction",
  "peer_name",
  "peer_ip",
  "file_name",
  "size",
  "mime",
  "path",
  "status",
  "error",
  "created_at",
];

/** 待收批次里的一个文件 */
interface OfferFile {
  fid: string;
  name: string;
  size: number;
  mime?: string | null;
}

/** 待收批次（一次 offer 一批） */
interface IncomingOffer {
  peerName: string;
  peerIp: string;
  files: Map<string, OfferFile>;
  /** 收到 offer 的时间戳，用于回收长期未完成的批次（含其 .part） */
  createdAt: number;
}

/** 最近设备（持久化到 store，离线也显示） */
interface RecentPeer {
  ip: string;
  name: string;
  id: string;
  platform: string;
  lastSeen: number;
}

/** 自动接收开关（store 持久化，默认开启） */
function autoAcceptEnabled(): boolean {
  const v = store.get("_transfer_auto_accept");
  return v === undefined ? true : !!v;
}

/** 重名策略：rename=追加 (n)（默认） / overwrite=覆盖 */
function renameStrategy(): "rename" | "overwrite" {
  return store.get("_transfer_rename") === "overwrite" ? "overwrite" : "rename";
}

/** 传输加密开关（store 持久化，默认关；跨端细节未充分验证，默认不安全优先） */
function encEnabled(): boolean {
  return !!store.get("_transfer_enc");
}

/** 本机设备信息（与移动端同构） */
function deviceId(): string {
  const host = os.hostname();
  let h = 0;
  for (let i = 0; i < host.length; i++) {
    h = (h * 31 + host.charCodeAt(i)) >>> 0;
  }
  return String(h);
}

function deviceInfo() {
  return { name: os.hostname(), id: deviceId(), platform: "win32-electron" };
}

/** 接收目录：<fileCachePath>/文件互传/，回退 documents */
function receiveDir(): string {
  const base = (store.get("fileCachePath") as string | undefined) || app.getPath("documents");
  const dir = path.join(base, "文件互传");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 接收目录剩余可用空间（字节）；取不到返回 -1（不拦截） */
function freeSpaceBytes(dir: string): number {
  try {
    const s = fs.statfsSync(dir);
    return s.bsize * s.bavail;
  } catch {
    return -1;
  }
}

/** 简单扩展名 → MIME 猜测（协议 mime 可选，v1 尽力而为） */
function guessMime(fileName: string): string | null {
  const ext = path.extname(fileName).toLowerCase();
  const map: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".pdf": "application/pdf",
    ".mp3": "audio/mpeg",
    ".mp4": "video/mp4",
    ".json": "application/json",
    ".zip": "application/zip",
  };
  return map[ext] ?? null;
}

/** 文件名安全化：取 basename + 过滤非法字符 */
function safeName(raw: string): string {
  const base = path.basename(raw);
  const cleaned = base.replace(/[<>:"/\\|?*]/g, "_");
  return cleaned || "未命名文件";
}

/** 重名去重：追加 ` (n)`，保留扩展名 */
function dedupeName(dir: string, raw: string): string {
  const safe = safeName(raw);
  let candidate = safe;
  let n = 1;
  while (fs.existsSync(path.join(dir, candidate))) {
    const ext = path.extname(safe);
    const stem = ext ? safe.slice(0, safe.length - ext.length) : safe;
    candidate = `${stem} (${n})${ext}`;
    n++;
  }
  return candidate;
}

/** 续传 .part 稳定名：以「安全名 + 大小」命名，使同一文件跨批次重试用同一临时文件 */
function recvPartPath(dir: string, name: string, size: number): string {
  return path.join(dir, `.recv-${safeName(name)}-${size}.part`);
}

// ---------------------------------------------------------------------------
// 最近设备（#11）：持久化到 store，离线也能显示
// ---------------------------------------------------------------------------
function loadRecent(): RecentPeer[] {
  try {
    return (store.get("_transfer_recent") as RecentPeer[]) || [];
  } catch {
    return [];
  }
}
function rememberPeers(peers: SyncPeer[]): void {
  const map = new Map(loadRecent().map((p) => [p.id || p.ip, p] as const));
  const now = Date.now();
  for (const p of peers) {
    map.set(p.id || p.ip, {
      ip: p.ip,
      name: p.name,
      id: p.id,
      platform: p.platform,
      lastSeen: now,
    });
  }
  const list = [...map.values()].sort((a, b) => b.lastSeen - a.lastSeen).slice(0, 30);
  store.set("_transfer_recent", list);
}
function forgetPeer(ip: string): void {
  store.set("_transfer_recent", loadRecent().filter((p) => p.ip !== ip));
}

/** 写一条历史（key 自生成 uuid） */
async function insertHistory(row: {
  tid: string;
  fid: string;
  direction: "send" | "receive";
  peerName: string;
  peerIp: string;
  fileName: string;
  size: number;
  mime?: string | null;
  path: string;
  status: "done" | "failed" | "canceled";
  error?: string | null;
}): Promise<void> {
  const createdAt = new Date().toISOString().slice(0, 19).replace("T", " ");
  await upsert({
    tableName: "file_transfer",
    data: {
      key: crypto.randomUUID(),
      tid: row.tid,
      fid: row.fid,
      direction: row.direction,
      peer_name: row.peerName,
      peer_ip: row.peerIp,
      file_name: row.fileName,
      size: row.size,
      mime: row.mime ?? null,
      path: row.path,
      status: row.status,
      error: row.error ?? null,
      created_at: createdAt,
    },
    config: { primaryKey: "key" },
  });
}

/** 历史超阈值自动清理最旧记录（#20） */
async function trimHistory(): Promise<void> {
  try {
    const c = await count("file_transfer");
    if (c <= MAX_HISTORY_ROWS) return;
    const excess = c - MAX_HISTORY_ROWS;
    await del({
      tableName: "file_transfer",
      condition: {
        SqlStr: `key IN (SELECT key FROM file_transfer ORDER BY created_at ASC LIMIT ${excess})`,
      },
    } as never);
  } catch (e) {
    console.warn("[transfer] trim history failed:", e);
  }
}

/** 主进程 → 渲染端事件（仅 progress/received/batch-done/incoming-ask 四类，前缀 file-transfer:） */
function emit(channel: string, payload: unknown): void {
  try {
    win?.webContents.send(channel, payload);
  } catch {
    /* 渲染端未就绪时静默 */
  }
}

// ---------------------------------------------------------------------------
// 接收端：/file/* 三端点
// ---------------------------------------------------------------------------

const incoming = new Map<string, IncomingOffer>();
/** 收端逐文件接收到的 sha256（tid|fid → hex），handleEnd 比对发送端在 /file/end 带来的 hash */
const incomingHashes = new Map<string, string>();
/** 并发守卫：同一时刻仅一个接收批次 */
const activeReceiveTid = { value: null as string | null };
/** 并发守卫：同一时刻仅一个发送批次 */
const activeSendTid = { value: null as string | null };
/** 加密会话：tid → {key, iv}（仅当对端 offer 带 enc 且本端确认后存在） */
const encSessions = new Map<string, { key: Buffer; iv: Buffer }>();
/** 询问模式：tid → 等待 UI 答复的 resolver */
const pendingAsk = new Map<string, { resolve: (accept: boolean) => void; timer: NodeJS.Timeout }>();

/** 收端某文件完成（成功或失败）后从内存批次回收；整批收完则删除批次，避免 incoming 内存泄漏 */
function recycleIncoming(tid: string, fid: string): void {
  const offer = incoming.get(tid);
  if (!offer) return;
  offer.files.delete(fid);
  if (offer.files.size === 0) {
    incoming.delete(tid);
    if (activeReceiveTid.value === tid) activeReceiveTid.value = null;
    encSessions.delete(tid);
  }
  incomingHashes.delete(`${tid}|${fid}`);
}

/**
 * 定时清理：
 *  1) 回收超过 OFFER_TTL_MS 的 offer（含其 .part，多因发送端中途消失）
 *  2) 删除超过 PART_TTL_MS 仍残留的孤立 .part（取消 / 网络中断 / 校验失败留下的隐藏文件）
 */
function sweepStale(): void {
  const now = Date.now();
  const dir = receiveDir();
  for (const [tid, offer] of incoming) {
    if (now - offer.createdAt > OFFER_TTL_MS) {
      for (const fid of offer.files.keys()) {
        const of = offer.files.get(fid);
        if (of) {
          const part = recvPartPath(dir, of.name, of.size);
          try { if (fs.existsSync(part)) fs.unlinkSync(part); } catch { /* ignore */ }
        }
      }
      if (activeReceiveTid.value === tid) activeReceiveTid.value = null;
      encSessions.delete(tid);
      incoming.delete(tid);
    }
  }
  try {
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith(".part")) continue;
        const fp = path.join(dir, f);
        if (now - fs.statSync(fp).mtimeMs > PART_TTL_MS) {
          try { fs.unlinkSync(fp); } catch { /* ignore */ }
        }
      }
    }
  } catch { /* ignore */ }
}

/** 等待渲染端对「是否接收」的答复（询问模式）；超时默认拒绝 */
function askAccept(tid: string, name: string, count: number, total: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingAsk.delete(tid);
      resolve(false);
    }, ASK_TIMEOUT_MS);
    pendingAsk.set(tid, { resolve, timer });
    emit("file-transfer:incoming-ask", { tid, name, count, total });
  });
}

function handleOffer(req: http.IncomingMessage, res: http.ServerResponse): void {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    try {
      const payload = JSON.parse(body) as {
        tid?: string;
        from?: { name?: string; id?: string; platform?: string };
        files?: { fid?: string; name?: string; size?: number; mime?: string }[];
        enc?: { key?: string; iv?: string };
      };
      const tid = payload.tid || "";

      // 并发守卫：已有接收批次进行中（或正等待答复）→ 拒绝新批次
      if (activeReceiveTid.value && activeReceiveTid.value !== tid) {
        res.statusCode = 429;
        res.end(JSON.stringify({ ok: false, reason: "busy" }));
        return;
      }
      if (pendingAsk.size > 0 && !pendingAsk.has(tid)) {
        res.statusCode = 429;
        res.end(JSON.stringify({ ok: false, reason: "busy" }));
        return;
      }

      const files = new Map<string, OfferFile>();
      for (const f of payload.files ?? []) {
        const fid = f.fid || "";
        files.set(fid, {
          fid,
          name: f.name || "未命名文件",
          size: typeof f.size === "number" ? f.size : 0,
          mime: f.mime ?? null,
        });
      }

      // #16 磁盘预估：总大小 vs 接收目录剩余空间，不足直接拒（避免必然失败的写入）
      const totalSize = [...files.values()].reduce((s, f) => s + (f.size || 0), 0);
      const free = freeSpaceBytes(receiveDir());
      if (free >= 0 && totalSize > free) {
        res.statusCode = 507;
        res.end(JSON.stringify({ ok: false, reason: "no space", free, required: totalSize }));
        return;
      }

      // #14 加密会话：发送端带 enc 才建立；本端确认后随响应回 enc:true
      let encOk = false;
      if (payload.enc && payload.enc.key && payload.enc.iv) {
        try {
          encSessions.set(tid, {
            key: Buffer.from(payload.enc.key, "base64"),
            iv: Buffer.from(payload.enc.iv, "base64"),
          });
          encOk = true;
        } catch {
          encSessions.delete(tid);
        }
      }

      // #15 询问模式：关自动接收时不立即拒绝，先等渲染端答复
      if (!autoAcceptEnabled()) {
        const accept = await askAccept(
          tid,
          payload.from?.name ?? "未知设备",
          files.size,
          totalSize,
        );
        if (!accept) {
          res.statusCode = 403;
          res.end(JSON.stringify({ ok: false, reason: "rejected" }));
          encSessions.delete(tid);
          return;
        }
      }

      // #13 断点续传：检查已有 .part 偏移，随 accepted 带回
      const dir = receiveDir();
      const accepted = [...files.values()].map((f) => {
        let resumeFrom = 0;
        const part = recvPartPath(dir, f.name, f.size);
        if (f.size > 0 && fs.existsSync(part)) {
          const sz = fs.statSync(part).size;
          if (sz > 0 && sz < f.size) resumeFrom = sz;
        }
        return { fid: f.fid, resumeFrom };
      });

      activeReceiveTid.value = tid;
      incoming.set(tid, {
        peerName: payload.from?.name ?? "未知设备",
        peerIp: req.socket.remoteAddress ?? "",
        files,
        createdAt: Date.now(),
      });
      // 回传本机设备信息，让发送端历史能填上对端名（peer_name 不再空白）
      res.end(
        JSON.stringify({
          ok: true,
          accepted,
          me: deviceInfo(),
          enc: encOk,
        }),
      );
    } catch (e) {
      res.statusCode = 400;
      res.end(JSON.stringify({ ok: false, error: String(e) }));
    }
  });
}

function handleData(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = new URL(req.url || "", "http://localhost");
  const tid = url.searchParams.get("tid") || "";
  const fid = url.searchParams.get("fid") || "";
  const from = Math.max(0, parseInt(url.searchParams.get("from") || "0", 10) || 0);
  const offer = incoming.get(tid);
  if (!offer || !offer.files.has(fid)) {
    res.statusCode = 404;
    res.end(JSON.stringify({ ok: false, reason: "unknown tid/fid" }));
    return;
  }
  const of = offer.files.get(fid)!;
  const dir = receiveDir();
  const part = recvPartPath(dir, of.name, of.size);
  const enc = encSessions.get(tid);
  const hash = crypto.createHash("sha256");

  // #13 续传：已存在部分 → 追加写 + 用已有字节给 hash 播种（最终 hash = 全文件）
  let ws: fs.WriteStream;
  if (from > 0 && fs.existsSync(part)) {
    const existing = fs.readFileSync(part);
    hash.update(existing);
    ws = fs.createWriteStream(part, { flags: "a" });
  } else {
    ws = fs.createWriteStream(part);
  }

  // #14 加密：req → decipher(解出明文) → hashPass(算明文 sha256) → ws(落盘)
  const hashPass = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  if (enc) {
    const decipher = crypto.createDecipheriv("aes-256-ctr", enc.key, enc.iv);
    req.pipe(decipher);
    decipher.pipe(hashPass).pipe(ws);
  } else {
    req.pipe(hashPass).pipe(ws);
  }
  ws.on("finish", () => {
    const bytes = fs.statSync(part).size;
    incomingHashes.set(`${tid}|${fid}`, hash.digest("hex"));
    res.end(JSON.stringify({ ok: true, received: bytes }));
  });
  ws.on("error", (e) => {
    res.statusCode = 500;
    res.end(JSON.stringify({ ok: false, error: String(e) }));
  });
}

function handleEnd(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = new URL(req.url || "", "http://localhost");
  const tid = url.searchParams.get("tid") || "";
  const fid = url.searchParams.get("fid") || "";
  const offer = incoming.get(tid);
  const of = offer?.files.get(fid);
  if (!offer || !of) {
    res.statusCode = 404;
    res.end(JSON.stringify({ ok: false, reason: "unknown tid/fid" }));
    return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let expectedHash: string | null = null;
    try {
      const b = JSON.parse(body || "{}") as { hash?: string };
      expectedHash = b.hash ?? null;
    } catch { /* 无 hash 则跳过校验 */ }
    const dir = receiveDir();
    const part = recvPartPath(dir, of.name, of.size);
    if (!fs.existsSync(part)) {
      res.statusCode = 400;
      res.end(JSON.stringify({ ok: false, reason: "no part file" }));
      return;
    }
    let finalName = dedupeName(dir, of.name);
    // #9 重名策略：覆盖模式直接替换同名文件
    if (renameStrategy() === "overwrite") {
      const target = path.join(dir, safeName(of.name));
      if (fs.existsSync(target) && target !== part) {
        try { fs.unlinkSync(target); } catch { /* ignore */ }
      }
      finalName = safeName(of.name);
    }
    const finalPath = path.join(dir, finalName);
    try {
      fs.renameSync(part, finalPath);
    } catch (e) {
      res.statusCode = 500;
      res.end(JSON.stringify({ ok: false, error: String(e) }));
      return;
    }
    const size = fs.statSync(finalPath).size;
    const sizeOk = of.size <= 0 || size === of.size;
    const storedHash = incomingHashes.get(`${tid}|${fid}`) ?? null;
    const hashOk = !expectedHash || !storedHash || storedHash === expectedHash;
    const ok = sizeOk && hashOk;
    let error: string | null = null;
    if (!sizeOk) error = "size mismatch";
    else if (!hashOk) error = "hash mismatch";
    if (!ok) {
      // 校验失败：不留坏文件
      try { fs.unlinkSync(finalPath); } catch { /* ignore */ }
    }
    insertHistory({
      tid,
      fid,
      direction: "receive",
      peerName: offer.peerName,
      peerIp: offer.peerIp,
      fileName: finalName,
      size,
      mime: of.mime,
      path: ok ? finalPath : "",
      status: ok ? "done" : "failed",
      error,
    }).catch((e) => console.warn("[transfer] insert history failed:", e));
    // 仅成功时推送给渲染端（页面外也能弹通知）
    if (ok) {
      emit("file-transfer:received", {
        name: finalName,
        path: finalPath,
        size,
        from: offer.peerName,
      });
    }
    recycleIncoming(tid, fid);
    res.end(JSON.stringify({ ok, path: finalPath, error }));
  });
}

// ---------------------------------------------------------------------------
// 发送端（PC → 手机）：offer → data(流式+进度) → end
// ---------------------------------------------------------------------------

/** 构造对端 URL（支持 ip 或 ip:port） */
function peerUrl(peerIp: string, p: string): string {
  const [host, portStr] = peerIp.split(":");
  const port = portStr ? Number(portStr) : DATA_PORT;
  return `http://${host}:${port}${p}`;
}

async function postJson(
  peerIp: string,
  p: string,
  body: unknown,
): Promise<any> {
  const res = await fetch(peerUrl(peerIp, p), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  return (await res.json()) as any;
}

/**
 * 以流式上传文件并回调进度，同时计算文件 sha256（流式，不落内存）。
 * - onProgress 收到的是**累计已发字节**（含续传起始偏移）。
 * - 按 PROGRESS_THROTTLE_MS 节流，流结束时 flush 补发一次确保 UI 收到 100%。
 * - signal 由所属批次的 AbortController 提供：取消或整体超时都会中止这个 fetch。
 * - #13 续传：startOffset>0 时从文件该偏移读起，Content-Length = 剩余字节。
 * - #14 加密：encKey/encIv 提供时对明文流做 AES-256-CTR 加密（hash 仍为明文 hash）。
 * @returns 文件 sha256 hex，用于 /file/end 带给接收端做完整性校验。
 */
async function postBinary(
  peerIp: string,
  p: string,
  filePath: string,
  onProgress: (bytes: number) => void,
  signal?: AbortSignal,
  encKey?: Buffer,
  encIv?: Buffer,
  startOffset = 0,
): Promise<string> {
  const stat = fs.statSync(filePath);
  const hash = crypto.createHash("sha256");
  let sent = startOffset;
  let lastEmit = 0;
  // #13 续传：接收端会给已有 .part 播种，其最终 hash = 全文件；
  // 发送端因此先把 [0, startOffset) 前缀补进 hash，使 end 携带的也是全文件 hash
  if (startOffset > 0) {
    await new Promise<void>((resolve, reject) => {
      fs.createReadStream(filePath, { end: startOffset - 1 })
        .on("data", (c: Buffer) => hash.update(c))
        .on("end", () => resolve())
        .on("error", reject);
    });
  }
  // 明文先过 tee（算 hash + 透传），encrypt 在 tee 之后
  const tee = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  let head: Readable = fs
    .createReadStream(filePath, startOffset > 0 ? { start: startOffset } : undefined)
    .pipe(tee) as Readable;
  if (encKey && encIv) {
    const cipher = crypto.createCipheriv("aes-256-ctr", encKey, encIv);
    head = head.pipe(cipher) as Readable;
  }
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      sent += chunk.length;
      const now = Date.now();
      if (now - lastEmit >= PROGRESS_THROTTLE_MS) {
        lastEmit = now;
        onProgress(sent);
      }
      cb(null, chunk);
    },
    flush(cb) {
      onProgress(sent);
      cb();
    },
  });
  const nodeStream = head.pipe(counter) as Readable;
  const webStream = Readable.toWeb(nodeStream);
  // CTR 是流密码，密文长度 = 明文长度，故 Content-Length = 剩余字节数
  // undici 要求：body 为 ReadableStream 时必须声明 duplex，否则抛
  // "RequestInit: duplex option is required when sending a body."
  // （DOM lib 的 RequestInit 无 duplex 字段，故局部交叉类型标注）
  const init: RequestInit & { duplex?: "half" } = {
    method: "POST",
    headers: { "Content-Length": String(stat.size - startOffset) },
    duplex: "half",
    body: webStream as unknown as BodyInit,
    signal,
  };
  await fetch(peerUrl(peerIp, p), init);
  return hash.digest("hex");
}

interface SendProgress {
  tid: string;
  fid: string;
  name: string;
  sent: number;
  total: number;
  phase: "data" | "done" | "failed" | "canceled";
}

/**
 * 批量发送：串行逐文件，逐字节进度回调由主进程直接转发。
 * #13 续传：offer 响应带回各文件 resumeFrom，对应文件从偏移续传。
 * #14 加密：本端开启且对端确认(enc:true)后才加密。
 * #17 并发守卫：已有发送批次进行时直接拒绝。
 * 取消：transfer:cancel 会把 cancelFlags[tid] 置位并 abort 对应控制器；
 *   tid 只经进度事件传出（transfer:send 的 handle 要等整批结束才返回）。
 */
async function sendBatch(
  peerIp: string,
  filePaths: string[],
  onProgress: (p: SendProgress) => void,
): Promise<{
  ok: boolean;
  okCount: number;
  failCount: number;
  canceled: boolean;
  tid: string;
  message: string;
}> {
  if (!filePaths.length) {
    return { ok: false, okCount: 0, failCount: 0, canceled: false, tid: "", message: "未选择文件" };
  }
  // #17 并发守卫
  if (activeSendTid.value) {
    return { ok: false, okCount: 0, failCount: 0, canceled: false, tid: "", message: "已有传输在进行，请稍后再发" };
  }
  const tid = crypto.randomUUID();
  activeSendTid.value = tid;
  const ac = new AbortController();
  abortControllers.set(tid, ac);
  cancelFlags.set(tid, false);
  const timer = setTimeout(
    () => ac.abort(new Error("timeout")),
    Math.max(60_000, 60_000 * filePaths.length),
  );

  // #14 加密协商：本端开启才生成会话密钥
  let encKey: Buffer | undefined;
  let encIv: Buffer | undefined;
  if (encEnabled()) {
    encKey = crypto.randomBytes(32);
    encIv = crypto.randomBytes(16);
  }

  const offerFiles = filePaths.map((fp, i) => ({
    fid: String(i + 1),
    name: path.basename(fp),
    size: fs.statSync(fp).size,
    mime: guessMime(fp),
  }));
  try {
    let peerName = ""; // 默认空，offer 响应回传设备名后填入
    const offerResp = (await postJson(peerIp, "/file/offer", {
      tid,
      from: deviceInfo(),
      files: offerFiles,
      enc: encKey && encIv ? { key: encKey.toString("base64"), iv: encIv.toString("base64") } : undefined,
    })) as {
      ok: boolean;
      reason?: string;
      me?: { name?: string; id?: string; platform?: string };
      enc?: boolean;
      accepted?: { fid: string; resumeFrom?: number }[];
    };
    if (!offerResp.ok) {
      clearTimeout(timer);
      activeSendTid.value = null;
      return {
        ok: false,
        okCount: 0,
        failCount: 0,
        canceled: false,
        tid,
        message: `对方拒绝接收：${offerResp.reason ?? "未知原因"}`,
      };
    }
    // 仅当本端加密且对端确认才真正加密
    const useEnc = !!(encKey && encIv && offerResp.enc);
    // 接收端在 offer 响应里回传了设备名，发送端历史据此填上对端名（peer_name 不再空白）
    peerName = offerResp.me?.name || "";
    const resumeMap = new Map<string, number>();
    for (const a of offerResp.accepted ?? []) {
      resumeMap.set(a.fid, a.resumeFrom && a.resumeFrom > 0 ? a.resumeFrom : 0);
    }
    // 先发初始进度，让渲染端拿到 tid（取消按钮依赖它）
    onProgress({
      tid,
      fid: "1",
      name: offerFiles[0].name,
      sent: resumeMap.get("1") ?? 0,
      total: offerFiles[0].size,
      phase: "data",
    });

    let okCount = 0;
    let failCount = 0;
    let canceled = false;
    for (let i = 0; i < filePaths.length; i++) {
      if (cancelFlags.get(tid)) {
        canceled = true;
        break;
      }
      const fp = filePaths[i];
      const fid = String(i + 1);
      const meta = offerFiles[i];
      const startOffset = resumeMap.get(fid) ?? 0;
      // data：流式 + 进度 + 可中止（支持续传偏移 / 加密）
      let hash = "";
      try {
        hash = await postBinary(
          peerIp,
          `/file/data?tid=${tid}&fid=${fid}${startOffset > 0 ? `&from=${startOffset}` : ""}`,
          fp,
          (bytes) => {
            onProgress({
              tid,
              fid,
              name: meta.name,
              sent: bytes,
              total: meta.size,
              phase: "data",
            });
          },
          ac.signal,
          useEnc ? encKey : undefined,
          useEnc ? encIv : undefined,
          startOffset,
        );
      } catch (err) {
        const isCancel = cancelFlags.get(tid) === true;
        await insertHistory({
          tid,
          fid,
          direction: "send",
          peerName,
          peerIp,
          fileName: meta.name,
          size: meta.size,
          mime: meta.mime,
          path: fp,
          status: isCancel ? "canceled" : "failed",
          error: isCancel ? null : `send failed: ${String(err)}`,
        }).catch((e) => console.warn("[transfer] insert history failed:", e));
        onProgress({
          tid,
          fid,
          name: meta.name,
          sent: startOffset,
          total: meta.size,
          phase: isCancel ? "canceled" : "failed",
        });
        if (isCancel) {
          canceled = true;
          break;
        }
        failCount++;
        continue; // 非取消的失败不中断整批，继续下一个文件
      }
      // end：把本文件 sha256 带给接收端做完整性校验
      const endResp = (await postJson(peerIp, `/file/end?tid=${tid}&fid=${fid}`, { hash })) as {
        ok: boolean;
        error?: string;
        reason?: string;
      };
      const done = !!endResp.ok;
      if (done) okCount++;
      else failCount++;
      await insertHistory({
        tid,
        fid,
        direction: "send",
        peerName,
        peerIp,
        fileName: meta.name,
        size: meta.size,
        mime: meta.mime,
        path: fp,
        status: done ? "done" : "failed",
        error: done ? null : endResp.error || endResp.reason || "peer rejected",
      }).catch((e) => console.warn("[transfer] insert history failed:", e));
      onProgress({
        tid,
        fid,
        name: meta.name,
        sent: meta.size,
        total: meta.size,
        phase: done ? "done" : "failed",
      });
    }
    emit("file-transfer:batch-done", { tid, ok: okCount, fail: failCount, canceled });
    clearTimeout(timer);
    activeSendTid.value = null;
    return {
      ok: !canceled,
      okCount,
      failCount,
      canceled,
      tid,
      message: canceled
        ? `已取消（已完成 ${okCount} 个）`
        : `已发送 ${okCount} 个${failCount ? `，失败 ${failCount} 个` : ""}`,
    };
  } catch (e) {
    clearTimeout(timer);
    activeSendTid.value = null;
    return {
      ok: false,
      okCount: 0,
      failCount: filePaths.length,
      canceled: cancelFlags.get(tid) === true,
      tid,
      message: `发送失败：${e}`,
    };
  } finally {
    abortControllers.delete(tid);
    cancelFlags.delete(tid);
  }
}

// ---------------------------------------------------------------------------
// 初始化：建表 + 注册 /file/* 路由 + IPC
// ---------------------------------------------------------------------------

/** 取消控制：tid → 是否请求取消；tid → 当前批次的 AbortController（中止流式 fetch） */
const cancelFlags = new Map<string, boolean>();
const abortControllers = new Map<string, AbortController>();

export function initTransfer(): void {
  try {
    // 1) 安全建表（与移动端 file_transfer 逐列对齐）
    ensureTableExists("file_transfer", FILE_TRANSFER_COLUMNS, "key", {
      primaryKeyType: "TEXT",
    }).catch((e) => console.warn("[transfer] ensure table failed:", e));
    trimHistory().catch((e) => console.warn("[transfer] trim history failed:", e));

    // 1.1) 启动期清理残留 .part 与陈旧 offer，并周期性扫描
    try {
      sweepStale();
      setInterval(sweepStale, SWEEP_INTERVAL_MS);
    } catch (e) {
      console.warn("[transfer] sweep init failed:", e);
    }

    // 2) 注册接收端路由到 47124 数据面（在 sync 的 server 之前/之后均可，按请求动态查）
    registerDataRoute("POST", "/file/offer", handleOffer);
    registerDataRoute("POST", "/file/data", handleData);
    registerDataRoute("POST", "/file/end", handleEnd);

    // 3) IPC：状态 / 扫描 / 选文件 / 发送 / 历史 / 打开接收目录
    ipcMain.handle("transfer:status", () => ({
      success: true,
      data: {
        ...deviceInfo(),
        receiveDir: receiveDir(),
        autoAccept: autoAcceptEnabled(),
        rename: renameStrategy(),
        enc: encEnabled(),
        recentCount: loadRecent().length,
      },
    }));

    ipcMain.handle("transfer:scan", async () => {
      const peers = await scanPeers();
      rememberPeers(peers);
      return { success: true, data: peers };
    });

    ipcMain.handle("transfer:recent-peers", () => {
      return { success: true, data: loadRecent() };
    });

    ipcMain.handle("transfer:forget-peer", (_e, args: { ip: string }) => {
      forgetPeer(args?.ip);
      return { success: true };
    });

    ipcMain.handle("transfer:pick-files", () => {
      const w = win || undefined;
      const result = dialog.showOpenDialogSync(w as any, {
        title: "选择要发送的文件",
        properties: ["openFile", "multiSelections", "openDirectory"],
      });
      // #10 文件夹：展开为文件列表（递归），文件夹本身不传
      const files: string[] = [];
      const walk = (p: string) => {
        const st = fs.statSync(p);
        if (st.isDirectory()) {
          for (const c of fs.readdirSync(p)) walk(path.join(p, c));
        } else if (st.isFile()) {
          files.push(p);
        }
      };
      for (const r of result || []) walk(r);
      return { success: true, data: files };
    });

    ipcMain.handle("transfer:set-auto-accept", (_e, args: { value: boolean }) => {
      store.set("_transfer_auto_accept", !!args?.value);
      return { success: true, data: { autoAccept: !!args?.value } };
    });

    ipcMain.handle("transfer:set-rename", (_e, args: { value: "rename" | "overwrite" }) => {
      store.set("_transfer_rename", args?.value === "overwrite" ? "overwrite" : "rename");
      return { success: true, data: { rename: renameStrategy() } };
    });

    ipcMain.handle("transfer:set-enc", (_e, args: { value: boolean }) => {
      store.set("_transfer_enc", !!args?.value);
      return { success: true, data: { enc: encEnabled() } };
    });

    ipcMain.handle(
      "transfer:send",
      async (_e, args: { peerIp: string; filePaths: string[] }) => {
        const result = await sendBatch(args.peerIp, args.filePaths || [], (p) => {
          emit("file-transfer:progress", p);
        });
        return { success: result.ok, data: result };
      },
    );

    // 取消指定批次：置位 + 中止正在流式上传的 fetch（sendBatch 会记 canceled 并停止后续文件）
    ipcMain.handle("transfer:cancel", (_e, args: { tid: string }) => {
      const tid = args?.tid;
      if (!tid) return { success: false, error: "missing tid" };
      cancelFlags.set(tid, true);
      abortControllers.get(tid)?.abort(new Error("canceled"));
      return { success: true };
    });

    // #15 询问模式：渲染端对用户答复（接收/拒绝），唤醒 handleOffer 中 await 的 askAccept
    ipcMain.handle("transfer:answer-offer", (_e, args: { tid: string; accept: boolean }) => {
      const tid = args?.tid;
      const p = pendingAsk.get(tid);
      if (!p) return { success: false, error: "no pending ask" };
      clearTimeout(p.timer);
      pendingAsk.delete(tid);
      p.resolve(!!args?.accept);
      return { success: true };
    });

    // #20 历史：支持 limit/offset 分页；返回前自动清理超阈值最旧记录
    ipcMain.handle("transfer:history", async (_e, args?: { limit?: number; offset?: number }) => {
      try {
        const limit = args?.limit && args.limit > 0 ? args.limit : 200;
        const offset = args?.offset && args.offset > 0 ? args.offset : 0;
        await trimHistory();
        const rows = (await query({
          tableName: "file_transfer",
          orderByDesc: "created_at",
          limit,
          offset,
        })) as Record<string, unknown>[];
        const total = await count("file_transfer");
        return { success: true, data: rows, total };
      } catch (e) {
        return { success: false, error: String(e), data: [], total: 0 };
      }
    });

    ipcMain.handle("transfer:open-received", () => {
      try {
        shell.openPath(receiveDir());
        return { success: true };
      } catch (e) {
        return { success: false, error: String(e) };
      }
    });

    // 打开指定历史文件（shell.openPath 按系统关联程序打开）
    ipcMain.handle("transfer:open-file", (_e, args: { path: string }) => {
      const p = args?.path;
      if (!p) return { success: false, error: "missing path" };
      try {
        shell.openPath(p);
        return { success: true };
      } catch (e) {
        return { success: false, error: String(e) };
      }
    });

    // 在资源管理器定位文件（显示所在文件夹并选中）
    ipcMain.handle("transfer:open-folder", (_e, args: { path: string }) => {
      const p = args?.path;
      if (!p) return { success: false, error: "missing path" };
      try {
        shell.showItemInFolder(p);
        return { success: true };
      } catch (e) {
        return { success: false, error: String(e) };
      }
    });

    console.log("[transfer] module initialized");
  } catch (e) {
    console.warn("[transfer] init failed:", e);
  }
}

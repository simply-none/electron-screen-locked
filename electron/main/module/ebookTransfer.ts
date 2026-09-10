/**
 * 电子书跨端传书（PC 侧接收端 + 数据面路由）
 *
 * 与移动端 `lib/features/ebook/services/ebook_transfer.dart` 对称，复用同步数据面 47124：
 *   GET  /ebook/list                 → 本机书架（只返回磁盘上真实存在的文件）
 *   GET  /ebook/download?path=<enc>  → 原始文件字节
 *   POST /ebook/upload?name=&format= → body 为原始字节，落盘到 books 目录并写入书架
 *
 * 落盘目录：`userData/jianli-books`（与 PC 自有书架解耦，避免污染用户原有目录）。
 * 身份键用内容 sha256（content_hash），与移动端 `importBookBytes` 完全一致。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

import { app, ipcMain } from "electron";
import log from "electron-log";

import { myDb } from "./newSql.ts";
import { registerDataRoute, scanPeers } from "./sync/syncModule.ts";

const BOOKSHELF_TABLE = "ebook_bookshelf";

/** 对端数据面端口，与 syncModule 的 DATA_PORT 一致 */
const DATA_PORT = 47124;

function peerUrl(peerIp: string, p: string): string {
  return `http://${peerIp}:${DATA_PORT}${p}`;
}

/** 接收自手机的书落盘目录 */
function booksDir(): string {
  const dir = path.join(app.getPath("userData"), "jianli-books");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 简易查询（与 syncModule 的 query 同库句柄） */
function querySql<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return new Promise((resolve) => {
    const db = myDb.db;
    if (!db) {
      resolve([] as T[]);
      return;
    }
    db.all(sql, params, (err, rows) => {
      if (err) {
        log.warn("[ebook-transfer] query failed:", err.message);
        resolve([] as T[]);
        return;
      }
      resolve((rows ?? []) as T[]);
    });
  });
}

function runSql(sql: string, params: unknown[] = []): Promise<void> {
  return new Promise((resolve) => {
    const db = myDb.db;
    if (!db) {
      resolve();
      return;
    }
    db.run(sql, params, (err) => {
      if (err) log.warn("[ebook-transfer] run failed:", err.message);
      resolve();
    });
  });
}

function json(res: http.ServerResponse, data: unknown, status = 200): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(data));
}

/** 落盘 + 入库的统一入口：按内容 sha256 去重（与移动端 importBookBytes 同身份键） */
async function saveBookBytes(
  rawName: string,
  format: "epub" | "txt",
  buf: Buffer,
): Promise<{ title: string; contentHash: string; deduped: boolean }> {
  const hash = crypto.createHash("sha256").update(buf).digest("hex");
  const ext = format === "epub" ? ".epub" : ".txt";

  // 同内容已存在（跨端去重，content_hash 为稳定身份键）
  const exist = await querySql(
    `SELECT file_path FROM ${BOOKSHELF_TABLE} WHERE content_hash = ? LIMIT 1`,
    [hash],
  );
  if (exist.length > 0) {
    return { title: rawName, contentHash: hash, deduped: true };
  }

  const base =
    rawName && rawName.toLowerCase().endsWith(ext)
      ? rawName.slice(0, rawName.length - ext.length)
      : rawName || "book";
  const safe = base.replace(/[\\/:*?"<>|]/g, "_").slice(0, 120) || "book";
  const filePath = path.join(booksDir(), `${safe}-${hash.slice(0, 8)}${ext}`);
  fs.writeFileSync(filePath, buf);

  const now = new Date().toISOString();
  await runSql(
    `INSERT OR REPLACE INTO ${BOOKSHELF_TABLE}
     (file_path, name, format, percent, last_read_at, added_at, title, content_hash)
     VALUES (?, ?, ?, 0, ?, ?, ?, ?)`,
    [filePath, safe, format, now, now, safe, hash],
  );
  log.info(`[ebook-transfer] saved book=${safe} size=${buf.length}`);
  return { title: safe, contentHash: hash, deduped: false };
}

// ============ 客户端：PC 主动从手机拉书 / 向手机推书 ============

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

/** 本机待上传的书（渲染端传 filePath + 元信息即可） */
export interface LocalEbookPick {
  filePath: string;
  name?: string;
  title?: string;
  format?: string;
}

/** 拉取对端书目（只保留 epub/txt） */
async function listRemoteBooks(peerIp: string): Promise<RemoteEbook[]> {
  const res = await fetch(peerUrl(peerIp, "/ebook/list"), {
    signal: AbortSignal.timeout(8000),
  });
  const body = (await res.json()) as { ok?: boolean; books?: RemoteEbook[] };
  if (!body.ok) return [];
  return (body.books ?? []).filter((b) => b.format === "epub" || b.format === "txt");
}

/** 从对端下载一本并落库 */
async function downloadOne(peerIp: string, book: RemoteEbook): Promise<TransferOneResult> {
  const display = book.title || book.name || "未命名";
  try {
    const res = await fetch(
      peerUrl(peerIp, `/ebook/download?path=${encodeURIComponent(book.filePath)}`),
      { signal: AbortSignal.timeout(120_000) },
    );
    if (!res.ok) return { ok: false, title: display, error: `HTTP ${res.status}` };
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) return { ok: false, title: display, error: "空文件" };
    const saved = await saveBookBytes(display, book.format === "txt" ? "txt" : "epub", buf);
    return { ok: true, title: saved.title, deduped: saved.deduped };
  } catch (e) {
    return { ok: false, title: display, error: String(e) };
  }
}

/** 把本机一本推给对端 */
async function uploadOne(peerIp: string, item: LocalEbookPick): Promise<TransferOneResult> {
  const display = item.title || item.name || "未命名";
  try {
    if (!fs.existsSync(item.filePath)) {
      return { ok: false, title: display, error: "本机文件不存在" };
    }
    const format = item.format === "txt" ? "txt" : "epub";
    const ext = format === "epub" ? ".epub" : ".txt";
    const name = `${display}${display.toLowerCase().endsWith(ext) ? "" : ext}`;
    const buf = fs.readFileSync(item.filePath);
    const res = await fetch(
      peerUrl(peerIp, `/ebook/upload?name=${encodeURIComponent(name)}&format=${format}`),
      {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: buf,
        signal: AbortSignal.timeout(120_000),
      },
    );
    const body = (await res.json()) as { ok?: boolean; error?: string; deduped?: boolean };
    if (!body.ok) return { ok: false, title: display, error: body.error ?? "上传失败" };
    return { ok: true, title: display, deduped: body.deduped };
  } catch (e) {
    return { ok: false, title: display, error: String(e) };
  }
}

/** 渲染端传书 IPC 注册（幂等）：扫描 / 对端书目 / 批量下载 / 批量上传 */
let ipcRegistered = false;

function registerTransferIpc(): void {
  if (ipcRegistered) return;
  ipcRegistered = true;

  ipcMain.handle("ebook:transfer-scan", async () => ({
    success: true,
    data: await scanPeers(),
  }));

  ipcMain.handle("ebook:transfer-list", async (_e, args: { peerIp: string }) => ({
    success: true,
    data: await listRemoteBooks(args.peerIp),
  }));

  ipcMain.handle(
    "ebook:transfer-download",
    async (_e, args: { peerIp: string; books: RemoteEbook[] }) => {
      const results: TransferOneResult[] = [];
      for (const b of args.books ?? []) results.push(await downloadOne(args.peerIp, b));
      return { success: true, data: results };
    },
  );

  ipcMain.handle(
    "ebook:transfer-upload",
    async (_e, args: { peerIp: string; books: LocalEbookPick[] }) => {
      const results: TransferOneResult[] = [];
      for (const b of args.books ?? []) results.push(await uploadOne(args.peerIp, b));
      return { success: true, data: results };
    },
  );
}

/** 注册 /ebook/* 三条路由到同步数据面 */
export function initEbookTransfer(): void {
  // GET /ebook/list —— 本机可供下载的书目
  registerDataRoute("GET", "/ebook/list", async (_req, res) => {
    try {
      const rows = await querySql(
        `SELECT file_path, name, format, title, content_hash FROM ${BOOKSHELF_TABLE}`,
      );
      const books = rows
        .map((r) => {
          const filePath = String(r.file_path ?? "");
          let size = 0;
          try {
            size = filePath && fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
          } catch {
            size = 0;
          }
          return {
            filePath,
            name: String(r.name ?? ""),
            format: String(r.format ?? ""),
            title: String(r.title ?? r.name ?? ""),
            size,
            contentHash: String(r.content_hash ?? ""),
          };
        })
        .filter((b) => b.filePath && b.size > 0 && (b.format === "epub" || b.format === "txt"));
      json(res, { ok: true, books });
    } catch (e) {
      json(res, { ok: false, error: String(e) }, 500);
    }
  });

  // GET /ebook/download?path=... —— 原始字节
  registerDataRoute("GET", "/ebook/download", async (req, res) => {
    try {
      const url = new URL(req.url ?? "", "http://localhost");
      const filePath = url.searchParams.get("path") ?? "";
      if (!filePath || !fs.existsSync(filePath)) {
        json(res, { ok: false, error: "文件不存在" }, 404);
        return;
      }
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("X-File-Name", encodeURIComponent(path.basename(filePath)));
      fs.createReadStream(filePath).pipe(res);
    } catch (e) {
      json(res, { ok: false, error: String(e) }, 500);
    }
  });

  // POST /ebook/upload?name=&format= —— 接收手机传来的书
  registerDataRoute("POST", "/ebook/upload", async (req, res) => {
    try {
      const url = new URL(req.url ?? "", "http://localhost");
      const rawName = url.searchParams.get("name") ?? "";
      const format = url.searchParams.get("format") === "txt" ? "txt" : "epub";
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk as Buffer));
      const buf = Buffer.concat(chunks);
      if (buf.length === 0) {
        json(res, { ok: false, error: "空文件" }, 400);
        return;
      }
      // 落盘 + 去重 + 入库（与客户端下载复用同一套身份键逻辑）
      const saved = await saveBookBytes(rawName, format, buf);
      json(res, {
        ok: true,
        title: saved.title,
        contentHash: saved.contentHash,
        deduped: saved.deduped,
      });
    } catch (e) {
      json(res, { ok: false, error: String(e) }, 500);
    }
  });

  // 渲染端「一键传书」IPC（扫描 / 对端书目 / 批量下载 / 批量上传）
  registerTransferIpc();
}

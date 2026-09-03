import { createTable } from "../utils/sql.ts";
import { myDb } from "./newSql.ts";
import { clipboard, ipcMain, nativeImage } from "electron";
import { exec } from "child_process";
import moment from 'moment';
// 数据库操作统一迁移到 newSql（替代旧 sql.ts 的 queryByConditions/upsertData）
import { del as newSqlDel, execute as newSqlExecute } from "./newSql.ts";

export const tableName = "clipboard_history";

// 图片 dataURL 体积上限：超过则不入库，避免 SQLite 被大图撑爆
const MAX_IMAGE_DATAURL_LENGTH = 2 * 1024 * 1024;
// 图片去重指纹取样长度（比较完整 dataURL 开销过大，取长度 + 头部片段足够区分）
const IMAGE_FINGERPRINT_SAMPLE = 200;

/** 内容类型筛选：与渲染端工具栏的筛选项一一对应 */
export type ClipboardKind = 'all' | 'text' | 'image' | 'link';

// 构建 WHERE 子句与参数（参数化，避免 SQL 注入）
function buildWhere(opts: { keyword?: string; startTime?: string; endTime?: string; kind?: ClipboardKind }) {
  const clauses: string[] = [];
  const params: any[] = [];
  if (opts.keyword) {
    clauses.push("text LIKE ?");
    params.push(`%${opts.keyword}%`);
  }
  if (opts.startTime) {
    clauses.push("create_time >= ?");
    params.push(opts.startTime);
  }
  if (opts.endTime) {
    clauses.push("create_time <= ?");
    params.push(opts.endTime);
  }
  // 类型筛选：文本（有文本无图片）/ 图片（有图片）/ 链接（文本以协议开头）
  if (opts.kind && opts.kind !== 'all') {
    if (opts.kind === 'text') {
      clauses.push("(text IS NOT NULL AND text <> '' AND (image IS NULL OR image = ''))");
    } else if (opts.kind === 'image') {
      clauses.push("(image IS NOT NULL AND image <> '')");
    } else if (opts.kind === 'link') {
      clauses.push("(text LIKE 'http://%' OR text LIKE 'https://%')");
    }
  }
  return {
    where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "",
    params,
  };
}

/** 兼容旧库：补齐后续版本新增的列（列已存在时 sqlite 报 duplicate column name，忽略即可） */
async function ensureClipboardColumns() {
  const columns = [
    { name: 'use_count', def: 'INTEGER DEFAULT 1' },
    { name: 'last_used', def: 'TEXT' },
  ];
  for (const col of columns) {
    try {
      await newSqlExecute(`ALTER TABLE ${tableName} ADD COLUMN ${col.name} ${col.def}`);
    } catch (err) {
      // 列已存在，忽略
    }
  }
}

/**
 * 清洗历史脏数据：早期版本把 NativeImage 直接 JSON 序列化后入库（实为 {} 之类的无效值），
 * 会被类型筛选与卡片图片分支误判为图片，这里统一清空。
 */
async function cleanLegacyImageData() {
  try {
    await newSqlExecute(
      `UPDATE ${tableName} SET image = '' WHERE image IS NOT NULL AND image <> '' AND image NOT LIKE 'data:image%'`
    );
  } catch (err) {
    console.error("clipboard clean legacy image error:", err);
  }
}

export async function initClipboard() {
  // 初始化表结构（兼容旧库，保证列存在）
  createTable({
    db: myDb.db,
    tableName,
    config: {},
    callback: (err: Error) => {
      if (err) console.error("clipboard table init error:", err);
    },
  });

  await ensureClipboardColumns();
  await cleanLegacyImageData();
  registerClipboardIpc();
  startClipboardMonitor();
}

/**
 * 注册剪切板相关 IPC（全部基于 newSql.ts）。
 * 渲染端经 clipboardApi 调用，不再使用旧的 query-data / delete-data 透传。
 */
function registerClipboardIpc() {
  // 普通查询 + 高级查询（关键词 / 时间范围 / 类型）+ 分页，统一参数化
  ipcMain.handle(
    "clipboard:query",
    async (_e, { keyword, startTime, endTime, kind, limit = 50, offset = 0 }) => {
      try {
        const { where, params } = buildWhere({ keyword, startTime, endTime, kind });
        const sql = `SELECT * FROM ${tableName} ${where} ORDER BY create_time DESC, id DESC LIMIT ? OFFSET ?`;
        const res = await newSqlExecute(sql, [...params, limit, offset]);
        return { success: true, data: res.rows || [] };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    }
  );

  // 单条删除（按 id）
  ipcMain.handle("clipboard:delete", async (_e, { id }) => {
    try {
      const { changes } = await newSqlDel({ tableName, condition: { id } });
      return { success: true, changes };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  // 批量删除（按 id 数组）
  ipcMain.handle("clipboard:delete-many", async (_e, { ids }) => {
    try {
      if (!Array.isArray(ids) || ids.length === 0) return { success: true, changes: 0 };
      const placeholders = ids.map(() => "?").join(",");
      const { changes } = await newSqlExecute(`DELETE FROM ${tableName} WHERE id IN (${placeholders})`, ids);
      return { success: true, changes };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  // 清空全部（newSql.del 不允许空条件，故用 execute）
  ipcMain.handle("clipboard:clear", async () => {
    try {
      const { changes } = await newSqlExecute(`DELETE FROM ${tableName}`);
      return { success: true, changes };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  // 按条件删除（高级查询-删除场景）：时间范围
  ipcMain.handle("clipboard:delete-by-condition", async (_e, { startTime, endTime }) => {
    try {
      const { where, params } = buildWhere({ startTime, endTime });
      const { changes } = await newSqlExecute(`DELETE FROM ${tableName} ${where}`, params);
      return { success: true, changes };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  // 去重删除：相同 text 仅保留 id 最小的一条
  ipcMain.handle("clipboard:dedup", async () => {
    try {
      const { changes } = await newSqlExecute(
        `DELETE FROM ${tableName} WHERE id NOT IN (SELECT MIN(id) FROM ${tableName} GROUP BY text)`
      );
      return { success: true, changes };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  /**
   * 写回系统剪贴板并累加使用次数。
   * mode='text' 只写纯文本（去格式）；mode='raw' 保留 html / 图片原格式。
   */
  ipcMain.handle("clipboard:write", async (_e, { id, mode = 'raw' }) => {
    try {
      const res = await newSqlExecute(
        `SELECT id, text, html, image FROM ${tableName} WHERE id = ? LIMIT 1`,
        [id]
      );
      const row = res.rows && res.rows[0];
      if (!row) return { success: false, error: '记录不存在' };

      if (mode === 'text') {
        // 纯文本模式：只写 text，丢弃富文本与图片
        clipboard.writeText(row.text || '');
      } else if (row.image) {
        // 图片条目：写回图片（text 可能为空）
        clipboard.writeImage(nativeImage.createFromDataURL(row.image));
      } else if (row.html) {
        clipboard.write({ text: row.text || '', html: row.html });
      } else {
        clipboard.writeText(row.text || '');
      }

      // 复制即使用：累加次数并刷新最近使用时间
      const now = moment().format("YYYY-MM-DD HH:mm:ss");
      await newSqlExecute(
        `UPDATE ${tableName} SET use_count = COALESCE(use_count, 0) + 1, last_used = ? WHERE id = ?`,
        [now, id]
      );
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  /**
   * 模拟 Ctrl+V 粘贴到当前前台应用（快速面板用）。
   * 依赖 Windows 的 WScript.Shell SendKeys；非 Windows 或失败时返回失败，
   * 调用方已把内容写进剪贴板，用户手动粘贴不受影响。
   */
  ipcMain.handle("clipboard:simulate-paste", async () => {
    if (process.platform !== "win32") {
      return { success: false, error: "当前平台不支持自动粘贴" };
    }
    return new Promise<{ success: boolean; error?: string }>((resolve) => {
      // 等待小窗隐藏、焦点回到目标应用后再发送按键
      setTimeout(() => {
        exec(
          `powershell -NoProfile -Command "$wshell = New-Object -ComObject wscript.shell; $wshell.SendKeys('^v')"`,
          (err) => resolve(err ? { success: false, error: String(err) } : { success: true })
        );
      }, 150);
    });
  });
}

// 进程内缓存上一条剪贴板文本，避免每秒都查库比对。
// 原重构版本每秒调用 newSqlQuery，而 newSql.query 内部每次都触发
// ensureTableExists（sqlite_master 查询 + 两次 PRAGMA table_info 自省），
// 即每秒凭空多 3 次 DB 往返，是监听卡顿的根因。
let lastClipboardText = "";
// 图片指纹缓存（长度 + 头部片段），避免每秒对整张图做 PNG 编码与全量比较
let lastImageFingerprint = "";

/** 计算图片指纹：长度 + 头部取样，足以区分不同截图且开销极低 */
function imageFingerprint(dataUrl: string): string {
  return `${dataUrl.length}:${dataUrl.slice(0, IMAGE_FINGERPRINT_SAMPLE)}`;
}

/** 带 use_count / last_used 的落库：相同纯文本合并为一条并置顶，图片每次都新增 */
async function saveClipboardItem(payload: {
  text: string;
  html: string;
  image: string;
  rtf: string;
  bookmark: string;
  findText: string;
  now: string;
}) {
  const { text, html, image, rtf, bookmark, findText, now } = payload;

  // 图片条目不做合并（每次截图都是独立内容），直接新增
  if (image) {
    await newSqlExecute(
      `INSERT INTO ${tableName} (text, html, image, rtf, bookmark, findText, create_time, use_count, last_used) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      [text, html, image, rtf, bookmark, findText, now, now]
    );
    return;
  }

  // 纯文本/富文本：已存在相同文本则合并（次数 +1、时间刷新到置顶），否则新增
  const exist = await newSqlExecute(
    `SELECT id FROM ${tableName} WHERE text = ? AND (image IS NULL OR image = '') LIMIT 1`,
    [text]
  );
  const existId = exist.rows && exist.rows[0]?.id;
  if (existId) {
    await newSqlExecute(
      `UPDATE ${tableName} SET use_count = COALESCE(use_count, 0) + 1, last_used = ?, create_time = ? WHERE id = ?`,
      [now, now, existId]
    );
    return;
  }

  await newSqlExecute(
    `INSERT INTO ${tableName} (text, html, image, rtf, bookmark, findText, create_time, use_count, last_used) VALUES (?, ?, '', ?, ?, ?, ?, 1, ?)`,
    [text, html, rtf, bookmark, findText, now, now]
  );
}

/**
 * 后台剪贴板监听：监测剪贴板变化并落库（newSql）。
 *
 * 性能约定：
 * 1. 每秒只做轻量的 readText() + availableFormats()，与进程内缓存比对，
 *    未变化直接返回（零 DB、零图片解码）。
 * 2. 只有确认剪贴板里真的有图片格式时，才做 readImage().toDataURL() 的昂贵操作。
 * 3. 写入仅在真正新增/合并时发生，避免每秒 DB 往返。
 */
function startClipboardMonitor() {
  // 启动时用最新一条文本预热缓存，避免重启后首次复制重复落库
  newSqlExecute(`SELECT text, image FROM ${tableName} ORDER BY create_time DESC LIMIT 1`)
    .then((res) => {
      const row = res.rows && res.rows[0];
      lastClipboardText = row?.text || "";
      lastImageFingerprint = row?.image ? imageFingerprint(row.image) : "";
    })
    .catch((err) => console.error("clipboard seed last text error:", err));

  setInterval(async () => {
    const text = clipboard.readText();
    const hasText = !!text && !!text.trim();

    // 文本未变化：再判断图片（先用便宜的 availableFormats 守卫，避免每秒编码图片）
    if (!hasText || text === lastClipboardText) {
      const formats = clipboard.availableFormats();
      const hasImageFormat = formats.some((f: string) => f.toLowerCase().startsWith("image/"));
      if (!hasImageFormat) return;

      const img = clipboard.readImage();
      if (img.isEmpty()) return;
      const dataUrl = img.toDataURL();
      const fingerprint = imageFingerprint(dataUrl);
      // 图片也没变化：完全跳过
      if (fingerprint === lastImageFingerprint) return;

      const now = moment().format("YYYY-MM-DD HH:mm:ss");
      try {
        // 超过体积上限的图片不入库，仅记录一条占位说明
        if (dataUrl.length > MAX_IMAGE_DATAURL_LENGTH) {
          await saveClipboardItem({
            text: "[图片过大，未保存]",
            html: "",
            image: "",
            rtf: "",
            bookmark: "",
            findText: "",
            now,
          });
        } else {
          await saveClipboardItem({
            text: "",
            html: "",
            image: dataUrl,
            rtf: "",
            bookmark: "",
            findText: "",
            now,
          });
        }
        lastImageFingerprint = fingerprint;
      } catch (err) {
        console.error("clipboard image insert error:", err);
      }
      return;
    }

    // 文本确为新内容，再读取重型格式并落库
    const html = clipboard.readHTML();
    const rtf = clipboard.readRTF();
    const bookmark = JSON.stringify(clipboard.readBookmark());
    const findText = clipboard.readFindText();

    try {
      const now = moment().format("YYYY-MM-DD HH:mm:ss");
      await saveClipboardItem({ text, html, image: "", rtf, bookmark, findText, now });
      lastClipboardText = text;
    } catch (err) {
      console.error("clipboard insert error:", err);
    }
  }, 1000);
}

/**
 * 备份与恢复 + 数据导出中心模块
 *
 * 功能：
 * 1. SQLite 数据库级备份：db.sqlite / userDb.sqlite 打包为 .jlbak 单文件（实为 zip）
 * 2. 恢复：恢复前自动创建安全备份 → 关闭连接 → 覆盖库文件 → 重开连接
 * 3. 自动备份：按配置间隔静默备份 + 保留份数自动清理
 * 4. 数据导出中心：按表导出 CSV / JSON（主进程直读库，大批量数据不过 IPC）
 *
 * 设计要点：
 * - 备份用 VACUUM INTO 生成一致快照，天然规避 WAL 侧车文件丢失数据问题
 * - 应用全部 KV 配置（basic_info 表）与业务数据都在 db.sqlite，一并覆盖
 * - electron-store（含加密密钥、fileCachePath）不参与备份：密钥属敏感数据，
 *   fileCachePath 应保持本机当前存储路径，避免恢复后路径错乱
 * - shiciDb（诗词资源库）随应用分发，为只读资源，不参与备份
 */
import { ipcMain, app, dialog, shell } from "electron";
import AdmZip from "adm-zip";
import fs from "node:fs";
import path from "node:path";
import moment from "moment";
import { store } from "./store.ts";
import { myDb, reopenNewSqlite } from "./newSql.ts";

/** 备份文件后缀（实为 zip 格式） */
const BACKUP_EXT = ".jlbak";
/** electron-store 中自动备份配置的键名 */
const AUTO_CONFIG_KEY = "backupAutoConfig";
/** 自动备份轮询间隔（30 分钟检查一次是否到点） */
const AUTO_CHECK_INTERVAL = 30 * 60 * 1000;

/** 参与备份的数据库清单（name 对应 newSql/oldSql 连接池键名，file 为缓存目录下的文件名） */
const BACKUP_DBS = [
  { name: "db", file: "db.sqlite" },
  { name: "userDb", file: "userDb.sqlite" },
];

/**
 * 导出中心的模块 → 表映射（与各模块文档对齐）
 * export:get-modules 时仅返回实际存在的表；未归组的表进入「其他」分组
 */
const EXPORT_GROUPS = [
  { key: "todo", label: "待办事项", tables: ["todo_list", "todo_tags"] },
  { key: "habit", label: "习惯打卡", tables: ["habit_def", "habit_checkin"] },
  { key: "note", label: "笔记", tables: ["note_book"] },
  { key: "accounting", label: "记账", tables: ["accounting_records", "accounting_categories", "accounting_keywords"] },
  { key: "pomodoro", label: "番茄钟", tables: ["pomodoro_status"] },
  { key: "clipboard", label: "剪贴板", tables: ["clipboard_history"] },
  { key: "reminder", label: "提醒", tables: ["reminders"] },
  { key: "weather", label: "天气", tables: ["weather_data"] },
  { key: "themeConversation", label: "主题对话", tables: ["conversation_theme", "conversation", "conversation_tag"] },
  { key: "colorPalette", label: "调色板", tables: ["color_palette", "color_favorite"] },
  { key: "netRequest", label: "网络请求", tables: ["net_request_history", "net_request_collection", "net_request_env"] },
  { key: "downloader", label: "下载器", tables: ["download_task"] },
  { key: "screenshot", label: "截图", tables: ["screenshots", "settings"] },
  { key: "flow", label: "流程图", tables: ["flow"] },
  { key: "basic", label: "应用配置", tables: ["basic_info"] },
];

/** 表名 → 中文标签映射（导出文件命名与展示用） */
const TABLE_LABELS: Record<string, string> = EXPORT_GROUPS.reduce((map, group) => {
  group.tables.forEach((t) => (map[t] = group.label));
  return map;
}, {} as Record<string, string>);

/**
 * 导出黑名单前缀：以这些前缀开头的表属于敏感加密模块（私密文件保险箱 fileVault），
 * 即便文件名已用 dataKey 加密，也不应在「数据导出中心」被批量枚举/导出，避免元数据外泄。
 * 注意：数据库级备份（.jlbak 整库快照）仍会包含这些表，但它们由口令派生的 KEK 保护
 * （wrapped_key/salt），无口令无法解开 dataKey，符合方案 A 的「强隐私」前提。
 */
const EXPORT_EXCLUDE_PREFIXES = ["file_vault_"];
function isExportExcluded(table: string): boolean {
  return EXPORT_EXCLUDE_PREFIXES.some((p) => table.startsWith(p));
}

/** 常见日期列名（用于导出时的日期范围过滤探测） */
const DATE_COLUMNS = ["create_time", "createTime", "created_at", "date", "updateTime"];

/** 自动备份配置接口 */
interface AutoBackupConfig {
  /** 是否启用自动备份 */
  enabled: boolean;
  /** 备份间隔（小时），默认 24 */
  intervalHours: number;
  /** 自动备份保留份数，超出自动清理最旧，默认 7 */
  keepCount: number;
  /** 上次自动备份时间戳（ms） */
  lastBackupAt: number;
}

/** 备份清单（存于 .jlbak 内 manifest.json） */
interface BackupManifest {
  /** 应用版本 */
  appVersion: string;
  /** 备份时间戳（ms） */
  createdAt: number;
  /** 备份时间文本 */
  createdAtText: string;
  /** 备份类型：manual 手动 / auto 自动 / safety 恢复前安全备份 */
  type: "manual" | "auto" | "safety";
  /** 用户备注 */
  note: string;
  /** 各库备份详情 */
  databases: {
    /** 库名 */
    name: string;
    /** 快照文件大小（字节） */
    size: number;
    /** 快照方式：vacuum 一致性快照 / copy 原始文件复制（含 WAL 侧车） */
    method: "vacuum" | "copy";
    /** 各表行数统计 */
    tables: { name: string; rows: number }[];
  }[];
}

/**
 * 获取数据库所在缓存目录（与 newSql/sql 的 createDBFile 逻辑保持一致）
 *
 * @returns {string} 数据库文件所在目录绝对路径
 */
function getCachePath(): string {
  return (store.get("fileCachePath") || app.getPath("documents")) as string;
}

/**
 * 获取备份文件存放目录（缓存目录下的「渐离App备份」子目录），不存在则自动创建
 *
 * @returns {string} 备份目录绝对路径
 */
function getBackupDir(): string {
  const dir = path.resolve(getCachePath(), "渐离App备份");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * 执行回调风格 SQL（SELECT 类查询）
 *
 * @param {any} db - SQLite 数据库连接
 * @param {string} sql - SQL 语句
 * @param {any[]} [params] - 参数数组
 * @returns {Promise<any[]>} 查询结果行数组；出错时抛出异常
 */
function dbAll(db: any, sql: string, params: any[] = []): Promise<any[]> {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err: any, rows: any[]) => (err ? reject(err) : resolve(rows || [])));
  });
}

/**
 * 执行回调风格 SQL（写语句）
 *
 * @param {any} db - SQLite 数据库连接
 * @param {string} sql - SQL 语句
 * @returns {Promise<void>} 执行完成时 resolve；出错时抛出异常
 */
function dbRun(db: any, sql: string): Promise<void> {
  return new Promise((resolve, reject) => {
    db.run(sql, (err: any) => (err ? reject(err) : resolve()));
  });
}

/**
 * 读取指定库的全部用户表名
 *
 * @param {any} db - SQLite 数据库连接
 * @returns {Promise<string[]>} 表名数组（排除 sqlite_ 内部表）
 */
async function getAllTables(db: any): Promise<string[]> {
  const rows = await dbAll(db, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
  return rows.map((r: any) => r.name);
}

/**
 * 读取指定表的行数
 *
 * @param {any} db - SQLite 数据库连接
 * @param {string} tableName - 表名
 * @returns {Promise<number>} 行数；表不存在时返回 0
 */
async function getTableRows(db: any, tableName: string): Promise<number> {
  try {
    const rows = await dbAll(db, `SELECT COUNT(*) AS count FROM "${tableName}"`);
    return rows[0]?.count || 0;
  } catch {
    return 0;
  }
}

/**
 * 探测指定表的日期列（用于导出日期范围过滤）
 *
 * @param {any} db - SQLite 数据库连接
 * @param {string} tableName - 表名
 * @returns {Promise<string|null>} 命中的日期列名；无则返回 null
 */
async function getDateColumn(db: any, tableName: string): Promise<string | null> {
  try {
    const cols = await dbAll(db, `SELECT * FROM pragma_table_info('${tableName}')`);
    const names: string[] = cols.map((c: any) => c.name);
    return DATE_COLUMNS.find((d) => names.includes(d)) || null;
  } catch {
    return null;
  }
}

/**
 * 对单个库创建一致性快照（VACUUM INTO）
 *
 * 优先走 VACUUM INTO（紧凑单文件、含 WAL 最新数据）；失败时降级为
 * 原始文件复制（连带 -wal / -shm 侧车），保证备份总不失败。
 *
 * @param {string} dbFile - 库文件名（如 db.sqlite）
 * @param {string} tmpSnapshotPath - 快照临时输出路径
 * @returns {Promise<{ size: number; method: "vacuum" | "copy"; extras: string[] }>} 快照结果：
 *          size 快照大小；method 快照方式；extras 降级复制时附带复制的侧车文件名列表
 */
async function snapshotDatabase(dbFile: string, tmpSnapshotPath: string): Promise<{ size: number; method: "vacuum" | "copy"; extras: string[] }> {
  const cachePath = getCachePath();
  const dbPath = path.resolve(cachePath, dbFile);
  const conn = myDb[dbFile.replace(".sqlite", "")];
  const escaped = tmpSnapshotPath.replace(/'/g, "''");

  // 优先尝试 VACUUM INTO 一致性快照
  if (conn) {
    try {
      await dbRun(conn, "PRAGMA wal_checkpoint(TRUNCATE);");
      await dbRun(conn, `VACUUM INTO '${escaped}';`);
      if (fs.existsSync(tmpSnapshotPath)) {
        return { size: fs.statSync(tmpSnapshotPath).size, method: "vacuum", extras: [] };
      }
    } catch (err) {
      console.error(`VACUUM INTO 失败（${dbFile}），降级为文件复制:`, err);
    }
  }

  // 降级：原始文件复制（连带 WAL 侧车，保证恢复时不丢数据）
  fs.copyFileSync(dbPath, tmpSnapshotPath);
  const extras: string[] = [];
  for (const suffix of ["-wal", "-shm"]) {
    const sidecar = dbPath + suffix;
    if (fs.existsSync(sidecar)) {
      extras.push(dbFile + suffix);
    }
  }
  return { size: fs.statSync(tmpSnapshotPath).size, method: "copy", extras };
}

/**
 * 收集指定库的表行数统计
 *
 * @param {string} dbFile - 库文件名（如 db.sqlite）
 * @returns {Promise<{ name: string; rows: number }[]>} 各表行数统计列表
 */
async function collectTableStats(dbFile: string): Promise<{ name: string; rows: number }[]> {
  const conn = myDb[dbFile.replace(".sqlite", "")];
  if (!conn) return [];
  try {
    const tables = await getAllTables(conn);
    const stats: { name: string; rows: number }[] = [];
    for (const t of tables) {
      stats.push({ name: t, rows: await getTableRows(conn, t) });
    }
    return stats;
  } catch (err) {
    console.error(`收集表统计失败（${dbFile}）:`, err);
    return [];
  }
}

/**
 * 创建备份
 *
 * 执行流程：生成各库快照 → 收集表统计写入 manifest → 打包 zip → 清理临时文件
 *
 * @param {Object} options - 备份参数
 * @param {"manual"|"auto"|"safety"} [options.type="manual"] - 备份类型
 * @param {string} [options.note=""] - 用户备注
 * @returns {Promise<{ ok: boolean; fileName?: string; filePath?: string; size?: number; manifest?: BackupManifest; error?: string }>}
 *          成功返回备份文件名/路径/大小/清单；失败返回 ok:false 与错误信息
 */
async function createBackup(options: { type?: "manual" | "auto" | "safety"; note?: string } = {}): Promise<{ ok: boolean; fileName?: string; filePath?: string; size?: number; manifest?: BackupManifest; error?: string }> {
  const { type = "manual", note = "" } = options;
  try {
    const backupDir = getBackupDir();
    const cachePath = getCachePath();
    const zip = new AdmZip();
    const manifest: BackupManifest = {
      appVersion: app.getVersion(),
      createdAt: Date.now(),
      createdAtText: moment().format("YYYY-MM-DD HH:mm:ss"),
      type,
      note,
      databases: [],
    };

    // 逐库生成快照并打包
    for (const target of BACKUP_DBS) {
      const dbPath = path.resolve(cachePath, target.file);
      if (!fs.existsSync(dbPath)) continue; // 库文件不存在则跳过

      const tmpSnapshot = path.resolve(backupDir, `_tmp_${Date.now()}_${target.file}`);
      try {
        const snap = await snapshotDatabase(target.file, tmpSnapshot);
        zip.addFile(target.file, fs.readFileSync(tmpSnapshot));
        // 降级复制模式：附带 WAL 侧车文件，恢复时一并还原
        for (const extra of snap.extras) {
          zip.addFile(extra, fs.readFileSync(path.resolve(cachePath, extra)));
        }
        manifest.databases.push({
          name: target.name,
          size: snap.size,
          method: snap.method,
          tables: await collectTableStats(target.file),
        });
      } finally {
        if (fs.existsSync(tmpSnapshot)) fs.rmSync(tmpSnapshot, { force: true });
      }
    }

    if (manifest.databases.length === 0) {
      return { ok: false, error: "未找到任何可备份的数据库文件" };
    }

    zip.addFile("manifest.json", Buffer.from(JSON.stringify(manifest, null, 2), "utf-8"));

    const typeLabel = type === "auto" ? "自动" : type === "safety" ? "安全" : "手动";
    const fileName = `渐离App备份_${typeLabel}_${moment().format("YYYY-MM-DD_HH-mm-ss")}${BACKUP_EXT}`;
    const filePath = path.resolve(backupDir, fileName);
    zip.writeZip(filePath);

    return { ok: true, fileName, filePath, size: fs.statSync(filePath).size, manifest };
  } catch (err: any) {
    console.error("创建备份失败:", err);
    return { ok: false, error: err?.message || String(err) };
  }
}

/**
 * 解析备份文件清单
 *
 * @param {string} filePath - .jlbak 备份文件绝对路径
 * @returns {BackupManifest|null} 备份清单；解析失败返回 null（文件损坏）
 */
function readManifest(filePath: string): BackupManifest | null {
  try {
    const zip = new AdmZip(filePath);
    const raw = zip.readAsText("manifest.json");
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * 列出备份目录中的全部备份文件（按时间倒序）
 *
 * @returns {{ fileName: string; filePath: string; size: number; manifest: BackupManifest | null }[]}
 *          备份列表：文件名/路径/大小/清单（损坏文件 manifest 为 null）
 */
function listBackups() {
  const backupDir = getBackupDir();
  const files = fs.readdirSync(backupDir).filter((f) => f.endsWith(BACKUP_EXT));
  return files
    .map((fileName) => {
      const filePath = path.resolve(backupDir, fileName);
      let size = 0;
      try {
        size = fs.statSync(filePath).size;
      } catch {}
      return { fileName, filePath, size, manifest: readManifest(filePath) };
    })
    .sort((a, b) => (b.manifest?.createdAt || 0) - (a.manifest?.createdAt || 0));
}

/**
 * 清理自动备份：仅保留最新 keepCount 份 auto 类型备份，超出删除最旧
 *
 * @param {number} keepCount - 保留份数
 * @returns {Promise<void>} 清理完成时 resolve
 */
async function cleanupAutoBackups(keepCount: number): Promise<void> {
  const autos = listBackups().filter((b) => b.manifest?.type === "auto");
  if (autos.length <= keepCount) return;
  const toDelete = autos.slice(keepCount);
  for (const item of toDelete) {
    try {
      fs.rmSync(item.filePath, { force: true });
    } catch (err) {
      console.error("清理自动备份失败:", item.fileName, err);
    }
  }
}

/**
 * 恢复备份
 *
 * 支持两种恢复来源：备份目录内的文件（fileName）或任意位置的 .jlbak 文件（filePath，
 * 用于恢复其他电脑/手动保存的备份）。安全流程：校验 zip → 恢复前自动安全备份 →
 * 解压到临时目录 → 关闭全部连接 → 覆盖库文件（并清理 WAL 侧车）→ 重开连接 →
 * 清理临时目录。恢复完成后建议重启应用（前端据 needRestart 提示）。
 *
 * @param {Object} options - 恢复参数（fileName 与 filePath 二选一）
 * @param {string} [options.fileName] - 备份文件名（位于备份目录内）
 * @param {string} [options.filePath] - 备份文件绝对路径（任意位置）
 * @returns {Promise<{ ok: boolean; needRestart?: boolean; manifest?: BackupManifest; error?: string }>}
 *          成功返回 needRestart:true 与原备份清单；失败返回 ok:false 与错误信息
 */
async function restoreBackup(options: { fileName?: string; filePath?: string }): Promise<{ ok: boolean; needRestart?: boolean; manifest?: BackupManifest; error?: string }> {
  try {
    let zipPath: string;
    if (options?.filePath) {
      // 方式二：任意位置的 .jlbak 文件（来自文件选择框，绝对路径）
      zipPath = path.resolve(options.filePath);
      if (!fs.existsSync(zipPath) || !zipPath.endsWith(BACKUP_EXT)) {
        return { ok: false, error: "备份文件不存在或不是 .jlbak 格式" };
      }
    } else if (options?.fileName) {
      // 方式一：备份目录内的文件（防路径穿越校验）
      const backupDir = getBackupDir();
      zipPath = path.resolve(backupDir, options.fileName);
      if (!zipPath.startsWith(backupDir) || !fs.existsSync(zipPath)) {
        return { ok: false, error: "备份文件不存在" };
      }
    } else {
      return { ok: false, error: "缺少备份文件参数" };
    }

    const zip = new AdmZip(zipPath);
    const manifest = readManifest(zipPath);
    if (!manifest) {
      return { ok: false, error: "备份文件损坏或不是有效的渐离App备份" };
    }
    const sqliteEntries = zip.getEntries().filter((e) => !e.isDirectory && e.entryName.endsWith(".sqlite"));
    if (sqliteEntries.length === 0) {
      return { ok: false, error: "备份文件中不包含数据库文件" };
    }

    // 1. 恢复前自动安全备份（尽力而为：当前库已损坏时仍继续恢复）
    const safety = await createBackup({ type: "safety", note: `恢复 ${path.basename(zipPath)} 前的自动安全备份` });
    if (!safety.ok) {
      console.warn("恢复前安全备份失败（继续恢复）:", safety.error);
    }

    // 2. 解压到临时目录
    const tmpDir = path.resolve(getBackupDir(), `_restore_tmp_${Date.now()}`);
    zip.extractAllTo(tmpDir, true);

    try {
      // 3. 关闭两个连接池的全部连接（释放文件句柄，Windows 下必须先关后覆盖）
      for (const pool of [myDb]) {
        for (const dbName of Object.keys(pool)) {
          const conn = pool[dbName];
          if (!conn) continue;
          try {
            await new Promise<void>((resolve) => conn.close(() => resolve()));
          } catch (err) {
            console.error("恢复时关闭连接失败:", dbName, err);
          }
        }
      }

      // 4. 覆盖库文件 + 清理 WAL 侧车（旧侧车与新库文件不匹配，必须删除）
      const cachePath = getCachePath();
      for (const entry of zip.getEntries()) {
        if (entry.isDirectory) continue;
        if (!entry.entryName.endsWith(".sqlite") && !entry.entryName.endsWith("-wal") && !entry.entryName.endsWith("-shm")) {
          continue;
        }
        fs.copyFileSync(path.resolve(tmpDir, entry.entryName), path.resolve(cachePath, entry.entryName));
      }
      for (const target of BACKUP_DBS) {
        if (!sqliteEntries.some((e) => e.entryName === target.file)) continue;
        for (const suffix of ["-wal", "-shm"]) {
          const sidecar = path.resolve(cachePath, target.file + suffix);
          if (fs.existsSync(sidecar)) fs.rmSync(sidecar, { force: true });
        }
      }

      // 5. 重开连接（单一连接池重连并恢复 WAL 模式）
      await reopenNewSqlite();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    return { ok: true, needRestart: true, manifest };
  } catch (err: any) {
    console.error("恢复备份失败:", err);
    return { ok: false, error: err?.message || String(err) };
  }
}

/**
 * 选择外部备份文件（主进程原生文件选择框，仅允许 .jlbak）
 *
 * 用于恢复其他电脑 / 手动保存的备份文件；选择后返回文件路径与清单预览，
 * 由前端展示确认后调用 backup:restore-path 执行恢复。
 *
 * @returns {Promise<{ ok: boolean; filePath?: string; manifest?: BackupManifest; error?: string }>}
 *          成功返回文件路径与清单；取消或文件无效返回 ok:false 与错误信息
 */
async function selectBackupFile(): Promise<{ ok: boolean; filePath?: string; manifest?: BackupManifest; error?: string }> {
  const result = dialog.showOpenDialogSync({
    title: "选择渐离App备份文件",
    filters: [{ name: "渐离App备份", extensions: ["jlbak"] }],
    properties: ["openFile"],
  });
  if (!result || result.length === 0) {
    return { ok: false, error: "未选择文件" };
  }
  const filePath = result[0];
  const manifest = readManifest(filePath);
  if (!manifest) {
    return { ok: false, error: "备份文件损坏或不是有效的渐离App备份" };
  }
  return { ok: true, filePath, manifest };
}

/**
 * 读取自动备份配置（缺省值：关闭 / 24 小时 / 保留 7 份）
 *
 * @returns {AutoBackupConfig} 自动备份配置
 */
function getAutoConfig(): AutoBackupConfig {
  const saved = store.get(AUTO_CONFIG_KEY) as Partial<AutoBackupConfig> | undefined;
  return {
    enabled: saved?.enabled ?? false,
    intervalHours: saved?.intervalHours ?? 24,
    keepCount: saved?.keepCount ?? 7,
    lastBackupAt: saved?.lastBackupAt ?? 0,
  };
}

/**
 * 保存自动备份配置（合并式更新）
 *
 * @param {Partial<AutoBackupConfig>} partial - 要更新的配置字段
 * @returns {AutoBackupConfig} 更新后的完整配置
 */
function setAutoConfig(partial: Partial<AutoBackupConfig>): AutoBackupConfig {
  const merged = { ...getAutoConfig(), ...partial };
  store.set(AUTO_CONFIG_KEY, merged);
  return merged;
}

/**
 * 自动备份到点检查：启用且距上次备份超过间隔时静默执行，并按保留份数清理
 *
 * @returns {Promise<void>} 检查完成时 resolve（未到点或未启用直接返回）
 */
async function autoBackupTick(): Promise<void> {
  try {
    const config = getAutoConfig();
    if (!config.enabled) return;
    if (Date.now() - config.lastBackupAt < config.intervalHours * 3600 * 1000) return;

    const result = await createBackup({ type: "auto", note: "自动备份" });
    if (result.ok) {
      setAutoConfig({ lastBackupAt: Date.now() });
      await cleanupAutoBackups(config.keepCount);
      console.log("自动备份完成:", result.fileName);
    } else {
      console.error("自动备份失败:", result.error);
    }
  } catch (err) {
    console.error("自动备份检查异常:", err);
  }
}

/**
 * 获取备份概况信息（各库状态 + 备份目录 + 自动备份配置 + 最近备份）
 *
 * @returns {Promise<{ ok: boolean; dbs?: any[]; backupDir?: string; autoConfig?: AutoBackupConfig; lastBackup?: any; error?: string }>}
 *          概况信息；失败返回 ok:false 与错误信息
 */
async function getBackupInfo() {
  try {
    const cachePath = getCachePath();
    const dbs = BACKUP_DBS.map((target) => {
      const dbPath = path.resolve(cachePath, target.file);
      let size = 0;
      let mtime = 0;
      let exists = fs.existsSync(dbPath);
      if (exists) {
        const stat = fs.statSync(dbPath);
        size = stat.size;
        mtime = stat.mtimeMs;
      }
      return { name: target.name, file: target.file, path: dbPath, exists, size, mtime };
    });
    const backups = listBackups();
    return {
      ok: true,
      dbs,
      backupDir: getBackupDir(),
      autoConfig: getAutoConfig(),
      lastBackup: backups[0] || null,
      backupCount: backups.length,
    };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}

/**
 * 获取导出中心模块清单（仅返回实际存在的表，附行数与日期列探测）
 *
 * @returns {Promise<{ ok: boolean; groups?: any[]; otherTables?: any[]; error?: string }>}
 *          groups 按模块归组的表清单；otherTables 未归组的其余表
 */
async function getExportModules() {
  try {
    const conn = myDb["db"];
    if (!conn) return { ok: false, error: "主数据库未初始化" };

    const allTables = await getAllTables(conn);
    const groupedNames = new Set(EXPORT_GROUPS.flatMap((g) => g.tables));

    const buildTableInfo = async (name: string) => ({
      name,
      label: TABLE_LABELS[name] || name,
      rows: await getTableRows(conn, name),
      hasDateColumn: (await getDateColumn(conn, name)) !== null,
    });

    const groups = [];
    for (const group of EXPORT_GROUPS) {
      const tables = [];
      for (const t of group.tables) {
        if (allTables.includes(t)) tables.push(await buildTableInfo(t));
      }
      if (tables.length > 0) groups.push({ key: group.key, label: group.label, tables });
    }

    const otherTables = [];
    for (const t of allTables) {
      // 导出黑名单：敏感加密模块表不进入导出中心枚举
      if (!groupedNames.has(t) && !isExportExcluded(t)) otherTables.push(await buildTableInfo(t));
    }

    return { ok: true, groups, otherTables };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}

/**
 * CSV 单元格序列化：对象转 JSON、超长内容截断、含分隔符时加引号转义
 *
 * @param {any} value - 单元格原始值
 * @returns {string} 序列化后的 CSV 单元格文本
 */
function csvCell(value: any): string {
  if (value === null || value === undefined) return "";
  let s = typeof value === "object" ? JSON.stringify(value) : String(value);
  // 超长内容截断（如剪贴板图片 base64），避免导出文件爆炸
  if (s.length > 50000) {
    s = s.slice(0, 200) + `…[已截断，原始长度 ${s.length} 字符]`;
  }
  if (/[",\r\n]/.test(s)) {
    s = '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

/**
 * JSON 行超长字符串截断（保留结构，防止 base64 大字段撑爆文件）
 *
 * @param {any} row - 行数据对象
 * @returns {any} 处理后的行数据
 */
function jsonRowTruncate(row: any): any {
  if (row === null || typeof row !== "object") return row;
  const out: any = Array.isArray(row) ? [] : {};
  for (const key of Object.keys(row)) {
    const val = row[key];
    if (typeof val === "string" && val.length > 200000) {
      out[key] = val.slice(0, 200) + `…[已截断，原始长度 ${val.length} 字符]`;
    } else {
      out[key] = val;
    }
  }
  return out;
}

/**
 * 执行数据导出
 *
 * 主进程直读库逐表导出（大批量数据不过 IPC）；每表一个文件，
 * 文件名为「中文标签_时间戳.格式」（无标签时用表名）。
 *
 * @param {Object} options - 导出参数
 * @param {string[]} options.tables - 要导出的表名列表
 * @param {"csv"|"json"} options.format - 导出格式
 * @param {string} [options.dateStart] - 日期范围起点（YYYY-MM-DD，需表存在日期列才生效）
 * @param {string} [options.dateEnd] - 日期范围终点（YYYY-MM-DD）
 * @param {string} options.saveDir - 导出目标目录
 * @returns {Promise<{ ok: boolean; files?: { table: string; label: string; path: string; rows: number }[]; error?: string }>}
 *          成功返回各表导出文件信息；失败返回 ok:false 与错误信息
 */
async function runExport(options: { tables: string[]; format: "csv" | "json"; dateStart?: string; dateEnd?: string; saveDir: string }) {
  const { tables, format, dateStart, dateEnd, saveDir } = options;
  try {
    if (!tables || tables.length === 0) return { ok: false, error: "请至少选择一个要导出的表" };
    if (!saveDir || !fs.existsSync(saveDir)) return { ok: false, error: "导出目录不存在" };

    const conn = myDb["db"];
    if (!conn) return { ok: false, error: "主数据库未初始化" };

    const stamp = moment().format("YYYY-MM-DD_HH-mm-ss");
    const files: { table: string; label: string; path: string; rows: number }[] = [];

    for (const table of tables) {
      // 表名来自本模块 getExportModules 动态枚举，仍做白名单校验防注入
      const allTables = await getAllTables(conn);
      if (!allTables.includes(table)) continue;
      // 导出黑名单：拒绝敏感加密模块表（私密文件保险箱）
      if (isExportExcluded(table)) {
        console.warn(`导出被拒绝：表 ${table} 属于敏感加密模块，不在数据导出范围内`);
        continue;
      }

      // 日期范围过滤（仅当表存在日期列且用户填了范围）
      const dateColumn = await getDateColumn(conn, table);
      const whereParts: string[] = [];
      const params: any[] = [];
      if (dateColumn && dateStart) {
        whereParts.push(`"${dateColumn}" >= ?`);
        params.push(dateStart);
      }
      if (dateColumn && dateEnd) {
        whereParts.push(`"${dateColumn}" <= ?`);
        params.push(dateEnd + " 23:59:59");
      }
      const whereSql = whereParts.length > 0 ? ` WHERE ${whereParts.join(" AND ")}` : "";
      const rows = await dbAll(conn, `SELECT * FROM "${table}"${whereSql}`, params);

      const label = TABLE_LABELS[table] || table;
      const fileBase = `${label}_${stamp}`;

      if (format === "json") {
        const payload = {
          table,
          label,
          exportedAt: moment().format("YYYY-MM-DD HH:mm:ss"),
          count: rows.length,
          rows: rows.map(jsonRowTruncate),
        };
        const filePath = path.resolve(saveDir, `${fileBase}.json`);
        fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf-8");
        files.push({ table, label, path: filePath, rows: rows.length });
      } else {
        // CSV：表头取全行键的并集（顺序稳定：首个非空行的键优先）
        const headerOrder: string[] = [];
        for (const row of rows) {
          for (const key of Object.keys(row)) {
            if (!headerOrder.includes(key)) headerOrder.push(key);
          }
        }
        const lines = [headerOrder.map(csvCell).join(",")];
        for (const row of rows) {
          lines.push(headerOrder.map((key) => csvCell(row[key])).join(","));
        }
        // BOM 头：保证 Excel 打开中文不乱码
        const filePath = path.resolve(saveDir, `${fileBase}.csv`);
        fs.writeFileSync(filePath, "\uFEFF" + lines.join("\r\n"), "utf-8");
        files.push({ table, label, path: filePath, rows: rows.length });
      }
    }

    return { ok: true, files };
  } catch (err: any) {
    console.error("数据导出失败:", err);
    return { ok: false, error: err?.message || String(err) };
  }
}

/**
 * 初始化备份与导出模块：注册全部 IPC 通道，并启动自动备份定时检查
 *
 * 注册的通道：
 * - backup:get-info 备份概况 / backup:create 创建备份 / backup:list 备份列表
 * - backup:restore 恢复 / backup:delete 删除 / backup:open-dir 打开备份目录
 * - backup:get-auto-config / backup:set-auto-config 自动备份配置
 * - export:get-modules 导出清单 / export:select-dir 选择目录 / export:run 执行导出
 *
 * @returns {void}
 */
export function initBackup() {
  // 备份概况
  ipcMain.handle("backup:get-info", async () => getBackupInfo());

  // 创建备份
  ipcMain.handle("backup:create", async (_e, params: { note?: string } = {}) => {
    const result = await createBackup({ type: "manual", note: params?.note || "" });
    if (result.ok) {
      // 手动备份后同步刷新自动备份时间戳，避免刚备份完又触发自动备份
      const config = getAutoConfig();
      if (config.enabled) setAutoConfig({ lastBackupAt: Date.now() });
    }
    return result;
  });

  // 备份列表
  ipcMain.handle("backup:list", async () => listBackups());

  // 恢复备份（fileName=备份目录内文件名 / filePath=任意位置 .jlbak 绝对路径，二选一）
  ipcMain.handle("backup:restore", async (_e, params: { fileName?: string; filePath?: string }) =>
    restoreBackup(params || {})
  );

  // 选择外部备份文件（返回路径与清单预览，前端确认后调 backup:restore-path）
  ipcMain.handle("backup:select-backup-file", async () => selectBackupFile());

  // 按绝对路径恢复（配合 backup:select-backup-file 使用）
  ipcMain.handle("backup:restore-path", async (_e, params: { filePath: string }) =>
    restoreBackup({ filePath: params?.filePath })
  );

  // 删除备份
  ipcMain.handle("backup:delete", async (_e, params: { fileName: string }) => {
    try {
      const backupDir = getBackupDir();
      const filePath = path.resolve(backupDir, params?.fileName || "");
      if (!filePath.startsWith(backupDir) || !fs.existsSync(filePath)) {
        return { ok: false, error: "备份文件不存在" };
      }
      fs.rmSync(filePath, { force: true });
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  // 在资源管理器中打开备份目录
  ipcMain.handle("backup:open-dir", async () => {
    shell.openPath(getBackupDir());
    return { ok: true };
  });

  // 自动备份配置读写
  ipcMain.handle("backup:get-auto-config", async () => getAutoConfig());
  ipcMain.handle("backup:set-auto-config", async (_e, partial: Partial<AutoBackupConfig>) => setAutoConfig(partial || {}));

  // 导出中心：模块清单 / 目录选择 / 执行导出
  ipcMain.handle("export:get-modules", async () => getExportModules());
  ipcMain.handle("export:select-dir", async () => {
    const result = dialog.showOpenDialogSync({
      title: "选择导出目录",
      properties: ["openDirectory", "createDirectory"],
    });
    return result && result.length > 0 ? result[0] : null;
  });
  ipcMain.handle("export:run", async (_e, params: { tables: string[]; format: "csv" | "json"; dateStart?: string; dateEnd?: string; saveDir: string }) =>
    runExport(params || ({} as any))
  );

  // 自动备份：启动 10 秒后首检（错开启动高峰），之后每 30 分钟轮询一次
  setTimeout(autoBackupTick, 10 * 1000);
  setInterval(autoBackupTick, AUTO_CHECK_INTERVAL);
}

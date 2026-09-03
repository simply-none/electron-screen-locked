/**
 * 私密文件保险箱模块（主进程入口）
 * ------------------------------------------------------------------
 * 复用项目统一安全架构（AES-256-GCM + PBKDF2，见 ./vault/crypto.ts）：
 * - 维护「内存数据密钥」dataKey（随机 32 字节），仅会话期驻留主进程内存；
 * - 口令 → KEK(PBKDF2) → 加密 wrap 数据密钥，wrappedKey + salt 落库；
 * - 每个文件用 dataKey 加密，密文落独立目录（文件名随机 uuid，无真实名泄露）；
 *   文件名（方案 A 强隐私）也用 dataKey 加密，库里只存密文。
 *
 * 安全红线（对齐全局约定 + 密码保险库实践）：
 * - 明文文件内容绝不写应用数据库（newSql / basic_info 只读写 vault 配置与脱敏元数据）；
 * - dataKey / 口令仅驻留内存，lock 时清零；
 * - 预览先解密到临时目录、用完即清（lock / 关闭预览调用 cleanup-temp）。
 *
 * ⚠️ 改动本文件后必须重启 Electron 才生效。
 */
import { ipcMain, dialog, app } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { query, upsert, del, ensureTableExists } from './newSql.ts';
import { store } from './store.ts';
import { encryptBytes, decryptBytes, deriveKey } from './vault/crypto.ts';

const CONFIG_KEY = 'vault';
const CONFIG_TABLE = 'file_vault_config';
const FILES_TABLE = 'file_vault_files';
const CIPHER_EXT = '.jlv';
/** .jlv 自描述格式魔数：iv(12)+ct 之前嵌入原始文件名与扩展名，解决「解密后文件名为未命名」 */
const JLV_MAGIC = 'JLV1';

/** 主进程内存态：数据密钥 + 口令（lock 时清零） */
let dataKey: Buffer | null = null;
let vaultPass: string | null = null;

interface VaultConfig {
  salt: string; // base64
  wrappedKey: string; // base64（iv(12) + 密文+tag）
  version: number;
}

function getCachePath(): string {
  return (store.get('fileCachePath') || app.getPath('documents')) as string;
}

/** 密文目录（独立于 DB，文件过大不进 SQLite） */
function vaultDir(): string {
  const d = path.resolve(getCachePath(), '渐离App保险箱');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** 预览临时目录（用完即清） */
function tempDir(): string {
  const d = path.resolve(app.getPath('temp'), '渐离App保险箱预览');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** 导入解密临时目录（用完即清） */
function importDecryptTempDir(): string {
  const d = path.resolve(app.getPath('temp'), '渐离App保险箱导入解密');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** 根据文件头魔数推断扩展名（.jlv 不含类型信息，用于预览与默认文件名） */
function guessExt(buf: Buffer): string {
  if (buf.length >= 4) {
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return '.png';
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg';
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return '.gif';
    if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return '.pdf';
    if (buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) return '.zip';
    if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return '.mp3';
  }
  return '.bin';
}

/**
 * 解析 .jlv 密文，兼容两种格式：
 *  - 新格式（自描述）：`JLV1`(4B) + metaLen(uint32 BE, 4B) + JSON元数据({"name","ext"}) + iv(12B) + ct；
 *  - 旧格式（历史数据，文件名只在库里）：直接 iv(12B) + ct。
 * 返回解密所需的 iv/ct，以及嵌入的原始文件名/扩展名（旧格式为 null）。
 */
function parseCipher(buf: Buffer): { name: string | null; ext: string | null; iv: string; ct: string } {
  if (buf.length >= 8 && buf.toString('latin1', 0, 4) === JLV_MAGIC) {
    const metaLen = buf.readUInt32BE(4);
    let name: string | null = null;
    let ext: string | null = null;
    if (buf.length >= 8 + metaLen && metaLen > 0) {
      try {
        const meta = JSON.parse(buf.toString('utf8', 8, 8 + metaLen));
        if (meta && typeof meta === 'object') {
          if (typeof meta.name === 'string') name = meta.name;
          if (typeof meta.ext === 'string') ext = meta.ext;
        }
      } catch {
        /* 元数据损坏则忽略，按无名字处理 */
      }
    }
    const payload = buf.subarray(8 + metaLen);
    return { name, ext, iv: payload.subarray(0, 12).toString('base64'), ct: payload.subarray(12).toString('base64') };
  }
  // 旧格式：前 12 字节即 iv
  return { name: null, ext: null, iv: buf.subarray(0, 12).toString('base64'), ct: buf.subarray(12).toString('base64') };
}

/** 拼接新格式 .jlv 头部（魔数 + 元数据长度 + JSON 元数据） */
function buildJlvHeader(name: string, ext: string): Buffer {
  const meta = Buffer.from(JSON.stringify({ name, ext }), 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(meta.length);
  return Buffer.concat([Buffer.from(JLV_MAGIC, 'latin1'), len, meta]);
}

async function getConfig(): Promise<VaultConfig | null> {
  try {
    const rows = await query({ tableName: CONFIG_TABLE, conditions: { key: CONFIG_KEY } });
    if (!rows || !rows.length) return null;
    return JSON.parse(rows[0].value) as VaultConfig;
  } catch {
    return null;
  }
}

async function saveConfig(cfg: VaultConfig): Promise<void> {
  await upsert({ tableName: CONFIG_TABLE, data: { key: CONFIG_KEY, value: JSON.stringify(cfg) }, config: { primaryKey: 'key' } });
}

/** 方案 A：文件名用 dataKey 加密后存库 */
function encryptName(name: string): string {
  const e = encryptBytes(Buffer.from(name, 'utf8'), dataKey!);
  return Buffer.concat([Buffer.from(e.iv, 'base64'), Buffer.from(e.ct, 'base64')]).toString('base64');
}
function decryptName(b64: string): string {
  const buf = Buffer.from(b64, 'base64');
  const iv = buf.subarray(0, 12).toString('base64');
  const ct = buf.subarray(12).toString('base64');
  return decryptBytes({ iv, ct }, dataKey!).toString('utf8');
}

/** 安全删除：随机覆盖一遍后 unlink（个人保险箱场景下的尽力而为，加大 casual 恢复难度） */
function secureDeleteFile(p: string): boolean {
  try {
    const st = fs.statSync(p);
    if (st.isFile()) {
      const size = st.size;
      const fh = fs.openSync(p, 'r+');
      try {
        const unit = 1024 * 1024; // 1MB 分块覆盖，避免大文件一次性占内存
        let written = 0;
        while (written < size) {
          const remain = size - written;
          const n = Math.min(unit, remain);
          fs.writeSync(fh, crypto.randomBytes(n), 0, n, written);
          written += n;
        }
      } finally {
        fs.closeSync(fh);
      }
    }
    fs.unlinkSync(p);
    return true;
  } catch {
    return false;
  }
}

function mimeFromExt(ext: string): string {
  const map: Record<string, string> = {
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.json': 'application/json',
    '.csv': 'text/csv',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.zip': 'application/zip',
    '.rar': 'application/x-rar-compressed',
    '.7z': 'application/x-7z-compressed',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.key': 'application/octet-stream',
    '.pem': 'application/x-pem-file',
  };
  return map[ext.toLowerCase()] || 'application/octet-stream';
}

export function initFileVault() {
  // 确保表结构（主键类型 TEXT，避免自增 id 冲突）
  ensureTableExists(CONFIG_TABLE, ['value'], 'key', { primaryKeyType: 'TEXT' });
  ensureTableExists(
    FILES_TABLE,
    ['name', 'mime', 'ext', 'size', 'ciphertext_path', 'created_at'],
    'id',
    { primaryKeyType: 'TEXT' },
  );

  /** 首次设置口令：生成 dataKey → 派生 KEK → wrap 落库 */
  ipcMain.handle('file-vault:set-password', async (_e, { password }: { password: string }) => {
    if (await getConfig()) return { ok: false, error: '保险库已初始化，请先解锁' };
    try {
      const dk = crypto.randomBytes(32);
      const salt = crypto.randomBytes(16);
      const kek = deriveKey(password, salt);
      const w = encryptBytes(dk, kek);
      const wrappedKey = Buffer.concat([Buffer.from(w.iv, 'base64'), Buffer.from(w.ct, 'base64')]).toString('base64');
      await saveConfig({ salt: salt.toString('base64'), wrappedKey, version: 1 });
      dataKey = dk;
      vaultPass = password;
      return { ok: true, hasVault: true };
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  /** 解锁：派生 KEK → 解 wrap；口令错则 GCM 认证失败 */
  ipcMain.handle('file-vault:unlock', async (_e, { password }: { password: string }) => {
    const cfg = await getConfig();
    if (!cfg) return { ok: false, error: '保险库未初始化，请先设置口令' };
    try {
      const salt = Buffer.from(cfg.salt, 'base64');
      const kek = deriveKey(password, salt);
      const wrapped = Buffer.from(cfg.wrappedKey, 'base64');
      const iv = wrapped.subarray(0, 12).toString('base64');
      const ct = wrapped.subarray(12).toString('base64');
      const dk = decryptBytes({ iv, ct }, kek); // 口令错误会在此抛错
      dataKey = dk;
      vaultPass = password;
      return { ok: true, hasVault: true, isUnlocked: true };
    } catch {
      return { ok: false, error: '口令错误' };
    }
  });

  /** 锁定：清空内存中的密钥与口令，并清理预览临时目录 */
  ipcMain.handle('file-vault:lock', async () => {
    dataKey = null;
    vaultPass = null;
    try {
      fs.rmSync(tempDir(), { recursive: true, force: true });
    } catch {
      /* 忽略清理失败 */
    }
    return { ok: true };
  });

  /** 查询状态：是否已建库 / 是否解锁 */
  ipcMain.handle('file-vault:status', async () => {
    const cfg = await getConfig();
    return { ok: true, hasVault: !!cfg, isUnlocked: !!dataKey };
  });

  /** 列出文件元数据（解锁后主进程用 dataKey 解密文件名；锁定态返回错误） */
  ipcMain.handle('file-vault:list', async () => {
    if (!dataKey) return { ok: false, error: '未解锁' };
    const rows: any[] = await query({ tableName: FILES_TABLE, orderBy: 'created_at', orderByDesc: true });
    const files = (rows || []).map((r) => ({
      id: r.id,
      name: decryptName(r.name),
      mime: r.mime,
      ext: r.ext,
      size: Number(r.size || 0),
      createdAt: r.created_at,
    }));
    return { ok: true, files };
  });

  /** 原生对话框：选择要加密的文件（支持多选） */
  ipcMain.handle('file-vault:pick-import', async () => {
    const r = dialog.showOpenDialogSync({
      title: '选择要加密的文件',
      properties: ['openFile', 'multiSelections'],
    });
    return r && r.length ? r : null;
  });

  /** 加密导入：读源文件 → 加密落盘 → 写脱敏元数据（原文件名加密存储）；按 deleteSource 安全删除原文件 */
  ipcMain.handle(
    'file-vault:import',
    async (_e, { sourcePath, name, deleteSource }: { sourcePath: string; name?: string; deleteSource?: boolean }) => {
      if (!dataKey) return { ok: false, error: '未解锁' };
      try {
        const buf = fs.readFileSync(sourcePath);
        const displayName = name || path.basename(sourcePath);
        const ext = path.extname(sourcePath);
        const e = encryptBytes(buf, dataKey);
        const id = crypto.randomUUID();
        const cipherPath = path.resolve(vaultDir(), id + CIPHER_EXT);
        // 自描述格式：头部嵌入原始文件名+扩展名，便于「右键解密 .jlv」时还原文件名（旧 .jlv 仅有 iv+ct 无名字）
        const header = buildJlvHeader(displayName, ext);
        const payload = Buffer.concat([Buffer.from(e.iv, 'base64'), Buffer.from(e.ct, 'base64')]);
        fs.writeFileSync(cipherPath, Buffer.concat([header, payload]));
        const row = {
          id,
          name: encryptName(displayName),
          mime: mimeFromExt(ext),
          ext,
          size: buf.length,
          ciphertext_path: cipherPath,
          created_at: new Date().toISOString(),
        };
        await upsert({ tableName: FILES_TABLE, data: row, config: { primaryKey: 'id' } });
        // 加密副本已落盘，按用户选择安全删除原文件（避免明文原文件残留在原位置）
        let sourceDeleted = false;
        if (deleteSource) sourceDeleted = secureDeleteFile(sourcePath);
        return {
          ok: true,
          file: { id, name: displayName, mime: row.mime, ext, size: row.size, createdAt: row.created_at },
          sourceDeleted,
        };
      } catch (err: any) {
        return { ok: false, error: err?.message || String(err) };
      }
    },
  );

  /** 原生对话框：选择导出目录 */
  ipcMain.handle('file-vault:pick-export-dir', async () => {
    const r = dialog.showOpenDialogSync({
      title: '选择导出目录',
      properties: ['openDirectory', 'createDirectory'],
    });
    return r && r.length ? r[0] : null;
  });

  /** 解密导出到目标目录 */
  ipcMain.handle(
    'file-vault:export',
    async (_e, { id, destDir }: { id: string; destDir: string }) => {
      if (!dataKey) return { ok: false, error: '未解锁' };
      try {
        const rows: any[] = await query({ tableName: FILES_TABLE, conditions: { id } });
        if (!rows || !rows.length) return { ok: false, error: '文件不存在' };
        const r = rows[0];
        const enc = fs.readFileSync(r.ciphertext_path);
        const { iv, ct } = parseCipher(enc);
        const plain = decryptBytes({ iv, ct }, dataKey);
        const outName = `${decryptName(r.name)}${r.ext || ''}`;
        const outPath = path.resolve(destDir, outName);
        fs.writeFileSync(outPath, plain);
        return { ok: true, path: outPath };
      } catch (err: any) {
        return { ok: false, error: err?.message || String(err) };
      }
    },
  );

  /** 解密到临时目录供预览，返回临时路径（渲染端用 jlocal 协议展示） */
  ipcMain.handle('file-vault:decrypt-temp', async (_e, { id }: { id: string }) => {
    if (!dataKey) return { ok: false, error: '未解锁' };
    try {
      const rows: any[] = await query({ tableName: FILES_TABLE, conditions: { id } });
      if (!rows || !rows.length) return { ok: false, error: '文件不存在' };
      const r = rows[0];
      const enc = fs.readFileSync(r.ciphertext_path);
      const { iv, ct } = parseCipher(enc);
      const plain = decryptBytes({ iv, ct }, dataKey);
      const outName = `${crypto.randomUUID()}_${decryptName(r.name)}${r.ext || ''}`;
      const outPath = path.resolve(tempDir(), outName);
      fs.writeFileSync(outPath, plain);
      return { ok: true, tempPath: outPath, mime: r.mime };
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  /** 清理预览临时目录（关闭预览 / 锁定时调用；按 id 难以精确匹配随机名，故清空整目录） */
  ipcMain.handle('file-vault:cleanup-temp', async () => {
    try {
      fs.rmSync(tempDir(), { recursive: true, force: true });
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  /** 删除：删元数据 + 删密文 */
  ipcMain.handle('file-vault:delete', async (_e, { id }: { id: string }) => {
    if (!dataKey) return { ok: false, error: '未解锁' };
    try {
      const rows: any[] = await query({ tableName: FILES_TABLE, conditions: { id } });
      if (rows && rows.length) {
        try {
          fs.rmSync(rows[0].ciphertext_path, { force: true });
        } catch {
          /* 忽略 */
        }
      }
      await del({ tableName: FILES_TABLE, condition: { id } });
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  /** 原生对话框：选择要解密的 .jlv 文件（多选） */
  ipcMain.handle('file-vault:pick-import-decrypt', async () => {
    const r = dialog.showOpenDialogSync({
      title: '选择要解密的文件（.jlv）',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '加密文件', extensions: ['jlv'] }],
    });
    return r && r.length ? r : null;
  });

  /** 导入解密：要求已解锁；读 .jlv → 解密到临时目录，明文不过 IPC（避免大文件占用通道） */
  ipcMain.handle('file-vault:import-decrypt', async (_e, { sourcePath }: { sourcePath: string }) => {
    if (!dataKey) return { ok: false, error: '未解锁' };
    try {
      const buf = fs.readFileSync(sourcePath);
      if (buf.length < 12 + 16) return { ok: false, error: '文件不是有效的加密文件' };
      const { name, ext: embeddedExt, iv, ct } = parseCipher(buf);
      const plain = decryptBytes({ iv, ct }, dataKey); // 非本保险箱会抛错（GCM 认证失败）
      const ext = embeddedExt || guessExt(plain);
      const outName = `${crypto.randomUUID()}${ext}`;
      const outPath = path.resolve(importDecryptTempDir(), outName);
      fs.writeFileSync(outPath, plain);
      return { ok: true, tempPath: outPath, ext, name: name ?? undefined };
    } catch {
      return { ok: false, error: '解密失败：该文件不属于当前保险箱或已损坏' };
    }
  });

  /** 导入解密（字节通道）：渲染端读文件字节后传入，主进程用 dataKey 解密并写临时文件。
   *  用于渲染端拿不到本地文件路径的环境（如打包后 file:// 页面拖拽，Chromium 安全限制导致 File.path 为空），
   *  彻底绕开 File.path 依赖。buffer 经 IPC 结构化克隆（小/中文件安全；超大文件建议用「选择 .jlv」按钮走路径通道）。 */
  ipcMain.handle(
    'file-vault:import-decrypt-bytes',
    async (_e, { name, buffer }: { name: string; buffer: ArrayBuffer | Buffer | Uint8Array }) => {
      if (!dataKey) return { ok: false, error: '未解锁' };
      try {
        const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer as ArrayBuffer);
        if (buf.length < 12 + 16) return { ok: false, error: '文件不是有效的加密文件' };
        const { name: embeddedName, ext: embeddedExt, iv, ct } = parseCipher(buf);
        const plain = decryptBytes({ iv, ct }, dataKey); // 非本保险箱会抛错（GCM 认证失败）
        const ext = embeddedExt || guessExt(plain);
        // 优先用 .jlv 内嵌的原始文件名；无内嵌（旧格式）时回退到拖入文件的显示名（去 .jlv）
        const base = (name || '').replace(/\.jlv$/i, '');
        const finalName = embeddedName || base || null;
        const outName = `${crypto.randomUUID()}_${base}${ext}`;
        const outPath = path.resolve(importDecryptTempDir(), outName);
        fs.writeFileSync(outPath, plain);
        return { ok: true, tempPath: outPath, ext, name: finalName ?? undefined };
      } catch {
        return { ok: false, error: '解密失败：该文件不属于当前保险箱或已损坏' };
      }
    },
  );

  /** 把解密后的临时明文另存到目标目录（主进程落盘，守安全边界；文件名做防穿越清洗） */
  ipcMain.handle(
    'file-vault:save-plain',
    async (_e, { tempPath, destDir, name }: { tempPath: string; destDir: string; name: string }) => {
      try {
        const safeName = (name || '').replace(/[\\/:*?"<>|]/g, '_').trim() || 'decrypted-file';
        const outPath = path.resolve(destDir, safeName);
        fs.copyFileSync(tempPath, outPath);
        return { ok: true, path: outPath };
      } catch (err: any) {
        return { ok: false, error: err?.message || String(err) };
      }
    },
  );

  /** 清理导入解密临时目录 */
  ipcMain.handle('file-vault:cleanup-import-decrypt', async () => {
    try {
      fs.rmSync(importDecryptTempDir(), { recursive: true, force: true });
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  /** 安全删除（碎纸机）：随机覆盖 + unlink，无需解锁；供资源管理器右键「安全删除」调用 */
  ipcMain.handle('file-vault:secure-delete', async (_e, { paths }: { paths: string[] }) => {
    let deleted = 0;
    for (const p of paths || []) {
      if (secureDeleteFile(p)) deleted++;
    }
    return { ok: true, deleted };
  });
}

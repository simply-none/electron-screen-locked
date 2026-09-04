/**
 * 2FA 动态验证码模块（主进程入口）
 * ------------------------------------------------------------------
 * 职责：
 * - 维护「内存保险库」：解密后的账户明文（含 secret），仅会话期驻留主进程内存；
 * - 提供 IPC：导入 / 新建 / 列出 / 取码 / 增删改 / 导出 / 生成 otpauth URI / 关闭；
 * - 文件选择走原生 dialog（打开 / 保存）。
 *
 * 安全红线（对齐全局约定）：
 * - 密钥绝不写应用数据库（newSql / basic_info 只读写非机密的「上次路径」偏好）；
 * - get-codes 只回传 code / nextCode / remaining，绝不回传 secret；
 * - otpauth URI 仅在用户主动“生成二维码”时构造返回（含密钥，仅用于展示/迁移）。
 *
 * ⚠️ 改动本文件后必须重启 Electron 才生效。
 */
import { ipcMain, dialog } from 'electron';
import crypto from 'node:crypto';
import { query, upsert } from './newSql.ts';
import { tableName } from './store.ts';
import { readVaultFile, writeVaultFile } from './twoFactor/vault.ts';
import { generateTotp, generateTotpWithMeta, buildOtpauthUri, randomBase32Secret, verifyTotpCode } from './twoFactor/otp.ts';
import { win } from './mainWindow.ts';
import type { TwoFactorAccount, TwoFactorAccountMeta } from './twoFactor/types.ts';

/** basic_info 中记录“上次保险库路径”的键（非机密偏好） */
const LAST_PATH_KEY = 'twoFactorVaultPath';

let vault: TwoFactorAccount[] | null = null;
let vaultPath: string | null = null;
/** 仅会话期驻留内存，用于回写加密文件；与解密后的密钥一起在 close 时清空 */
let vaultPass: string | null = null;

/** 剔除 secret，生成返回给渲染端的脱敏元数据 */
function toMeta(a: TwoFactorAccount): TwoFactorAccountMeta {
  const { secret, ...rest } = a;
  return rest;
}

async function getLastPath(): Promise<string | null> {
  try {
    const data = await query({ tableName, conditions: { key: LAST_PATH_KEY } });
    return data && data.length ? (data[0].value as string) : null;
  } catch {
    return null;
  }
}

async function setLastPath(path: string): Promise<void> {
  try {
    await upsert({ tableName, data: { key: LAST_PATH_KEY, value: path }, config: { primaryKey: 'key' } });
  } catch (err) {
    console.error('[twoFactor] 记录上次保险库路径失败:', err);
  }
}

/** 把内存保险库以当前口令加密回写文件（增删改后调用） */
function safeWriteBack(): { ok: boolean; error?: string } {
  if (!vault || !vaultPath || !vaultPass) return { ok: false, error: '保险库未就绪' };
  try {
    writeVaultFile(vaultPath, vault, vaultPass);
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}

export function initTwoFactor() {
  // 选择现有保险库文件
  ipcMain.handle('two-factor:pick-open', async () => {
    const r = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: '2FA 保险库', extensions: ['jwq', 'json', 'txt'] }],
    });
    return r.canceled ? null : r.filePaths[0];
  });

  // 选择导出 / 保存路径
  ipcMain.handle('two-factor:pick-save', async (_e, defaultName = '2fa-vault') => {
    const r = await dialog.showSaveDialog({
      defaultPath: `${defaultName}.json`,
      filters: [{ name: '2FA 保险库', extensions: ['json'] }],
    });
    return r.canceled ? null : r.filePath;
  });

  // 导入并解密保险库
  ipcMain.handle(
    'two-factor:open-vault',
    async (_e, { filePath, passphrase }: { filePath: string; passphrase: string }) => {
      try {
        const accounts = readVaultFile(filePath, passphrase);
        vault = accounts;
        vaultPath = filePath;
        vaultPass = passphrase;
        await setLastPath(filePath);
        return { ok: true, accounts: vault.map(toMeta) };
      } catch {
        return { ok: false, error: '解密失败：口令错误或文件损坏' };
      }
    },
  );

  // 新建保险库（可含初始账户）
  ipcMain.handle(
    'two-factor:create-vault',
    async (_e, { filePath, passphrase, accounts = [] }: { filePath: string; passphrase: string; accounts?: TwoFactorAccount[] }) => {
      try {
        writeVaultFile(filePath, accounts, passphrase);
        vault = accounts;
        vaultPath = filePath;
        vaultPass = passphrase;
        await setLastPath(filePath);
        return { ok: true, accounts: vault.map(toMeta) };
      } catch (err: any) {
        return { ok: false, error: err?.message || String(err) };
      }
    },
  );

  // 当前状态 + 账户列表（脱敏）
  ipcMain.handle('two-factor:list', async () => {
    return {
      ok: true,
      hasVault: !!vault,
      vaultPath,
      lastPath: await getLastPath(),
      accounts: (vault || []).map(toMeta),
    };
  });

  // 生成全部验证码（仅回传 code / nextCode / remaining，不回传 secret）
  ipcMain.handle('two-factor:get-codes', async () => {
    if (!vault) return { ok: false, error: '未导入保险库' };
    const codes = vault.map((a) => ({
      key: a.key,
      ...generateTotpWithMeta(a.secret, { algorithm: a.algorithm, digits: a.digits, period: a.period }),
    }));
    return { ok: true, codes };
  });

  // 新增账户（回写文件）
  ipcMain.handle(
    'two-factor:add-account',
    async (_e, { input }: { input: Omit<TwoFactorAccount, 'key' | 'createdAt' | 'updatedAt'> }) => {
      if (!vault) return { ok: false, error: '请先导入或新建保险库' };
      const now = new Date().toISOString();
      const acc: TwoFactorAccount = { key: crypto.randomUUID(), createdAt: now, updatedAt: now, ...input };
      vault.push(acc);
      const wb = safeWriteBack();
      if (!wb.ok) return { ok: false, error: wb.error };
      return { ok: true, account: toMeta(acc) };
    },
  );

  // 编辑账户（回写文件）
  ipcMain.handle(
    'two-factor:update-account',
    async (_e, { key, patch }: { key: string; patch: Partial<TwoFactorAccount> }) => {
      if (!vault) return { ok: false, error: '请先导入或新建保险库' };
      const idx = vault.findIndex((a) => a.key === key);
      if (idx === -1) return { ok: false, error: '账户不存在' };
      vault[idx] = { ...vault[idx], ...patch, key, updatedAt: new Date().toISOString() };
      const wb = safeWriteBack();
      if (!wb.ok) return { ok: false, error: wb.error };
      return { ok: true, account: toMeta(vault[idx]) };
    },
  );

  // 删除账户（回写文件）
  ipcMain.handle('two-factor:delete-account', async (_e, { key }: { key: string }) => {
    if (!vault) return { ok: false, error: '请先导入或新建保险库' };
    const before = vault.length;
    vault = vault.filter((a) => a.key !== key);
    if (vault.length === before) return { ok: false, error: '账户不存在' };
    const wb = safeWriteBack();
    if (!wb.ok) return { ok: false, error: wb.error };
    return { ok: true };
  });

  // 导出 / 另存为（可用不同口令加密到新路径，不改变当前保险库路径）
  ipcMain.handle(
    'two-factor:export',
    async (_e, { filePath, passphrase }: { filePath: string; passphrase?: string }) => {
      if (!vault) return { ok: false, error: '没有可导出的保险库' };
      try {
        writeVaultFile(filePath, vault, passphrase || vaultPass || '');
        if (passphrase) await setLastPath(filePath);
        return { ok: true };
      } catch (err: any) {
        return { ok: false, error: err?.message || String(err) };
      }
    },
  );

  // 生成 otpauth URI（用户主动“生成二维码”时调用，含密钥明文，仅用于展示/迁移，不落库）
  ipcMain.handle('two-factor:export-uri', async (_e, { key }: { key: string }) => {
    if (!vault) return { ok: false, error: '未导入保险库' };
    const a = vault.find((x) => x.key === key);
    if (!a) return { ok: false, error: '账户不存在' };
    return { ok: true, uri: buildOtpauthUri(a) };
  });

  // 退出保险库（清空内存中的密钥与口令）
  ipcMain.handle('two-factor:close', async () => {
    vault = null;
    vaultPath = null;
    vaultPass = null;
    return { ok: true };
  });

  // —— 本应用 2FA（测试小窗验证用）——
  // 固定 key，便于 verify/enroll 定位；同时会在 2FA 页面以「渐离App·本机」展示其动态码。
  const APP_SELF_KEY = 'app:self';

  // 注册本应用 2FA：生成密钥、写入保险库、返回 otpauth URI（供手机/外部验证器扫码）
  ipcMain.handle('app-2fa:enroll', async () => {
    if (!vault) return { ok: false, error: '请先导入或新建保险库' };
    let acc = vault.find((a) => a.key === APP_SELF_KEY);
    if (!acc) {
      const secret = randomBase32Secret();
      const now = new Date().toISOString();
      acc = {
        key: APP_SELF_KEY,
        issuer: '渐离App',
        account: '本机',
        secret,
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
        createdAt: now,
        updatedAt: now,
      };
      vault.push(acc);
      const wb = safeWriteBack();
      if (!wb.ok) return { ok: false, error: wb.error };
    }
    const uri = buildOtpauthUri({
      issuer: acc.issuer,
      account: acc.account,
      secret: acc.secret,
      algorithm: acc.algorithm,
      digits: acc.digits,
      period: acc.period,
    });
    return { ok: true, uri, enrolled: true };
  });

  // 校验动态码：±1 步容错 + timingSafeEqual（复用 otp.ts 的统一校验函数）
  ipcMain.handle('app-2fa:verify', async (_e, { code }: { code: string }) => {
    if (!vault) return { ok: false, error: '未导入保险库' };
    const acc = vault.find((a) => a.key === APP_SELF_KEY);
    if (!acc) return { ok: false, error: '尚未注册本机 2FA，请先注册' };
    const clean = (code || '').replace(/\D/g, '');
    if (!clean) return { ok: false, error: '请输入动态码' };
    if (verifyTotpCode(acc.secret, clean, { algorithm: acc.algorithm, digits: acc.digits, period: acc.period || 30 })) {
      return { ok: true };
    }
    return { ok: false, error: '动态码不正确' };
  });

  // 是否已注册本应用 2FA
  ipcMain.handle('app-2fa:status', async () => {
    return { ok: true, enrolled: !!vault?.find((a) => a.key === APP_SELF_KEY) };
  });

  // 让主窗口聚焦并跳转到 2FA 页面（测试小窗“打开 2FA 页面”按钮调用）
  ipcMain.handle('app-2fa:open-page', async () => {
    try {
      if (win && !win.isDestroyed()) {
        win.show();
        win.webContents.send('open-match-page', 'twoFactor');
      }
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) };
    }
  });
}

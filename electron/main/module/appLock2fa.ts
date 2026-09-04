/**
 * 应用锁 2FA 门禁子系统（TOTP 两步验证）
 * ------------------------------------------------------------------
 * 职责：
 * 1. 门禁密钥管理：启用门禁时生成 base32 密钥，用「应用锁密码」经 vault/crypto.ts
 *    （AES-256-GCM + PBKDF2）加密成信封后存 basic_info(appLock2faVault)。
 *    与 2FA 保险库（twoFactor.ts）完全独立——不依赖用户是否打开过保险库，
 *    启动锁定 / 恢复锁定时也能正常校验。
 * 2. 解锁第二步：appLock.ts 的 unlock 第一步（密码）通过后创建「待 2FA 会话」，
 *    渲染端凭 token 调 app-lock:verify-2fa 提交动态码（TOTP 或恢复码），通过才真正解锁。
 * 3. 一次性恢复码：启用门禁时生成 10 条（明文仅展示一次），主进程只存 SHA-256 哈希，
 *    命中即消耗，防止丢失手机后永久锁死。
 * 4. 防暴力冷却：密码步 + 动态码步共用失败计数（主进程内存），连续错 5 次冷却 30 秒。
 *    计数不持久化，应用重启清零（与旧渲染端冷却行为一致，不倒退）。
 *
 * 安全红线：
 * - 密钥明文只在信封解密的瞬间存在，绝不回传渲染端（注册 URI 仅注册流程一次性返回）；
 * - 会话绑定发起窗口的 webContents.id，跨窗口 / 渲染进程重载后旧 token 失效；
 * - 校验用 verifyTotpCode（±1 步容错 + timingSafeEqual 防时序侧信道）。
 *
 * 依赖注入说明：verifyPassword / unlockAppNow 由 appLock.ts 注入，避免模块循环引用。
 *
 * ⚠️ 改动本文件后必须重启 Electron 才生效。
 */
import { ipcMain } from "electron";
import crypto from "node:crypto";
import { query, upsert, del } from "./newSql.ts";
import { tableName } from "./store.ts";
import { encryptVault, decryptVault, type VaultEnvelope } from "./vault/crypto.ts";
import { randomBase32Secret, buildOtpauthUri, verifyTotpCode } from "./twoFactor/otp.ts";

/** 门禁数据在 basic_info 中的存储键（外层元信息非机密；密钥与恢复码哈希在信封内） */
const TWO_FA_KEY = "appLock2faVault";
/** 一次性恢复码条数 */
const RECOVERY_COUNT = 10;
/** 解锁第二步（动态码）会话有效期（ms） */
const PENDING_2FA_TTL_MS = 120_000;
/** 门禁注册会话有效期（ms）：超时未确认作废，需重新扫码 */
const ENROLL_TTL_MS = 5 * 60_000;
/** 最大连续失败次数（密码步 + 动态码步共用计数） */
const MAX_FAIL_COUNT = 5;
/** 触发冷却的时长（ms） */
const COOLDOWN_MS = 30_000;
/** 门禁 TOTP 固定参数（SHA1 / 6 位 / 30s，与主流验证器默认兼容） */
const GATE_ALGORITHM = "SHA1" as const;
const GATE_DIGITS = 6;
const GATE_PERIOD = 30;

/** 依赖注入：由 appLock.ts 在初始化时传入，避免循环 import */
let deps: { verifyPassword: (text: string) => Promise<boolean>; unlockAppNow: () => void } | null = null;

/** 信封内的门禁载荷（解密后才可见） */
interface GatePayload {
  /** base32 TOTP 密钥 */
  secret: string;
  /** 一次性恢复码的 SHA-256 哈希列表（命中即移除） */
  recoveryHashes: string[];
  algorithm: typeof GATE_ALGORITHM;
  digits: number;
  period: number;
}

/** basic_info 中存储的外层结构（envelope 为 AES-GCM 信封 JSON） */
interface GateStore {
  v: 1;
  envelope: VaultEnvelope;
  createdAt: string;
  confirmedAt: string;
  /** 恢复码剩余条数（非机密计数，供设置页展示，免解密） */
  recoveryRemaining: number;
}

/** 门禁校验结果 */
export interface Verify2faResult {
  ok: boolean;
  error?: string;
  /** 本次是否使用了恢复码（恢复码会被消耗） */
  usedRecovery?: boolean;
  /** 使用恢复码后剩余条数 */
  recoveryRemaining?: number;
  /** 距离冷却结束还剩多少次尝试机会 */
  remainingAttempts?: number;
  /** 处于冷却中，几秒后可重试 */
  retryAfterSeconds?: number;
}

// ---------------- 防暴力冷却（主进程权威，替代旧渲染端纯前端计时） ----------------

/** 当前连续失败次数 */
let failCount = 0;
/** 冷却截止时间戳（0 表示不在冷却） */
let cooldownUntil = 0;

/**
 * 查询剩余冷却秒数
 *
 * @returns {number} 剩余秒数（向上取整）；0 表示不在冷却
 */
export function isCoolingDown(): number {
  const remain = cooldownUntil - Date.now();
  return remain > 0 ? Math.ceil(remain / 1000) : 0;
}

/**
 * 记录一次失败（密码步 / 动态码步共用）：达上限即进入冷却并清零计数
 *
 * @returns {{ cooldown: boolean; retryAfterSeconds: number; remainingAttempts: number }}
 */
export function registerLockFailure(): { cooldown: boolean; retryAfterSeconds: number; remainingAttempts: number } {
  const cooling = isCoolingDown();
  if (cooling > 0) return { cooldown: true, retryAfterSeconds: cooling, remainingAttempts: 0 };
  failCount += 1;
  if (failCount >= MAX_FAIL_COUNT) {
    cooldownUntil = Date.now() + COOLDOWN_MS;
    failCount = 0;
    return { cooldown: true, retryAfterSeconds: Math.ceil(COOLDOWN_MS / 1000), remainingAttempts: 0 };
  }
  return { cooldown: false, retryAfterSeconds: 0, remainingAttempts: MAX_FAIL_COUNT - failCount };
}

/**
 * 校验成功后重置失败计数与冷却（密码步成功或门禁通过时调用）
 *
 * @returns {void}
 */
export function resetLockFailures(): void {
  failCount = 0;
  cooldownUntil = 0;
}

// ---------------- 门禁数据读写（basic_info 单键 + AES-GCM 信封） ----------------

/**
 * 读取门禁外层结构；不存在或解析失败返回 null
 *
 * @returns {Promise<GateStore | null>} 门禁存储结构
 */
async function readGateStore(): Promise<GateStore | null> {
  try {
    const data = await query({ tableName, conditions: { key: TWO_FA_KEY } });
    if (!data || data.length === 0) return null;
    const parsed = JSON.parse(data[0].value) as GateStore;
    if (!parsed || !parsed.envelope) return null;
    return parsed;
  } catch (err) {
    console.error("[appLock2fa] 读取门禁数据失败:", err);
    return null;
  }
}

/**
 * 用应用锁密码解开门禁信封，取出载荷
 *
 * @param {GateStore} gate - 门禁存储结构
 * @param {string} password - 应用锁密码明文（仅内存使用）
 * @returns {GatePayload | null} 载荷；密码不符 / 信封损坏返回 null
 */
function readGatePayload(gate: GateStore, password: string): GatePayload | null {
  try {
    const arr = decryptVault<GatePayload>(gate.envelope, password);
    return arr && arr.length > 0 ? arr[0] : null;
  } catch {
    // GCM 认证失败（密码不符 / 数据被篡改）
    return null;
  }
}

/**
 * 用密码加密载荷并落库（upsert 覆盖同键）
 *
 * @param {GatePayload} payload - 门禁载荷
 * @param {string} password - 应用锁密码明文（加密密钥来源）
 * @param {{ createdAt?: string; confirmedAt?: string }} [meta] - 沿用原时间戳（改密 re-wrap / 消耗恢复码时）
 * @returns {Promise<void>}
 */
async function writeGateStore(
  payload: GatePayload,
  password: string,
  meta?: { createdAt?: string; confirmedAt?: string }
): Promise<void> {
  const store: GateStore = {
    v: 1,
    envelope: encryptVault([payload], password),
    createdAt: meta?.createdAt || new Date().toISOString(),
    confirmedAt: meta?.confirmedAt || new Date().toISOString(),
    recoveryRemaining: payload.recoveryHashes.length,
  };
  await upsert({
    tableName,
    data: { key: TWO_FA_KEY, value: JSON.stringify(store) },
    config: { primaryKey: "key" },
  });
}

/**
 * 门禁是否已启用（basic_info 存在门禁键即视为启用）
 *
 * @returns {Promise<boolean>} 是否启用
 */
export async function is2faEnabled(): Promise<boolean> {
  return (await readGateStore()) !== null;
}

// ---------------- 恢复码 ----------------

/**
 * 生成一批一次性恢复码（明文，仅在生成瞬间返回给渲染端展示一次）
 *
 * @returns {string[]} 形如 `xxxxxx-xxxxxx` 的恢复码列表
 */
function generateRecoveryCodes(): string[] {
  const codes: string[] = [];
  for (let i = 0; i < RECOVERY_COUNT; i++) {
    const hex = crypto.randomBytes(6).toString("hex");
    codes.push(`${hex.slice(0, 6)}-${hex.slice(6)}`);
  }
  return codes;
}

/**
 * 计算恢复码哈希（清洗分隔符并小写后取 SHA-256）
 *
 * @param {string} code - 恢复码明文
 * @returns {string} 十六进制哈希
 */
function recoveryCodeHash(code: string): string {
  return crypto.createHash("sha256").update(code.replace(/-/g, "").toLowerCase()).digest("hex");
}

/**
 * 归一化用户输入，判定属于动态码还是恢复码，并按对应方式校验（不消耗恢复码）
 *
 * @param {GatePayload} payload - 门禁载荷
 * @param {string} input - 用户输入（6 位数字 = 动态码；其余按恢复码匹配）
 * @returns {'totp' | 'recovery' | null} 校验通过的类型；不通过返回 null
 */
function verifyGateCode(payload: GatePayload, input: string): "totp" | "recovery" | null {
  const raw = (input || "").trim();
  if (!raw) return null;
  const digitsOnly = raw.replace(/\D/g, "");
  // 6 位纯数字 → TOTP 动态码
  if (/^\d{6}$/.test(digitsOnly) && digitsOnly.length === raw.replace(/[\s]/g, "").length) {
    return verifyTotpCode(payload.secret, digitsOnly, {
      algorithm: payload.algorithm,
      digits: payload.digits,
      period: payload.period,
    })
      ? "totp"
      : null;
  }
  // 其余输入按恢复码匹配（哈希比对，一次性消耗在调用方处理）
  return payload.recoveryHashes.includes(recoveryCodeHash(raw)) ? "recovery" : null;
}

// ---------------- 解锁第二步会话（密码通过后短暂持有密码明文） ----------------

interface Pending2fa {
  token: string;
  /** 第一步验证通过的密码明文（仅内存，用于解门禁信封；会话结束即丢弃） */
  password: string;
  expiresAt: number;
  /** 绑定发起解锁的窗口 webContents.id，防跨窗口重放 */
  senderId: number;
}

let pending2fa: Pending2fa | null = null;

/**
 * 创建待 2FA 会话（appLock.ts 的 unlock 密码步通过且门禁启用时调用）
 *
 * @param {string} password - 已验证通过的应用锁密码明文
 * @param {number} senderId - 发起窗口的 webContents.id
 * @returns {string} 会话 token（渲染端第二步校验时回传）
 */
export function createPending2fa(password: string, senderId: number): string {
  pending2fa = {
    token: crypto.randomUUID(),
    password,
    expiresAt: Date.now() + PENDING_2FA_TTL_MS,
    senderId,
  };
  return pending2fa.token;
}

/**
 * 清空待 2FA 会话（改密后旧会话失效 / 关闭门禁时调用）
 *
 * @returns {void}
 */
export function clearPending2fa(): void {
  pending2fa = null;
}

/**
 * 消费待 2FA 会话：校验 token / TTL / 发起窗口，校验动态码或恢复码，通过即解锁
 *
 * @param {string} token - 第一步返回的会话 token
 * @param {string} code - 用户输入（6 位动态码或恢复码）
 * @param {number} senderId - 当前窗口 webContents.id
 * @returns {Promise<Verify2faResult>} 校验结果（失败计入冷却计数）
 */
export async function consumePending2fa(token: string, code: string, senderId: number): Promise<Verify2faResult> {
  const cooling = isCoolingDown();
  if (cooling > 0) return { ok: false, error: "尝试次数过多", retryAfterSeconds: cooling };
  const session = pending2fa;
  if (!session || session.token !== token || session.senderId !== senderId || Date.now() > session.expiresAt) {
    pending2fa = null;
    return { ok: false, error: "验证会话已失效，请重新输入密码" };
  }
  const gate = await readGateStore();
  if (!gate) {
    pending2fa = null;
    return { ok: false, error: "两步验证数据异常，请重新输入密码" };
  }
  const payload = readGatePayload(gate, session.password);
  if (!payload) {
    pending2fa = null;
    return { ok: false, error: "两步验证数据异常，请重新输入密码" };
  }
  const raw = (code || "").trim();
  const digitsOnly = raw.replace(/\D/g, "");
  const kind =
    /^\d{6}$/.test(digitsOnly) && digitsOnly.length === raw.replace(/[\s]/g, "").length ? "totp" : "recovery";
  if (kind === "totp") {
    if (verifyTotpCode(payload.secret, digitsOnly, {
      algorithm: payload.algorithm,
      digits: payload.digits,
      period: payload.period,
    })) {
      resetLockFailures();
      pending2fa = null;
      deps?.unlockAppNow();
      return { ok: true };
    }
  } else {
    // 恢复码：命中即消耗（从哈希列表移除并回写），防止重复使用
    const hash = recoveryCodeHash(raw);
    const idx = payload.recoveryHashes.indexOf(hash);
    if (idx >= 0) {
      payload.recoveryHashes.splice(idx, 1);
      try {
        await writeGateStore(payload, session.password, {
          createdAt: gate.createdAt,
          confirmedAt: gate.confirmedAt,
        });
      } catch (err) {
        console.error("[appLock2fa] 消耗恢复码回写失败:", err);
        return { ok: false, error: "恢复码校验通过但回写失败，请重试" };
      }
      resetLockFailures();
      pending2fa = null;
      deps?.unlockAppNow();
      return { ok: true, usedRecovery: true, recoveryRemaining: payload.recoveryHashes.length };
    }
  }
  const failure = registerLockFailure();
  if (failure.cooldown) {
    return { ok: false, error: "尝试次数过多", retryAfterSeconds: failure.retryAfterSeconds };
  }
  return { ok: false, error: "动态码不正确", remainingAttempts: failure.remainingAttempts };
}

// ---------------- 门禁注册 / 关闭 / 恢复码重生成 ----------------

/** 注册会话（扫码 → 确认动态码期间短暂持有密钥与密码） */
let pendingEnroll: { secret: string; password: string; expiresAt: number; senderId: number } | null = null;

/**
 * 改密码后用新密码重加密门禁信封（re-wrap）
 *
 * @param {string} oldPwd - 旧密码（解密现有信封）
 * @param {string} newPwd - 新密码（重新加密）
 * @returns {Promise<boolean>} 是否成功（无门禁数据视为成功）
 */
export async function rewrap2fa(oldPwd: string, newPwd: string): Promise<boolean> {
  const gate = await readGateStore();
  if (!gate) return true;
  const payload = readGatePayload(gate, oldPwd);
  if (!payload) return false;
  try {
    await writeGateStore(payload, newPwd, { createdAt: gate.createdAt, confirmedAt: gate.confirmedAt });
    // 密码已变更，第一步会话中持有的旧密码随即失效
    pending2fa = null;
    return true;
  } catch (err) {
    console.error("[appLock2fa] 门禁信封重加密失败:", err);
    return false;
  }
}

/**
 * 清除门禁数据（关闭应用锁 / 显式关闭门禁时调用）
 *
 * @returns {Promise<void>}
 */
export async function purge2fa(): Promise<void> {
  pending2fa = null;
  pendingEnroll = null;
  try {
    await del({ tableName, condition: { key: TWO_FA_KEY } });
  } catch (err) {
    console.error("[appLock2fa] 清除门禁数据失败:", err);
  }
}

// ---------------- IPC 通道注册 ----------------

/**
 * 初始化门禁子系统：注册 app-lock:2fa-* 通道（由 initAppLock 末尾调用并注入依赖）
 *
 * @param {AppLock2faDeps} injected - 注入的密码校验与解锁函数（避免循环 import）
 * @returns {void}
 */
export function initAppLock2fa(injected: {
  verifyPassword: (text: string) => Promise<boolean>;
  unlockAppNow: () => void;
}): void {
  deps = injected;

  // 门禁配置快照（设置页展示；不回传任何密钥材料）
  ipcMain.handle("app-lock:2fa-get-config", async () => {
    const gate = await readGateStore();
    return {
      enabled: !!gate,
      enrolledAt: gate?.confirmedAt || null,
      recoveryRemaining: gate?.recoveryRemaining ?? 0,
    };
  });

  // 注册第一步：验证密码后生成密钥（暂存会话，未生效），返回 otpauth URI + 密钥文本（仅此一次）
  ipcMain.handle("app-lock:2fa-enroll-start", async (e, params: { password: string }) => {
    try {
      const password = params?.password || "";
      if (!(await deps!.verifyPassword(password))) return { ok: false, error: "密码错误" };
      if (await is2faEnabled()) return { ok: false, error: "两步验证已启用" };
      const secret = randomBase32Secret();
      pendingEnroll = {
        secret,
        password,
        expiresAt: Date.now() + ENROLL_TTL_MS,
        senderId: e.sender.id,
      };
      const uri = buildOtpauthUri({ issuer: "渐离App", account: "应用锁", secret });
      return { ok: true, uri, secret };
    } catch (err: any) {
      console.error("[appLock2fa] 注册启动失败:", err);
      return { ok: false, error: err?.message || String(err) };
    }
  });

  // 注册第二步：手机验证器出码确认，通过后落库信封并生成恢复码（明文仅此一次返回）
  ipcMain.handle("app-lock:2fa-enroll-confirm", async (e, params: { code: string }) => {
    try {
      if (!pendingEnroll || pendingEnroll.senderId !== e.sender.id || Date.now() > pendingEnroll.expiresAt) {
        pendingEnroll = null;
        return { ok: false, error: "注册会话已过期，请重新开始" };
      }
      if (!verifyTotpCode(pendingEnroll.secret, params?.code || "", {
        algorithm: GATE_ALGORITHM,
        digits: GATE_DIGITS,
        period: GATE_PERIOD,
      })) {
        return { ok: false, error: "动态码不正确，请确认验证器已添加本条目" };
      }
      const recoveryCodes = generateRecoveryCodes();
      const payload: GatePayload = {
        secret: pendingEnroll.secret,
        recoveryHashes: recoveryCodes.map(recoveryCodeHash),
        algorithm: GATE_ALGORITHM,
        digits: GATE_DIGITS,
        period: GATE_PERIOD,
      };
      await writeGateStore(payload, pendingEnroll.password);
      pendingEnroll = null;
      return { ok: true, recoveryCodes };
    } catch (err: any) {
      console.error("[appLock2fa] 注册确认失败:", err);
      return { ok: false, error: err?.message || String(err) };
    }
  });

  // 取消注册：清暂存会话（关闭向导时调用）
  ipcMain.handle("app-lock:2fa-enroll-cancel", async () => {
    pendingEnroll = null;
    return { ok: true };
  });

  // 关闭门禁：双因子确认（密码 + 当前动态码或恢复码，恢复码不消耗），防止拿到未锁电脑的人直接关掉门禁
  ipcMain.handle("app-lock:2fa-disable", async (e, params: { password: string; code: string }) => {
    try {
      const password = params?.password || "";
      if (!(await deps!.verifyPassword(password))) return { ok: false, error: "密码错误" };
      const gate = await readGateStore();
      if (!gate) return { ok: false, error: "两步验证未启用" };
      const payload = readGatePayload(gate, password);
      if (!payload) return { ok: false, error: "两步验证数据异常" };
      if (!verifyGateCode(payload, params?.code || "")) return { ok: false, error: "动态码不正确" };
      await purge2fa();
      return { ok: true };
    } catch (err: any) {
      console.error("[appLock2fa] 关闭门禁失败:", err);
      return { ok: false, error: err?.message || String(err) };
    }
  });

  // 重新生成恢复码：双因子确认后替换全部哈希，旧恢复码作废
  ipcMain.handle("app-lock:2fa-recovery-regenerate", async (e, params: { password: string; code: string }) => {
    try {
      const password = params?.password || "";
      if (!(await deps!.verifyPassword(password))) return { ok: false, error: "密码错误" };
      const gate = await readGateStore();
      if (!gate) return { ok: false, error: "两步验证未启用" };
      const payload = readGatePayload(gate, password);
      if (!payload) return { ok: false, error: "两步验证数据异常" };
      if (!verifyGateCode(payload, params?.code || "")) return { ok: false, error: "动态码不正确" };
      const recoveryCodes = generateRecoveryCodes();
      payload.recoveryHashes = recoveryCodes.map(recoveryCodeHash);
      await writeGateStore(payload, password, { createdAt: gate.createdAt, confirmedAt: gate.confirmedAt });
      return { ok: true, recoveryCodes };
    } catch (err: any) {
      console.error("[appLock2fa] 重新生成恢复码失败:", err);
      return { ok: false, error: err?.message || String(err) };
    }
  });

  // 解锁第二步：凭第一步返回的 token 提交动态码 / 恢复码，通过即解锁并广播
  ipcMain.handle("app-lock:verify-2fa", async (e, params: { token: string; code: string }) => {
    try {
      return await consumePending2fa(params?.token || "", params?.code || "", e.sender.id);
    } catch (err: any) {
      console.error("[appLock2fa] 动态码校验异常:", err);
      return { ok: false, error: err?.message || String(err) };
    }
  });
}

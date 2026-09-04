/**
 * 应用锁 / 隐私模式（老板键）模块
 *
 * 功能：
 * 1. 应用锁：锁定时主窗口显示锁屏遮罩（渲染端 AppLock.vue），所有小窗/贴纸窗临时隐藏，
 *    输入密码解锁后恢复。密码经 vault/crypto.ts（AES-256-GCM + PBKDF2）以「用户口令」为密钥
 *    加密一个哨兵串后存 basic_info(appLockVault)，明文密码绝不存储、绝不进渲染端。
 * 2. 锁定触发（均需用户在设置页开启对应开关，默认不触发）：
 *    - 手动锁定：快捷键 / 设置页按钮 / 命令面板
 *    - 启动时锁定：应用启动后自动进入锁定态
 *    - 最小化恢复时锁定：主窗口 restore/show 回前台时自动锁定
 * 3. 隐私模式（老板键）：快捷键一键隐藏全部窗口，再按恢复；
 *    锁定态下恢复时不还原小窗（保持锁定隐私）。
 * 4. 2FA 门禁（appLock2fa.ts，两步验证）：开启后 unlock 密码步通过并不直接解锁，
 *    而是创建「待 2FA 会话」返回 token，渲染端再凭 token 提交 TOTP 动态码（或一次性恢复码），
 *    全部锁定路径（手动/快捷键/启动/恢复/命令面板）统一强制。防暴力冷却计数在主进程。
 *
 * 安全设计（与 2FA / 密码管理统一）：
 * - 复用 vault/crypto.ts 的同一套 AES-256-GCM + PBKDF2 原语，密钥由用户口令派生；
 * - 明文（哨兵串）仅驻留主进程内存，加密信封存于 basic_info，绝不进业务数据库；
 * - 校验/解密全部在本模块完成，用异步 ipcMain.handle（避开同步通道阻塞渲染线程的坑）。
 *
 * 迁移说明：旧实现用 legacy crypto.ts 的 RSA + 硬编码口令，密码存于 basic_info(appLockPassword)。
 * 本项目采用「强制重新录入」，initAppLock 启动时清理遗留的 RSAKey / appLockPassword / electron-store
 * 的 password / pwdQuestionList，旧密文不再被读取。
 */
import { ipcMain, BrowserWindow } from "electron";
import { query, upsert, del } from "./newSql.ts";
import { tableName, store } from "./store.ts";
import { win } from "./mainWindow.ts";
import { encryptVault, decryptVault, type VaultEnvelope } from "./vault/crypto.ts";
import {
  initAppLock2fa,
  is2faEnabled,
  createPending2fa,
  registerLockFailure,
  resetLockFailures,
  isCoolingDown,
  rewrap2fa,
  purge2fa,
} from "./appLock2fa.ts";

/** 保险库在 basic_info 中的存储键 */
const PASSWORD_KEY = "appLockVault";
/** 加密哨兵：解密成功且包含该串即代表口令正确（明文密码永不存储） */
const SENTINEL = "__app_lock_sentinel__";
/** 启动时锁定配置键（bool，默认 false） */
const LOCK_ON_STARTUP_KEY = "appLockOnStartup";
/** 最小化恢复时锁定配置键（bool，默认 false） */
const LOCK_ON_RESTORE_KEY = "appLockOnRestore";
/** 应用启动保护期（ms）：保护期内 restore/show 不触发恢复锁定，避免与启动锁定重复 */
const STARTUP_GUARD_MS = 8000;
/** 模块初始化时间戳（启动保护期基准） */
let initializedAt = 0;

/** 当前是否处于锁定态（主进程权威，广播同步给渲染端） */
let isLocked = false;
/** 锁定时被隐藏的窗口列表（解锁时按原样恢复） */
let hiddenWindows: BrowserWindow[] = [];

/**
 * 从 basic_info 读取应用锁保险库信封；不存在或损坏返回 null
 *
 * @returns {Promise<VaultEnvelope | null>} 信封；缺失/损坏返回 null
 */
async function readVaultEnvelope(): Promise<VaultEnvelope | null> {
  try {
    const data = await query({ tableName, conditions: { key: PASSWORD_KEY } });
    if (!data || data.length === 0) return null;
    return JSON.parse(data[0].value) as VaultEnvelope;
  } catch (err) {
    console.error("[appLock] 读取保险库信封失败:", err);
    return null;
  }
}

/**
 * 校验密码（主进程解密比对，明文不出现在任何存储中）
 * 导出供 appLock2fa.ts 注入复用（门禁注册 / 关闭前的密码校验）。
 *
 * @param {string} text - 用户输入的明文密码
 * @returns {Promise<boolean>} 是否匹配；未设置密码返回 false
 */
export async function verifyPassword(text: string): Promise<boolean> {
  const env = await readVaultEnvelope();
  if (!env) return false;
  try {
    const arr = decryptVault<string>(env, text);
    return arr.includes(SENTINEL);
  } catch {
    // GCM 认证失败（口令错误 / 信封损坏）→ 视为不匹配
    return false;
  }
}

/**
 * 广播锁定态到所有窗口（渲染端 AppLock.vue 据此显隐遮罩）
 *
 * @returns {void}
 */
function broadcastLockState(): void {
  BrowserWindow.getAllWindows().forEach((w) => {
    if (!w.isDestroyed()) {
      w.webContents.send("app-lock:state-changed", { locked: isLocked });
    }
  });
}

/**
 * 立即锁定应用
 *
 * 流程：隐藏全部非主窗口（记录以便恢复）→ 置锁定态 → 广播 → 主窗口显示并聚焦。
 * 幂等：已锁定时重复调用直接返回。
 *
 * @returns {void}
 */
function lockAppNow(): void {
  if (isLocked) return;
  isLocked = true;
  try {
    // 隐藏全部非主窗口（小窗/贴纸/命令面板等），锁定期间不可见防窥
    const mainWin = win && !win.isDestroyed() ? win : null;
    hiddenWindows = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && w !== mainWin);
    hiddenWindows.forEach((w) => w.hide());

    // 主窗口回前台展示锁屏遮罩（isLocked 已置位，restore/show 事件不会重复触发锁定）
    if (mainWin) {
      if (mainWin.isMinimized()) mainWin.restore();
      mainWin.show();
      mainWin.focus();
    }
  } catch (err) {
    console.error("[appLock] 锁定流程异常:", err);
  }
  broadcastLockState();
}

/**
 * 解锁应用
 *
 * 流程：清除锁定态 → 广播 → 恢复锁定时隐藏的小窗（按原窗口对象 show，无需重建）。
 * 导出供 appLock2fa.ts 注入复用（门禁动态码校验通过后执行解锁）。
 *
 * @returns {void}
 */
export function unlockAppNow(): void {
  if (!isLocked) return;
  isLocked = false;
  try {
    hiddenWindows.forEach((w) => {
      if (!w.isDestroyed()) w.show();
    });
    hiddenWindows = [];
  } catch (err) {
    console.error("[appLock] 恢复小窗异常:", err);
  }
  broadcastLockState();
}

/**
 * 隐私模式（老板键）：一键隐藏全部窗口，再按恢复
 *
 * - 有任意可见窗口时：隐藏主窗口 + 全部小窗（记录列表）
 * - 全部隐藏时：显示主窗口；若处于锁定态则不恢复小窗（保持隐私锁定）
 *
 * @returns {void}
 */
function togglePrivacyHide(): void {
  try {
    const mainWin = win && !win.isDestroyed() ? win : null;
    const others = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && w !== mainWin);
    const anyVisible = (mainWin && mainWin.isVisible()) || others.some((w) => w.isVisible());

    if (anyVisible) {
      // 隐藏全部（与锁定分开记录，避免覆盖 locked 的 hiddenWindows）
      privacyHidden = [];
      if (mainWin && mainWin.isVisible()) {
        mainWin.hide();
        privacyHidden.push(mainWin);
      }
      others.forEach((w) => {
        if (w.isVisible()) {
          w.hide();
          privacyHidden.push(w);
        }
      });
    } else {
      // 恢复：主窗口回前台；锁定态下小窗保持隐藏（lockAppNow 的恢复逻辑接管）
      if (mainWin) {
        mainWin.show();
        mainWin.focus();
      }
      if (!isLocked) {
        privacyHidden.forEach((w) => {
          if (!w.isDestroyed()) w.show();
        });
      }
      privacyHidden = [];
    }
  } catch (err) {
    console.error("[appLock] 老板键切换异常:", err);
  }
}

/** 老板键隐藏的窗口列表（与锁定隐藏列表分开维护，互不干扰） */
let privacyHidden: BrowserWindow[] = [];

/**
 * 判断是否应触发「最小化恢复时锁定」
 *
 * 条件：未处于锁定态 + 开关已开启 + 已设置密码 + 已过启动保护期。
 *
 * @returns {Promise<boolean>} 是否应锁定
 */
async function shouldLockOnRestore(): Promise<boolean> {
  if (isLocked) return false;
  if (Date.now() - initializedAt < STARTUP_GUARD_MS) return false;
  if (!(await readBoolConfig(LOCK_ON_RESTORE_KEY))) return false;
  return (await readVaultEnvelope()) !== null;
}

/**
 * 读取 basic_info 布尔配置（appLockOnStartup / appLockOnRestore）
 *
 * @param {string} key - 配置键
 * @returns {Promise<boolean>} 配置值；缺失或解析失败返回 false（默认不触发）
 */
async function readBoolConfig(key: string): Promise<boolean> {
  try {
    const data = await query({ tableName, conditions: { key } });
    if (!data || data.length === 0) return false;
    const value = data[0].value;
    return value === true || value === "true" || value === 1 || value === "1";
  } catch {
    return false;
  }
}

/**
 * 启动时清理遗留的旧密钥（强制重新录入策略）
 *
 * 旧实现用 legacy crypto.ts 的 RSA + 硬编码口令，相关密文存于 basic_info(RSAKey / appLockPassword)
 * 与 electron-store(password / pwdQuestionList)。新架构不读取这些旧密文，直接清理避免误导。
 *
 * @returns {Promise<void>}
 */
async function migrateLegacySecrets(): Promise<void> {
  const legacyKeys = ["RSAKey", "appLockPassword"];
  for (const key of legacyKeys) {
    try {
      await del({ tableName, condition: { key } });
    } catch (err) {
      console.error(`[appLock] 清理遗留键 ${key} 失败:`, err);
    }
  }
  for (const key of ["password", "pwdQuestionList"]) {
    try {
      store.delete(key);
    } catch (err) {
      console.error(`[appLock] 清理 electron-store ${key} 失败:`, err);
    }
  }
}

/**
 * 初始化应用锁模块：注册 IPC 通道 + 挂主窗口事件 + 启动锁定检查
 *
 * 注册的通道：
 * - app-lock:set-password 设置/修改密码 / app-lock:verify 校验 / app-lock:clear-password 清除
 * - app-lock:unlock 解锁（密码步；开启 2FA 门禁时返回 need2fa + 待验证 token）
 * - app-lock:verify-2fa 门禁动态码校验 / app-lock:2fa-* 门禁管理（见 appLock2fa.ts）
 * - app-lock:lock 立即锁定 / app-lock:get-state 状态快照
 * - app-lock:config-changed 配置变更通知（重读开关）
 * - app-lock:state-changed 主→渲染广播锁定态
 *
 * @returns {void}
 */
export function initAppLock() {
  initializedAt = Date.now();

  // 启动即清理遗留旧密钥（不阻塞）
  migrateLegacySecrets().catch((err) => console.error("[appLock] 迁移清理异常:", err));

  // 设置密码（首次开启或修改）：主进程内加密落库，明文不经过渲染端存储
  // 修改密码（传 current）时先校验旧密码；若已开启 2FA 门禁，须用新密码重加密门禁信封
  ipcMain.handle("app-lock:set-password", async (_e, params: { text: string; current?: string }) => {
    try {
      const { text } = params || ({} as any);
      if (!text || typeof text !== "string") return { ok: false, error: "密码不能为空" };
      // 已有门禁数据时改密：必须携带当前密码（用于解开旧信封重加密），且旧密码须正确
      const gateEnabled = await is2faEnabled();
      if (gateEnabled) {
        const current = params?.current || "";
        if (!current) return { ok: false, error: "已开启两步验证，请输入当前密码以迁移门禁数据" };
        if (!(await verifyPassword(current))) return { ok: false, error: "当前密码错误" };
      }
      const env = encryptVault<string>([SENTINEL], text);
      await upsert({
        tableName,
        data: { key: PASSWORD_KEY, value: JSON.stringify(env) },
        config: { primaryKey: "key" },
      });
      // 用新密码重加密门禁信封（无门禁数据时为空操作）
      if (gateEnabled && !(await rewrap2fa(params?.current || "", text))) {
        return { ok: false, error: "两步验证数据迁移失败，请重试或用恢复码解锁后重设" };
      }
      return { ok: true };
    } catch (err: any) {
      console.error("[appLock] 设置密码失败:", err);
      return { ok: false, error: err?.message || String(err) };
    }
  });

  // 校验密码（设置页改密/关锁前验证，不改变锁定态）
  ipcMain.handle("app-lock:verify", async (_e, params: { text: string }) => {
    const matched = await verifyPassword(params?.text || "");
    return { matched };
  });

  // 清除密码（需先校验当前密码）：删除存储行并解除锁定；2FA 门禁数据一并清除
  ipcMain.handle("app-lock:clear-password", async (_e, params: { text: string }) => {
    const matched = await verifyPassword(params?.text || "");
    if (!matched) return { ok: false, matched, error: "密码错误" };
    try {
      await del({ tableName, condition: { key: PASSWORD_KEY } });
      // 应用锁整体关闭：门禁密钥与恢复码随之作废
      await purge2fa();
      unlockAppNow();
      return { ok: true, matched };
    } catch (err: any) {
      console.error("[appLock] 清除密码失败:", err);
      return { ok: false, error: err?.message || String(err) };
    }
  });

  // 解锁（两步：密码通过 → 若开启 2FA 门禁则返回待验证会话，由渲染端提交动态码；
  // 失败统一计入主进程冷却计数，连续错 5 次冷却 30 秒）
  ipcMain.handle("app-lock:unlock", async (e, params: { text: string }) => {
    // 冷却期内直接拒绝（密码步与动态码步共用同一冷却）
    const cooling = isCoolingDown();
    if (cooling > 0) return { matched: false, retryAfterSeconds: cooling };
    const matched = await verifyPassword(params?.text || "");
    if (!matched) {
      const failure = registerLockFailure();
      if (failure.cooldown) return { matched: false, retryAfterSeconds: failure.retryAfterSeconds };
      return { matched: false, remainingAttempts: failure.remainingAttempts };
    }
    resetLockFailures();
    // 已开启门禁：不解锁，进入第二步（TOTP / 恢复码）
    if (await is2faEnabled()) {
      const token = createPending2fa(params?.text || "", e.sender.id);
      return { matched: true, need2fa: true, token };
    }
    unlockAppNow();
    return { matched: true };
  });

  // 立即锁定（设置页测试按钮 / 命令面板触发）
  ipcMain.handle("app-lock:lock", async () => {
    lockAppNow();
    return { ok: true };
  });

  // 状态快照（渲染端初始化用：锁定态 + 是否已设密码 + 两个开关 + 2FA 门禁是否启用）
  ipcMain.handle("app-lock:get-state", async () => {
    const env = await readVaultEnvelope();
    return {
      locked: isLocked,
      hasPassword: !!env,
      onStartup: await readBoolConfig(LOCK_ON_STARTUP_KEY),
      onRestore: await readBoolConfig(LOCK_ON_RESTORE_KEY),
      twoFactorEnabled: await is2faEnabled(),
    };
  });

  // 配置变更通知：渲染端改开关后调用，主进程无需额外处理（每次判定实时读库），
  // 仅记录日志便于排查
  ipcMain.on("app-lock:config-changed", () => {
    console.log("[appLock] 锁定配置已变更");
  });

  // 最小化恢复时锁定：主窗口从最小化恢复（restore）或重新显示（show）时判定
  if (win && !win.isDestroyed()) {
    const tryLockOnRestore = () => {
      shouldLockOnRestore()
        .then((should) => {
          if (should) lockAppNow();
        })
        .catch((err) => console.error("[appLock] 恢复锁定判定异常:", err));
    };
    win.on("restore", tryLockOnRestore);
    win.on("show", tryLockOnRestore);
  }

  // 启动时锁定：延迟数秒等待主窗口与渲染端就绪，开关开启且已设密码才触发
  setTimeout(async () => {
    try {
      const enabled = await readBoolConfig(LOCK_ON_STARTUP_KEY);
      if (!enabled) return;
      if (!(await readVaultEnvelope())) return;
      lockAppNow();
    } catch (err) {
      console.error("[appLock] 启动锁定检查异常:", err);
    }
  }, 4000);

  // 初始化 2FA 门禁子系统（app-lock:2fa-* 通道族），注入密码校验与解锁函数避免循环依赖
  initAppLock2fa({ verifyPassword, unlockAppNow });
}

export { lockAppNow, togglePrivacyHide };

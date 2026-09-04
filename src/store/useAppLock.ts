/**
 * 应用锁 / 隐私模式 store
 *
 * 职责：
 * 1. 锁定运行时态（locked）：由主进程广播 app-lock:state-changed 驱动（主进程权威）
 * 2. 配置态：是否已设密码（hasPassword）、启动锁定（onStartup）、恢复锁定（onRestore）、
 *    2FA 门禁是否启用（twoFactorEnabled），开关落 basic_info（setStore），变更后 send 通知主进程
 * 3. 动作封装：锁定 / 两步解锁（密码步 → 动态码步，校验全在主进程，明文不落存储）/
 *    2FA 门禁管理（注册 / 关闭 / 恢复码重生成）
 */
import { defineStore } from "pinia";
import { ref } from "vue";
import { send, setStore } from "../utils/common";

/** 解锁第一步（密码）返回结果 */
export interface UnlockResult {
  /** 密码是否正确 */
  matched: boolean;
  /** 需要第二步动态码验证（2FA 门禁已开启） */
  need2fa?: boolean;
  /** 待 2FA 会话 token（verify2fa 时原样回传） */
  token?: string;
  /** 距冷却结束还可尝试的次数（未进入冷却时） */
  remainingAttempts?: number;
  /** 冷却剩余秒数（>0 表示处于冷却期） */
  retryAfterSeconds?: number;
}

/** 2FA 门禁配置快照（主进程 get-state / get-config） */
export interface TwoFactorGateConfig {
  enabled: boolean;
  enrolledAt: string | null;
  recoveryRemaining: number;
}

/** 动态码 / 恢复码校验结果（app-lock:verify-2fa） */
export interface Verify2faResult {
  ok: boolean;
  error?: string;
  usedRecovery?: boolean;
  recoveryRemaining?: number;
  remainingAttempts?: number;
  retryAfterSeconds?: number;
}

/** 门禁注册第一步结果（含一次性回传的 otpauth URI 与密钥文本） */
export interface EnrollStartResult {
  ok: boolean;
  uri?: string;
  secret?: string;
  error?: string;
}

/** 恢复码生成结果（明文仅此一次返回） */
export interface RecoveryResult {
  ok: boolean;
  recoveryCodes?: string[];
  error?: string;
}

export default defineStore("app-lock", () => {
  /** 是否处于锁定态（遮罩显隐的唯一依据，主进程广播驱动） */
  const locked = ref(false);
  /** 是否已设置应用锁密码 */
  const hasPassword = ref(false);
  /** 应用启动时自动锁定（开关，默认关） */
  const onStartup = ref(false);
  /** 最小化/隐藏恢复到前台时自动锁定（开关，默认关） */
  const onRestore = ref(false);
  /** 2FA 门禁是否启用（两步验证） */
  const twoFactorEnabled = ref(false);

  /** 是否已初始化（防重复订阅广播） */
  let inited = false;

  /**
   * 初始化：订阅主进程锁定态广播 + 拉取状态快照
   *
   * @returns {Promise<void>}
   */
  async function init(): Promise<void> {
    if (inited) return;
    inited = true;
    // 锁定态由主进程权威下发（手动/快捷键/启动/恢复锁定统一走主进程）
    window.ipcRenderer.on("app-lock:state-changed", (_e: any, val: any) => {
      locked.value = !!val?.locked;
    });
    try {
      const state = await window.ipcRenderer.handlePromise("app-lock:get-state", {});
      locked.value = !!state?.locked;
      hasPassword.value = !!state?.hasPassword;
      onStartup.value = !!state?.onStartup;
      onRestore.value = !!state?.onRestore;
      twoFactorEnabled.value = !!state?.twoFactorEnabled;
    } catch (err) {
      console.error("[appLock] 初始化状态快照失败:", err);
    }
  }

  /**
   * 设置/修改密码（主进程内加密落库，明文不经过渲染端存储）
   * 已开启 2FA 门禁时修改密码必须传 current，主进程将用新密码重加密门禁信封。
   *
   * @param {string} text - 新密码明文（仅经 IPC 传输给主进程加密）
   * @param {string} [current] - 当前密码明文（修改模式必传，用于门禁信封迁移）
   * @returns {Promise<boolean>} 是否设置成功
   */
  async function setPassword(text: string, current?: string): Promise<boolean> {
    const res = await window.ipcRenderer.handlePromise("app-lock:set-password", { text, current });
    if (res?.ok) hasPassword.value = true;
    return !!res?.ok;
  }

  /**
   * 校验密码（不改变锁定态，设置页改密/关锁前验证用）
   *
   * @param {string} text - 待校验的明文密码
   * @returns {Promise<boolean>} 是否匹配
   */
  async function verify(text: string): Promise<boolean> {
    const res = await window.ipcRenderer.handlePromise("app-lock:verify", { text });
    return !!res?.matched;
  }

  /**
   * 清除密码（需先校验当前密码）：关闭应用锁并解除锁定（2FA 门禁数据一并清除）
   *
   * @param {string} text - 当前密码明文
   * @returns {Promise<boolean>} 是否清除成功（密码错误返回 false）
   */
  async function clearPassword(text: string): Promise<boolean> {
    const res = await window.ipcRenderer.handlePromise("app-lock:clear-password", { text });
    if (res?.ok) {
      hasPassword.value = false;
      onStartup.value = false;
      onRestore.value = false;
      twoFactorEnabled.value = false;
    }
    return !!res?.ok;
  }

  /**
   * 解锁第一步（锁屏遮罩密码步调用）：主进程校验密码；
   * 已开启 2FA 门禁时返回 need2fa + token，需再调 verify2fa 完成第二步。
   * 失败计数与冷却由主进程维护，返回值携带剩余次数 / 冷却秒数。
   *
   * @param {string} text - 输入的明文密码
   * @returns {Promise<UnlockResult>} 第一步结果
   */
  async function unlock(text: string): Promise<UnlockResult> {
    const res = await window.ipcRenderer.handlePromise("app-lock:unlock", { text });
    return {
      matched: !!res?.matched,
      need2fa: !!res?.need2fa,
      token: res?.token,
      remainingAttempts: res?.remainingAttempts,
      retryAfterSeconds: res?.retryAfterSeconds,
    };
  }

  /**
   * 解锁第二步（2FA 门禁）：提交 TOTP 动态码或一次性恢复码
   *
   * @param {string} token - 第一步返回的会话 token
   * @param {string} code - 6 位动态码或恢复码
   * @returns {Promise<Verify2faResult>} 校验结果
   */
  async function verify2fa(token: string, code: string): Promise<Verify2faResult> {
    const res = await window.ipcRenderer.handlePromise("app-lock:verify-2fa", { token, code });
    return {
      ok: !!res?.ok,
      error: res?.error,
      usedRecovery: !!res?.usedRecovery,
      recoveryRemaining: res?.recoveryRemaining,
      remainingAttempts: res?.remainingAttempts,
      retryAfterSeconds: res?.retryAfterSeconds,
    };
  }

  /**
   * 立即锁定（设置页测试按钮 / 命令面板触发）
   *
   * @returns {Promise<void>}
   */
  async function lock(): Promise<void> {
    await window.ipcRenderer.handlePromise("app-lock:lock", {});
  }

  /**
   * 设置「启动时锁定」开关：落 basic_info + 通知主进程
   *
   * @param {boolean} value - 开关值
   * @returns {void}
   */
  function setOnStartup(value: boolean): void {
    onStartup.value = value;
    setStore("appLockOnStartup", value);
    send("app-lock:config-changed", {});
  }

  /**
   * 设置「最小化恢复时锁定」开关：落 basic_info + 通知主进程
   *
   * @param {boolean} value - 开关值
   * @returns {void}
   */
  function setOnRestore(value: boolean): void {
    onRestore.value = value;
    setStore("appLockOnRestore", value);
    send("app-lock:config-changed", {});
  }

  // ---------------- 2FA 门禁管理（设置页向导用） ----------------

  /**
   * 拉取门禁配置快照（并同步 twoFactorEnabled）
   *
   * @returns {Promise<TwoFactorGateConfig>} 配置快照
   */
  async function get2faConfig(): Promise<TwoFactorGateConfig> {
    const res = await window.ipcRenderer.handlePromise("app-lock:2fa-get-config", {});
    const config: TwoFactorGateConfig = {
      enabled: !!res?.enabled,
      enrolledAt: res?.enrolledAt || null,
      recoveryRemaining: Number(res?.recoveryRemaining ?? 0),
    };
    twoFactorEnabled.value = config.enabled;
    return config;
  }

  /**
   * 门禁注册第一步：验证密码并生成密钥（未生效），返回 otpauth URI + 密钥文本（仅此一次）
   *
   * @param {string} password - 当前应用锁密码
   * @returns {Promise<EnrollStartResult>} 含 otpauth URI 与 base32 密钥
   */
  async function enrollStart(password: string): Promise<EnrollStartResult> {
    const res = await window.ipcRenderer.handlePromise("app-lock:2fa-enroll-start", { password });
    return { ok: !!res?.ok, uri: res?.uri, secret: res?.secret, error: res?.error };
  }

  /**
   * 门禁注册第二步：提交手机验证器当前动态码确认，落库并返回一次性恢复码
   *
   * @param {string} code - 手机上显示的 6 位动态码
   * @returns {Promise<RecoveryResult>} 恢复码明文列表（仅此一次）
   */
  async function enrollConfirm(code: string): Promise<RecoveryResult> {
    const res = await window.ipcRenderer.handlePromise("app-lock:2fa-enroll-confirm", { code });
    if (res?.ok) twoFactorEnabled.value = true;
    return { ok: !!res?.ok, recoveryCodes: res?.recoveryCodes, error: res?.error };
  }

  /**
   * 取消门禁注册（关闭向导时调用，清主进程暂存会话）
   *
   * @returns {Promise<void>}
   */
  async function enrollCancel(): Promise<void> {
    await window.ipcRenderer.handlePromise("app-lock:2fa-enroll-cancel", {});
  }

  /**
   * 关闭门禁（双因子确认：密码 + 当前动态码或恢复码）
   *
   * @param {string} password - 当前应用锁密码
   * @param {string} code - 当前动态码或恢复码
   * @returns {Promise<{ ok: boolean; error?: string }>} 关闭结果
   */
  async function disable2fa(password: string, code: string): Promise<{ ok: boolean; error?: string }> {
    const res = await window.ipcRenderer.handlePromise("app-lock:2fa-disable", { password, code });
    if (res?.ok) twoFactorEnabled.value = false;
    return { ok: !!res?.ok, error: res?.error };
  }

  /**
   * 重新生成恢复码（双因子确认：密码 + 当前动态码或恢复码，旧恢复码作废）
   *
   * @param {string} password - 当前应用锁密码
   * @param {string} code - 当前动态码或恢复码
   * @returns {Promise<RecoveryResult>} 新恢复码明文列表（仅此一次）
   */
  async function regenerateRecovery(password: string, code: string): Promise<RecoveryResult> {
    const res = await window.ipcRenderer.handlePromise("app-lock:2fa-recovery-regenerate", { password, code });
    return { ok: !!res?.ok, recoveryCodes: res?.recoveryCodes, error: res?.error };
  }

  return {
    locked,
    hasPassword,
    onStartup,
    onRestore,
    twoFactorEnabled,
    init,
    setPassword,
    verify,
    clearPassword,
    unlock,
    verify2fa,
    lock,
    setOnStartup,
    setOnRestore,
    get2faConfig,
    enrollStart,
    enrollConfirm,
    enrollCancel,
    disable2fa,
    regenerateRecovery,
  };
});

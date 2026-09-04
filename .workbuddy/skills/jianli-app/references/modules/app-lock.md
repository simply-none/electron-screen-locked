# 应用锁 / 隐私模式 (app-lock)

## 职责
应用锁（密码锁屏 + 2FA 门禁 + 隐藏小窗防窥）与隐私模式（老板键一键隐藏/恢复全部窗口）。锁定态权威在主进程，广播同步渲染端。

## 关键文件
- 主进程：`electron/main/module/appLock.ts`（`initAppLock()`：IPC + 广播 + 启动/恢复锁定 + 老板键 + 门禁接入）
- 主进程门禁子系统：`electron/main/module/appLock2fa.ts`（2FA 两步验证：信封存储 / 待验证会话 / 恢复码 / 冷却 / `app-lock:2fa-*` 通道族；由 `initAppLock()` 末尾注入 `verifyPassword`/`unlockAppNow` 初始化，避免循环依赖）
- TOTP 引擎：`electron/main/module/twoFactor/otp.ts`（`generateTotp` / `verifyTotpCode` ±1 步 + timingSafeEqual / `buildOtpauthUri` / `randomBase32Secret`）
- 快捷键分发：`electron/main/module/registerShortcut.ts` 的 `globalShortcutFn` 新增 `lock_app` / `privacy_hide` 分支
- 渲染端 store：`src/store/useAppLock.ts`（锁定态 + 配置开关 + 两步解锁动作 + 门禁管理动作）
- 锁屏遮罩：`src/layout/AppLock.vue`（挂 `src/layout/index.vue`，两步状态机 password→totp）
- 动态码输入步：`src/layout/components/AppLockTotpStep.vue`（6 位码 / 恢复码切换、满 6 位自动提交）
- 设置 UI：`src/views/setting/components/AppLockSetting.vue`（安全与隐私区块，含 2FA 行）
- 门禁向导：`src/views/setting/components/TwoFactorGateWizard.vue`（enroll 开启 / regenerate 重生成恢复码；QrCodeView 内联展示 otpauth 二维码）
- 命令面板：`actionSource.ts` 的 `action:lock-app`

## 密码安全（2026-09 重构后现状，旧 RSA 方案已废弃）
- 密码以「用户口令为密钥」用 `vault/crypto.ts` 的 AES-256-GCM + PBKDF2（200k 迭代）加密哨兵串 `__app_lock_sentinel__`，信封存 `basic_info` 表 **`appLockVault`** 键
- 校验 `verifyPassword()`：解密成功且含哨兵即口令正确；GCM 认证失败即密码错误；全部异步 `ipcMain.handle`
- 明文密码不落任何存储；旧 `RSAKey`/`appLockPassword` 启动时由 `migrateLegacySecrets()` 清理（强制重新录入策略）
- 历史教训保留：加密原语统一走 `vault/crypto.ts` 封装，勿自行拼 `node:crypto` 参数

## 2FA 门禁（两步验证，2026-09-04 新增）
- **流程**：`app-lock:unlock` 密码步通过 → 若门禁启用：**不解锁**，创建「待 2FA 会话」（token 绑定发起窗口 `webContents.id`，120s TTL）返回 `{matched, need2fa, token}` → 渲染端 `AppLockTotpStep` 凭 token 调 `app-lock:verify-2fa` 提交 6 位动态码或恢复码 → 通过才 `unlockAppNow()` 并广播。全部锁定路径（手动/快捷键/启动 4s/恢复 8s/命令面板）统一强制。
- **密钥存储**：`basic_info` 键 **`appLock2faVault`** = `{ v, envelope, createdAt, confirmedAt, recoveryRemaining }`；envelope 内 `{ secret, recoveryHashes, SHA1/6位/30s }` 由**应用锁密码**加密（改密码时 `rewrap2fa` 用新密码重加密）。**与 2FA 保险库完全独立**（不依赖用户打开过保险库，启动锁定也能校验）。
- **恢复码**：启用时生成 10 条 `xxxxxx-xxxxxx`（明文仅向导展示一次），主进程只存 SHA-256 哈希，命中即消耗回写；设置页可重新生成（旧码作废）。忘记密码 + 丢失全部恢复码 = 无法解锁（无后门）。
- **冷却**：密码步 + 动态码步共用主进程内存计数，连续错 5 次 → 30s 冷却（`registerLockFailure` / `isCoolingDown`），渲染端仅做倒计时展示（旧纯前端冷却已移除）。计数不持久化，应用重启清零。
- **双因子关闭**：关闭门禁 / 重新生成恢复码需「密码 + 当前动态码或恢复码」，防止拿到未锁电脑的人直接拆掉门禁。
- 向导二维码经 `QrCodeView` 内联渲染，**不写 qr_history**（otpauth URI 含密钥，见 twoFactor.md 红线）。

## 配置键（basic_info）
- `appLockVault`：密码哨兵信封（AES-GCM）
- `appLock2faVault`：2FA 门禁信封（AES-GCM，密钥绑定应用锁密码）
- `appLockOnStartup`：启动时锁定（bool，**默认 false，用户开启才触发**）
- `appLockOnRestore`：最小化恢复时锁定（bool，默认 false）

## IPC 通道
| 通道 | 类型 | 用途 |
|---|---|---|
| `app-lock:set-password` | handle | 设置/修改密码；修改时传 `current`，门禁启用时用它解旧信封重加密 |
| `app-lock:verify` | handle | 校验密码（不改变锁定态） |
| `app-lock:clear-password` | handle | 验证后清除密码并解锁；**门禁数据一并清除** |
| `app-lock:unlock` | handle | 密码步；门禁启用返回 `{matched,need2fa,token}`，失败带 `remainingAttempts`/`retryAfterSeconds` |
| `app-lock:verify-2fa` | handle | 第二步：`{token,code}` → 动态码/恢复码校验，通过即解锁并广播 |
| `app-lock:lock` | handle | 立即锁定 |
| `app-lock:get-state` | handle | 状态快照（locked/hasPassword/onStartup/onRestore/twoFactorEnabled） |
| `app-lock:config-changed` | on | 渲染端改开关后通知主进程 |
| `app-lock:state-changed` | 广播 | 主→所有窗口同步锁定态 |
| `app-lock:2fa-get-config` | handle | 门禁快照 `{enabled,enrolledAt,recoveryRemaining}`（不回传密钥） |
| `app-lock:2fa-enroll-start` | handle | `{password}` 验密 → 暂存密钥（5min TTL）→ 返回 otpauth URI + 密钥文本（仅此一次） |
| `app-lock:2fa-enroll-confirm` | handle | `{code}` 动态码确认 → 落库信封 + 生成 10 条恢复码（明文仅此一次） |
| `app-lock:2fa-enroll-cancel` | handle | 清暂存注册会话（向导关闭/上一步时调） |
| `app-lock:2fa-disable` | handle | `{password,code}` 双因子确认后删键 |
| `app-lock:2fa-recovery-regenerate` | handle | `{password,code}` 双因子确认后重生成恢复码 |

## 锁定/解锁流程
- **锁定** `lockAppNow()`：幂等（已锁直接返回）→ 隐藏全部非主窗口（记录到 hiddenWindows）→ 置 isLocked → 广播 → 主窗口 show+focus
- **解锁** `unlockAppNow()`：清态 → 广播 → 按原窗口对象 show 恢复 hiddenWindows
- **启动锁定**：init 后延迟 4s 检查开关 + 已设密码才触发
- **恢复锁定**：监听主窗口 `restore`/`show`，有 8s 启动保护期（避免与启动锁定/首次显示重复），且 isLocked 幂等防事件循环

## 隐私模式（老板键）`togglePrivacyHide()`
- 有可见窗口 → 全部隐藏（独立记录 privacyHidden，与锁定列表分开）
- 全隐藏 → 显示主窗口；**锁定态下不恢复小窗**（保持隐私）
- 用户在快捷键页绑定 `privacy_hide` 触发

## 特有坑 / 注意
- 渲染端锁定态唯一来源是主进程广播，渲染端**不自行判定**锁定（避免多窗口状态漂移）
- `restore`/`show` 事件回调是异步判定（shouldLockOnRestore 读库），isLocked 置位必须在 show() 之前防重入
- **冷却计数在主进程内存**（appLock2fa.ts），跨渲染端刷新有效但应用重启清零
- **改密码必须传 `current`**：门禁信封用密码加密，缺 current 无法迁移（`set-password` 返回错误；渲染端修改模式已自动携带）
- 待 2FA 会话绑定 `sender webContents.id`，渲染进程重载 / 换窗口提交旧 token 会得到「会话已失效」
- 改密码成功后旧待验证会话已被清空（rewrap2fa 内处理），需重走密码步
- TOTP 依赖本机系统时间同步（时钟漂移大时用恢复码兜底）
- 快捷键动作类型新增必须同时改 `registerShortcut.ts` 分发与 `registerShortcut/index.vue` 配置列表
- 主进程改动需重启 Electron 生效

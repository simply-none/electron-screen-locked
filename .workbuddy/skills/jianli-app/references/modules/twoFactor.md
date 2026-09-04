# 2FA 动态验证码（two-factor）

## 职责
本地 TOTP 验证器（对标 Google Authenticator / 1Password / Bitwarden 的 2FA 模块）：录入账户 → 本地按时间生成 6/8 位动态码 → 倒计时展示 → 一键复制。密钥**只**存在于用户自持的加密保险库文件 + 主进程内存，绝不进入应用数据库。

## 关键设计决策（与用户确认）
- **密钥不进应用数据库**：用 `AES-256-GCM`（PBKDF2 派生口令）加密保存在一个用户自持的保险库文件（`.json` 信封）。应用 `basic_info` 只记录非机密的「上次路径」偏好。
- **扫码添加 + 导出二维码**：复用项目二维码能力层（`@/components/qrcode`、`@/utils/qrcode`）。
- **增删改回写同一文件**：保险库文件始终是唯一真相源；解析/导入时不落库、不自动缓存。
- **锁屏不清空内存**：复用应用锁，锁屏只隐藏窗口，解锁后保险库仍可用（摩擦最小）。

## 文件结构（原子化拆分）
### 主进程（改完需重启 Electron）
- `electron/main/module/twoFactor/otp.ts` — base32 解码 + HMAC TOTP + `buildOtpauthUri`（纯函数，零依赖）
- `electron/main/module/twoFactor/vault.ts` — `AES-256-GCM` 加解密 + 文件读写（`encryptVault`/`decryptVault`/`writeVaultFile`/`readVaultFile`）
- `electron/main/module/twoFactor/types.ts` — `TwoFactorAccount` / `TwoFactorAccountMeta`
- `electron/main/module/twoFactor.ts` — `initTwoFactor()` 注册全部 IPC + 内存保险库
- 注册：已在 `electron/main/index.ts` 的 `createWindow()` 末尾 `initTwoFactor()`

### 渲染端
- `src/store/useTwoFactor.ts` — Pinia store（状态 + 动作封装）
- `src/views/twoFactor/index.vue` — 主视图（空态 / 列表 / 工具条）
- `src/views/twoFactor/types.ts` — 类型
- `src/views/twoFactor/utils/otpauth.ts` — `parseOtpauthUri` 纯函数
- `src/views/twoFactor/api/twoFactorApi.ts` — IPC 封装
- `src/views/twoFactor/composables/useTwoFactorCodes.ts` — 每秒倒计时，周期边界才重取码
- `src/views/twoFactor/components/`：`CountdownRing` `SecretInput` `AccountCard` `AccountList` `VaultGate` `AddAccountDialog` `ExportVaultDialog`

### 路由 / 菜单
- `src/router/index.ts` — `RouteNames.TWO_FACTOR` + `layoutRouters`（`/twoFactor`）
- `src/layout/index.vue` — 「效率工具」组 `names` 加 `twoFactor`（侧边栏入口）
- `src/utils/index.ts` — `iconMap.twoFactor = 'KeyRound'`
- `routeSetting` 可见开关由 `layoutRouters` 自动接管

## IPC 通道（全部 `two-factor:*`）
| 通道 | 类型 | 用途 |
|---|---|---|
| `two-factor:pick-open` | handle | 原生对话框选已有文件 |
| `two-factor:pick-save` | handle | 原生对话框选保存路径 |
| `two-factor:open-vault` | handle | 导入并解密（返回脱敏列表） |
| `two-factor:create-vault` | handle | 新建保险库 |
| `two-factor:list` | handle | 状态快照 + 脱敏账户列表 |
| `two-factor:get-codes` | handle | 取全部验证码（**无 secret**） |
| `two-factor:add-account` | handle | 新增（回写文件） |
| `two-factor:update-account` | handle | 编辑（回写文件） |
| `two-factor:delete-account` | handle | 删除（回写文件） |
| `two-factor:export` | handle | 导出/另存为（可换口令） |
| `two-factor:export-uri` | handle | 生成 otpauth URI（含密钥，仅用于展示二维码） |
| `two-factor:close` | handle | 清空内存保险库与口令 |

## 二维码复用点
- **扫码添加**：`AddAccountDialog` 的「扫码录入」用全局 `QrDropZone`（`@decoded` → `decodeQr` 已多尺度重试）；结果 `data` 以 `otpauth://` 开头时 `parseOtpauthUri` 预填表单。`decodeQr` 返回的 `data` 已是 UTF-8 字符串，**禁止二次解码**。
- **导出二维码**：`AccountCard`「二维码」按钮调 `showQrCode({ content: otpauthUri })`（命令式服务）展示该账户 `otpauth://` 二维码，供其他验证器扫码迁移。

## 安全红线
- 密钥明文仅主进程内存 + 加密文件；`get-codes` 只回传 `code/nextCode/remaining`，绝不回传 `secret`。
- **禁止把 `otpauth://` URI 写入 `qr_history`**（其文本含密钥，会经 `history.ts` 落 `qr_history` 表 → 泄漏）。扫码解析后只取字段，不落历史。
- 复用应用锁：锁屏隐藏全部窗口，2FA 视图随之隐藏。

## 特有坑 / 注意
- 改主进程必须重启 Electron。
- 渲染端禁 `import electron/*`；所有库/磁盘操作走 IPC。
- TOTP：`base32` 大小写/空格清洗；`algorithm` SHA1/256/512；`digits` 6/8；`period` 30/60；动态截断取末尾字节低 4 位；依赖本机系统时间（UI 已提示保持时间同步）。
- `otpauth://`：`label` 可能是 `issuer:account` 且 URL-encoded；`issuer` 查询参数优先于 label。
- 计时：每秒只更新本地 `remaining`，周期边界才重算（避免无谓 HMAC/IPC）。
- 主题色走 CSS token（`--bg-base/card`、`--color-primary` 等），适配 25 套主题。
- 与既有架构一致：菜单入口 + 路由可见开关（routeSetting 自动接管），遵循「新需求落地清单」。

## 本应用 2FA（测试小窗验证链路）
- 用途：把 2FA 作为「渐离App 自身」的第二因素验证链路，端到端验证 TOTP 引擎 + 二维码导出 + 保险库。**注意：真实的应用锁门禁（启动/锁屏强制两步验证）已于 2026-09-04 落地在 `appLock2fa.ts`，密钥独立存 `basic_info(appLock2faVault)`，与本节的保险库链路无关**（见 `app-lock.md`）；本节 `app-2fa:*` 仍保留为测试链路。
- 本机账户：注册时以固定 key `app:self`、label `渐离App·本机` 写入保险库（随 `safeWriteBack` 回写文件），于是 2FA 页面会显示其动态码（`list`/`get-codes` 同样可见，脱敏）。
- 新增 IPC（`app-2fa:*`）：
  - `app-2fa:enroll`：生成随机 base32 密钥（`randomBase32Secret`，默认 20 字节）→ 写入保险库 → 返回 `buildOtpauthUri` 二维码内容（手机扫码即完成真实二步注册）。
  - `app-2fa:verify(code)`：取 `app:self` secret，用 `generateTotp` 计算当前及前后各一步（±1 步容错），命中即 `{ok:true}`。
  - `app-2fa:status`：返回 `enrolled`。
  - `app-2fa:open-page`：主进程 `win.show()` + `win.webContents.send('open-match-page','twoFactor')` 让主窗口聚焦并跳 2FA 页。
- 密钥生成：`otp.ts` 新增 `base32Encode` + `randomBase32Secret`（node:crypto）；校验统一走 `verifyTotpCode(secret, code, opts)`（±1 步容错 + `timingSafeEqual` 防时序，2026-09-04 抽出，`app-2fa:verify` 与应用锁门禁共用）。
- 小窗四件套（复用项目框架）：`src/views/appTwoFactorMiniWindow/`（index.vue 薄壳 + components/AppTwoFactorPanel.vue）；路径 `/appTwoFactorMiniWindow` 须与 `open-new-window` arg 一致；`useWindowMode` 加 `openAppTwoFactorMiniWindow`/`appTwoFactorMiniWindowConfig`（含 `mouseEvents:true`、关用 `hide-new-window`）；`windowSections.ts` 登记（`KeyRound` 图标）；`useWindowModeSetting` 的 `storeConfigMap/showSetterMap/storeVisibleMap` 补 `appTwoFactor`；`registerShortcut.ts` 加 `open_app_2fa_window` 快捷键（`DEFAULT_APP_2FA_CONFIG`）。
- 验证流程：2FA 页「2FA 测试小窗」按钮 / 快捷键唤起 → ① 小窗「注册并生成二维码」→ ② 小窗「打开 2FA 页面看动态码」→ ③ 手输码点「验证」→ 主进程同密钥重算比对返回成功。输错码验证失败，证明是真计算而非写死。
- 改动主进程需重启 Electron。

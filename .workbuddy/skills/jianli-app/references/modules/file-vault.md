# 私密文件保险箱（fileVault）

## 职责
本地 AES-256-GCM 加密存储敏感文件（文档 / 图片 / 证书 / 密钥文件等）：解锁后才能查看、预览、导出。复用项目统一安全底座 `vault/crypto.ts`（与密码保险库、2FA 同源），渲染端只经 IPC，绝不持有明文与密钥。文件名走**方案 A（加密）**：原名也用 `dataKey` 加密，库里只存密文，连 SQLite 都看不到真实文件名。

## 关键设计决策（与用户确认）
- **密钥层级（数据密钥 + 口令加密密钥）**：`dataKey` 随机 32 字节，仅驻留主进程内存；`KEK = PBKDF2(password, salt, 200000, 32, sha256)`；`wrappedKey = AES-256-GCM(KEK, dataKey)` 落库 `file_vault_config`。每文件用 `dataKey` 加密，密文落独立目录（文件名随机 uuid + `.jlv`）。
- **`.jlv` 自描述格式（修复「解密后文件名为未命名」）**：`import` 写盘时头部嵌入原始文件名与扩展名——`JLV1`(4B) + metaLen(uint32 BE) + JSON 元数据 `{"name","ext"}` + iv(12B) + ct；`export`/`decrypt-temp`/`import-decrypt`/`import-decrypt-bytes` 均经 `parseCipher(buf)` 解析，按魔数自动区分**新格式**与**旧格式（仅有 iv+ct，文件名只存于 DB）**，旧文件仍可解密但无内嵌名（回退 `guessExt` / 文件名去 `.jlv`）。右键「解密(.jlv)」走 `import-decrypt`（路径通道，返回 `name`），从此能还原真实文件名。
- **改密码 = 仅重 wrap `dataKey`**，无需重加密所有文件（相对「每文件派生口令密钥」方案的核心优势）。
- **锁定 = 清零内存 `dataKey` + `vaultPass`**，保留路径。
- **文件名加密（方案 A）**：`original_name` 用 `dataKey` 加密后存库（`file_vault_files.name`）；未解锁时列表为空、搜索只能在解锁后可用。代价 = 库泄露也不暴露文件名（内容本就不可读）。
- **密文目录独立于 DB**：`fileCachePath/渐离App保险箱/`，文件过大不进 SQLite。

## 文件结构（原子化拆分）
### 主进程（改完需重启 Electron）
- `electron/main/module/fileVault.ts` — `initFileVault()`：建表（`file_vault_config` / `file_vault_files`，主键 TEXT）+ 注册全部 `file-vault:*` IPC + 内存态 `dataKey/vaultPass`
- 复用 `electron/main/module/vault/crypto.ts` 的 `encryptBytes` / `decryptBytes` / `deriveKey`（AES-256-GCM，PBKDF2 200000）
- 注册：已在 `electron/main/index.ts` 的启动流程里 `initFileVault()`

### 渲染端
- `src/views/fileVault/types.ts` — `VaultFileMeta` / `VaultStatus` / `DecryptTempResult` / `ExportResult`
- `src/views/fileVault/api/fileVaultApi.ts` — `file-vault:*` IPC 封装（薄封装 `window.ipcRenderer.handlePromise`）
- `src/views/fileVault/store/useFileVault.ts` — Pinia store（状态 + 动作，委托 api，不持明文）
- `src/views/fileVault/index.vue` — 主视图（未建库 / 未解锁 / 已解锁三态 + 自动锁定 UI）
- `src/views/fileVault/components/`：`UnlockView`（首次设密·解锁）· `FileGrid`（VirtualList 虚拟化卡片）· `ImportDialog`（原生多选→逐文件加密）· `PreviewDialog`（解密临时文件经 `jlocal:///` 预览，关闭即清临时明文）· `DecryptImportDialog`（拖拽/选择 `.jlv` → 已解锁时解密 → 内嵌预览 → 另存为明文）

### 路由 / 菜单
- `src/router/index.ts` — `RouteNames.FILE_VAULT` + `layoutRouters`（`/fileVault`）
- `src/layout/index.vue` — 「效率工具」组 `names` 加 `fileVault`（侧边栏入口）
- `routeSetting` 可见开关由 `layoutRouters` 自动接管

## IPC 通道（全部 `file-vault:*`，主进程 handle）
| 通道 | 用途 |
|---|---|
| `file-vault:set-password` `{password}` | 首次设密，生成 dataKey → 派生 KEK → wrap 落库 |
| `file-vault:unlock` `{password}` | 派生 KEK 解 wrap；口令错则 GCM 认证失败返回「口令错误」 |
| `file-vault:lock` | 清空内存 dataKey/口令 + 清理预览临时目录 |
| `file-vault:status` | 返回 `{hasVault, isUnlocked}` |
| `file-vault:list` | 解锁后主进程用 dataKey 解密文件名，返回脱敏元数据列表 |
| `file-vault:pick-import` | 原生多选对话框，返回源文件路径数组 |
| `file-vault:import` `{sourcePath, name?, deleteSource?}` | 读源文件→加密落盘→写脱敏元数据（原名加密）；`deleteSource=true` 时再安全删除原文件（随机覆盖 + unlink），避免明文原文件残留在原位置 |
| `file-vault:pick-export-dir` | 原生目录选择，返回导出目录 |
| `file-vault:export` `{id, destDir}` | 解密写出目标目录 |
| `file-vault:decrypt-temp` `{id}` | 解密到临时目录，返回 `tempPath`（渲染端用 `jlocal:///` 预览） |
| `file-vault:cleanup-temp` | 清空预览临时目录（防磁盘残留明文） |
| `file-vault:delete` `{id}` | 删元数据 + 删密文 |
| `file-vault:pick-import-decrypt` | 原生多选对话框（过滤 `.jlv`），返回源文件路径数组 |
| `file-vault:import-decrypt` `{sourcePath}` | **导入解密（路径通道）**：要求已解锁；读 `.jlv` → 用内存 `dataKey` 解密到临时目录（明文不过 IPC），返回 `{tempPath, ext, name}`（`name` 取自 `.jlv` 内嵌元数据，旧格式为 undefined）；非本保险箱/损坏会 GCM 失败报错 |
| `file-vault:import-decrypt-bytes` `{name, buffer}` | **导入解密（字节通道）**：渲染端读文件字节后传入（绕开本地路径依赖），主进程解密写临时目录，返回 `{tempPath, ext, name}`；用于打包后 `file://` 页面拖拽导致 `File.path` 为空的环境（见「导入解密」小节的拖拽取路径坑） |
| `file-vault:save-plain` `{tempPath, destDir, name}` | 把解密后的临时明文另存到目标目录（主进程落盘，文件名防穿越清洗） |
| `file-vault:cleanup-import-decrypt` | 清空导入解密临时目录 |
| `file-vault:secure-delete` `{paths}` | 安全删除（碎纸机）：遍历 `paths` 调 `secureDeleteFile`（随机覆盖 + unlink）后返回 `{ok, deleted}`；**无需解锁**，供资源管理器右键「安全删除」调用 |

## 安全红线
- 明文文件内容绝不写应用数据库（newSql / basic_info 只读写 vault 配置与脱敏元数据）。
- `dataKey` / 口令仅驻留内存，`lock` 时清零。
- 预览先解密到临时目录、用完即清（关闭预览 / 锁定均触发 `cleanup-temp`）。
- **方案 A 强隐私**：未解锁时 SQLite 元数据里只有密文文件名，资源管理器 / SQLite 均看不到真实文件名。
- **备份红线**：数据库级 `.jlbak` 整库快照会包含 `file_vault_*`，但它们由口令派生 KEK 保护（无口令无法解开 dataKey）；且「数据导出中心」已通过 `backup.ts` 的 `EXPORT_EXCLUDE_PREFIXES = ["file_vault_"]` 排除，不会在导出中心枚举 / 导出这些表。

## 自动锁定（② 新增）
- **共享 composable**：`src/composables/useAutoLock.ts`（原 passwordVault 私有版已提升为共享，避免重复实现）。
- `index.vue` 解锁后 `watch(store.isUnlocked)` 启动监听；触发条件 = 窗口失焦 / 页面隐藏(`visibilitychange:hidden`) / 空闲超时，任一即 `store.lock()` 清空主进程内存密钥。
- 工具栏新增「自动锁定」下拉：1 / 5 / 10 / 15 / 30 分钟，`checkIdle` 每次实时读取最新阈值。
- 导入 / 导出走原生文件对话框时会 `pause()` 自动锁定、关闭后 `resume()`，避免失焦误锁。

## 命令面板入口
- `FILE_VAULT` 路由已在 `layoutRouters` 内，命令面板 `routeSource` 自动派生该入口——搜「保险箱 / fileVault」即可直达，无需在 `actionSource.ts` 重复登记。

## 资源管理器右键菜单（③ 新增）
- **目标**：Windows 资源管理器右键任意文件出现「通过渐离App打开」菜单，把文件交给保险箱对应流程，无需手动打开 App 再导入。
- **注册（Windows 专属）**：新增主进程模块 `electron/main/module/shellMenu.ts`（`registerShellMenu()`），在 `createWindow()` + `initFileVault()` 之后调用。
  - **Windows 11 真正支持折叠子菜单的唯一纯注册表方案是 `SubCommands` + `HKEY_LOCAL_MACHINE\Software\Microsoft\Windows\CurrentVersion\Explorer\CommandStore\shell`（需管理员）**；per-user 本地 `shell\<id>` 只能得到箭头却无法展开（已踩坑）。
  - `registerShellMenu()` 逻辑：**先尝试 HKLM CommandStore 级联**（父菜单 `HKCU\*\shell\JianliApp` 的 `MUIVerb`=「通过渐离App打开」+ `SubCommands`=`JianliApp.Encrypt;JianliApp.Decrypt;JianliApp.SecureDelete` 引用 HKLM 子命令）；**无权限则自动 fallback 为三个独立 HKCU 一级菜单**（`HKCU\*\shell\JianliApp.JianliApp.Encrypt|Decrypt|SecureDelete`，显示名「通过渐离App打开：加密到保险箱」等），功能等价但无折叠。
  - 命令格式：`"<exe>" [<仓库目录>] --vault-encrypt/--vault-decrypt/--vault-secure-delete "%1"`（dev 下 `process.execPath` 是 electron.exe，需额外传仓库目录）。
  - `registerShellMenuElevated()`：用 `PowerShell Start-Process -Verb runAs` 提权启动自身 `--register-shell-menu-elevated` 参数；`index.ts` 在 `requestSingleInstanceLock` 之前拦截该参数，仅执行 `registerShellMenu()` 然后 `app.quit()`，不进入正常 App 生命周期。
  - **dev / 打包模式均自动注册**；`scripts/register-shell-menu-dev.cjs` 作为手动兜底：`--cascading`（UAC 提权 HKLM 级联）/ 默认（HKCU 扁平三项）/ `--unregister`。
- **启动参数路由**：`app.on('second-instance')` 改造为解析 argv 里的 `--vault-*` 标志（`parseCliFiles`），连同首次启动的 `process.argv` 一起入队 `queueCli`；渲染端主窗口就绪后主进程 `flushPending(win)` 经 `app:cli-open` 逐条下发。多选文件会多次触发 `second-instance` → 队列聚合成一批，规避「`%1` 只传首文件」的坑。
  - **防误收集仓库目录**：dev 模式下注册表命令形如 `"<electron.exe>" "<仓库目录>" --vault-encrypt "%1"`，`parseCliFiles` 必须显式排除 `process.execPath` 与 `app.getAppPath()`，并在最后把结果过滤为「真实存在的文件（`fs.statSync(...).isFile()`）」，否则会把仓库目录当成待加密文件列出来（曾导致右键加密时多出一个 `electron-vite-vue` 代码库项）。index.ts 调用 parseCliFiles 时传入 `{ exePath: process.execPath, appDir: app.getAppPath() }`。
  - **首启竞态**：渲染端 `App.vue` 挂载后 `send('app:cli-ready')`，主进程 `ipcMain.on('app:cli-ready')` 时再 `flushPending(win)`，避免「消息早于监听注册」丢失。
  - **应用隐藏到托盘时必须先 `showApp()`**：`second-instance` 里若仅 `if(win.isMinimized()) win.restore(); win.focus();`，当 App 被「隐藏到托盘」（`hideApp()` → `win.hide()`）时 `isMinimized()` 为 false、`focus()` 无法让隐藏窗口重新可见，右键触发的解密/加密/安全删除弹窗会在后台静默执行、用户完全看不到。故 `second-instance` 必须改用 `mainWindow.ts` 的 `showApp()`（无论最小化还是隐藏到托盘都先 `restore`+`show`+`focus`），再 `flushPending(win)`。
- **渲染端接线（不再跳转保险箱页）**：`App.vue` 常驻监听 `app:cli-open` → **仅** `store.setPendingCli(item)`（已移除 `router.push(FILE_VAULT)`，避免强制跳转到保险箱列表页）；新增全局组件 `components/FileVaultCliHandler.vue`（常驻 `App.vue` 模板根级）`watch(pendingCli)` 消费：
  - `secure-delete` → 直接 `ElMessageBox.confirm` 后调 `file-vault:secure-delete`（**无需解锁、不跳转**）；
  - `encrypt` → 已解锁直接弹 `ImportDialog`（传 `initialFiles` 预填，复用 `importFiles` + 默认安全删除源文件）；未解锁（或从未创建）先弹全局 `UnlockView`，解锁成功后由 `onUnlocked` 自动打开 `ImportDialog`；
  - `decrypt` → 已解锁直接弹 `DecryptImportDialog`（传 `initialFiles` 预填，复用 `import-decrypt*`）；未解锁先弹解锁门，解锁后自动打开。
  - 这样右键任意文件即可**直接执行**保险箱对应功能；涉及解锁的「解锁后自动继续」，而非一次性不处理。
- **保险箱页 `index.vue`**：仅保留「手动进入页面后的解锁门 + 工具栏导入/解密/锁定 + 列表预览导出删除」，已移除全部右键 `pendingCli` / `applyPending` 逻辑（右键值由全局处理器独占消费，避免重复触发）。
- **新增主进程文件**：`electron/main/module/shellMenu.ts`（HKLM 级联注册 + HKCU 扁平 fallback + UAC 提权 + 启动参数解析/队列；dev / 打包均自动注册）；`fileVault.ts` 仅新增 `file-vault:secure-delete` 一个 IPC。
- **新增渲染端组件**：`components/FileVaultCliHandler.vue`（右键全局处理器，常驻 App.vue）。
- **改动文件**：`electron/main/index.ts`（注册 + `--register-shell-menu-elevated` 拦截 + second-instance + cli-ready + 首启 argv）、`api/fileVaultApi.ts`（secureDelete）、`store/useFileVault.ts`（pendingCli/setPendingCli/clearPendingCli/secureDeleteFiles）、`App.vue`（cli-open 改为仅 setPendingCli + 挂载 FileVaultCliHandler，移除 router.push）、`FileVaultCliHandler.vue`（新增，右键全局处理）、`index.vue`（移除右键处理，保留手动解锁门/工具栏）、`ImportDialog.vue`/`DecryptImportDialog.vue`（initialFiles prop）。

## 导入解密（拖拽 / 选择 .jlv）
- **定位**：「导出解密」的逆通路——把磁盘上的 `.jlv`（来自本保险箱的导出 / 备份 / 另存）恢复为明文。
- **入口**：解锁后工具栏「导入解密」按钮 → 原生选择器（过滤 `.jlv`，走路径通道）或把 `.jlv` 拖入对话框的拖拽区（`@drop`）。
- **拖拽取路径（关键坑与回退）**：拖拽时优先用 `File.path` 走路径通道（dev/部分环境可用）；**打包后 `file://` 页面下 Chromium 安全限制会让 `DataTransfer.files[i].path` / `.name` 为空**，导致无法识别 `.jlv` 而误报「仅支持 .jlv」。故 `onDrop` 在拿不到 path 时自动回退「读 `File.arrayBuffer()` → `import-decrypt-bytes` 字节通道」，**任何环境拖拽都能解密**。按钮选择始终走 path 通道（100% 可靠）。
- **权限**：主进程 `import-decrypt` 首行 `if (!dataKey) return {ok:false, error:'未解锁'}`；未解锁时入口不可达，且 UI 提示先解锁。对应「在有权限的情况下解密该文件」。
- **解密与预览**：主进程解密到 `temp/渐离App保险箱导入解密/<uuid>.<ext>`，临时路径经 `jlocal:///` 内嵌预览（图片 / PDF / 音频 / 文本；其他类型提示「另存后查看」）；输出文件名优先级：`.jlv` 内嵌 `name`（新格式）> 拖入/选中的文件名去 `.jlv`（字节/路径通道回退）> `guessExt()` 推断的 `未命名.<ext>`；扩展名同理优先内嵌 `ext`。
- **另存为明文**：逐项「另存为」→ 原生目录选择 → 主进程 `save-plain` 复制到目标（文件名做 `\/?:*?"<>|` 清洗防穿越）。明文只在用户指定目录落地，符合预期。
- **非本保险箱**：用其它保险箱 `dataKey` 加密的 `.jlv` 解码时 GCM 认证失败，返回「解密失败：该文件不属于当前保险箱或已损坏」。
- **彻底清理**：对话框关闭 / 页面卸载均调用 `cleanup-import-decrypt`，清空临时明文目录，防磁盘残留。

## 特有坑 / 注意
- 改主进程（fileVault.ts / crypto.ts）**必须重启 Electron**。
- 渲染端禁 `import electron/*`；所有库 / 磁盘操作走 IPC。
- **忘记密码 = 不可恢复**（无后门，设计如此，UI 需显著提示）。
- 密文目录 Windows 下权限；导出后明文及时清理；预览临时文件及时删。
- **导入即「移入」语义**：加密副本落盘后默认安全删除原文件（`ImportDialog` 开关「导入后删除原文件」默认勾选），否则明文原文件仍躺在原位置会被误认为「加密未生效」。
- 主题色走 CSS token（`--bg-base/card`、`--color-primary` 等），适配 25 套主题。
- 与既有架构一致：侧边栏入口 + 路由可见开关（routeSetting 自动接管），遵循「新需求落地清单」红线 8。

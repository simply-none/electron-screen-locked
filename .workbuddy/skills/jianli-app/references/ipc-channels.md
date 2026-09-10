# IPC 通道契约（ipc-channels）

> 渲染端统一经 `src/utils/common.ts` 的 `getStore` / `setStore` / `send` / `sendSync` / `invoke` → `window.ipcRenderer.*`。通道名多为字符串常量，分三类：请求-响应（invoke/handle）、单向通知（send/on）、主→渲染推送（webContents.send / ipcRenderer.on）。

## 数据层 / 存储
| 通道 | 方向 | 用途 |
|---|---|---|
| `new-sql:query` | 渲染→主 | 通用查询（支持顶层 `SqlStr` 或 `conditions.SqlStr`） |
| `new-sql:count` | 渲染→主 | 计数 |
| `new-sql:insert` / `upsert` / `update` / `delete` | 渲染→主 | 增 / 按主键覆盖 / 改 / 删 |
| `new-sql:record-pomodoro` | 渲染→主 | 番茄钟记录写入 |
| `new-sql:execute` | 渲染→主 | ❌ 危险，**禁用** |
| `new-sql:explain` / `transaction` / `get-table-list` | 渲染→主 | 执行计划 / 事务 / 表列表 |
| ~~`query-data` / `set-data` / `delete-data`~~ | 渲染→主 | **已弃用**（2026-08-30 渲染端全部迁移到 `new-sql:*` 三件套，主进程保留注册仅供 `basic_info`/`clipboard_history` 兜底与主进程内部使用，新代码禁用） |
| `get-store` / `set-store` / `replace-store` / `clear-store` / `get-stort-all` | 双向 | electron-store 读写（注意 `get-stort-all` 疑似拼写错误） |

## 导出统一规范（exportToFile）
> 全应用「导出 / 保存文件」走统一入口 `src/utils/exportToFile.ts`，行为一致：**不弹保存对话框、默认直写缓存目录 `fileCachePath`、成功用 `src/utils/fileNotify.ts` 的 `fileNotify` 提示（蓝色可点击路径）**。详见 `references/export.md`。

| 通道 | 方向 | 用途 |
|---|---|---|
| `export-text-to-cache` | 渲染→主（`sendSync` / `ipcMain.on`+`e.returnValue` 同步） | 文本 UTF-8 直写缓存目录，参数 `{ text, filename, dir? }` → `{ success, path? }` |
| `export-buffer-to-cache` | 渲染→主（同步） | base64 二进制直写缓存目录，参数 `{ base64, filename, dir? }` → `{ success, path? }` |

- `dir` 缺省时主进程回退顺序：`dir` → electron-store `fileCachePath` 设置项 → 用户文档目录。
- 目录不存在主进程自动 `mkdirSync`。
- 安全敏感导出（2FA 密钥库 / 文件保险库解密）**保留用户选择位置**（仍用各自原生对话框），仅成功提示改用 `fileNotify`。

## 提醒引擎 newReminder
| 通道 | 方向 | 用途 |
|---|---|---|
| `get-tips` / `tips-save` / `tips-delete` | 双向 | 读取 / 保存 / 删除提醒 |
| `tips-force-state` / `tips-inject-state` / `tips-end-injected-state` | 渲染→主 | 状态注入 / 强置 |
| `request-tips-state` / `tips-reload` | 渲染→主 | 请求状态 / 重载引擎 |
| `tips-trigger` | 主→渲染 | 提醒到点（`App.vue` 接住弹通知，习惯类唤起打卡小窗） |
| `tips-state-change` / `tips-state-sync` | 主→渲染 | 状态进入（弹通知）/ 同步补偿（不弹） |

## 小窗管理 newWindow
| 通道 | 方向 | 用途 |
|---|---|---|
| `open-new-window` / `close-new-window` / `hide-new-window` / `close-win` | 渲染→主 | 打开 / 关闭 / 隐藏 / 按名关 |
| `sync-data-to-other-window` | 双向 | 跨窗口广播配置与数据 |
| `enable-mouse-click-through` / `disable-mouse-click-through` | 双向 | 透明窗鼠标穿透开关 |
| `get-window-bounds` / `set-window-bounds` | 双向 | JS 拖拽移动坐标 |

## 功能类（主进程模块）
- **备份与恢复**：`backup:get-info` / `backup:create` / `backup:list` / `backup:restore` / `backup:select-backup-file` / `backup:restore-path` / `backup:delete` / `backup:open-dir` / `backup:get-auto-config` / `backup:set-auto-config`；导出：`export:get-modules` / `export:select-dir` / `export:run`（见 `modules/backup.md`）
- **应用锁**：`app-lock:set-password` / `app-lock:verify` / `app-lock:clear-password` / `app-lock:unlock` / `app-lock:lock` / `app-lock:get-state` / `app-lock:config-changed`；广播 `app-lock:state-changed`（见 `modules/app-lock.md`）
- **快捷键**：`register-shortcut`（`globalShortcutFn` 分发 `open_habit_window` / `open_todo_window` / `open_pomodoro_window` / `open_clipboard_window` / `open_command_palette` / `open_quick_note` / `show_app` / `open_match_page`）
- **待办 / 番茄**：`update-todo-reminders` / `start-job` / `stop-job`（→主）；`job-start-tip` / `job-end-tip`（主→渲染）
- **天气 / 定位 / Bing**：`get-weather` / `get-weather-broadcast` / `get-current-position` / `get-bing-image`
- **数据获取（Puppeteer 采集）**：`scraper:run-task` / `stop-task` / `login-start` / `login-finish` / `login-cancel` / `login-list` / `login-delete` / `get-settings` / `set-settings`；主→渲染推送 `scraper:task-progress` / `scraper:task-result`（preload `scraper.*` 命名空间，见 `modules/data-acquisition.md`）
- **系统 / 文件**：`get-fonts` / `get-default-file-path` / `open-file-by-default-app` / `get-installed-apps`；`start-scan` / `copy-files` / `copy-folder` / `rename-files`(+ `-reversed`) / `delete-files`（带 `-progress` 进度）
- **TTS**：`tts:speak` / `tts:stop` / `tts:get-voices` / `tts:is-available` 及 `tts:system:*`
- **电子书**：`ebook:*` 约 40 个（preload 封装，见 `preload/index.ts:54-389`）
- **电子书传书（2026-09-10，不经 preload 封装，渲染端用 `window.ipcRenderer.handlePromise` 直连）**：`ebook:transfer-scan` / `ebook:transfer-list` / `ebook:transfer-download` / `ebook:transfer-upload`（主进程 `module/ebookTransfer.ts`；复用 47124 数据面 `/ebook/*`，与移动端对称，见 `modules/ebook-reader.md`「一键传书」）
- **截图 / 贴纸**：`screenshot:*` / `sticker:*`
- **股票**：`stock:*` 约 30 个（TickFlow，含缓存 / TTL / 自选）
- **加密**：`encrypt-pwd` / `decrypt-pwd` / `compare-pwd`
- **文件互传（局域网批量收发，复用 47124 数据面）**：`transfer:status` / `transfer:scan` / `transfer:pick-files`（#10 支持选目录递归展开）/ `transfer:send` / `transfer:cancel`（取消批次，`{tid}`；tid 经 `file-transfer:progress` 事件带出）/ `transfer:history`（#20 支持 `{limit,offset}` 返 `{data,total}`）/ `transfer:open-received` / `transfer:open-file`（`{path}` 用系统关联程序打开指定历史文件）/ `transfer:open-folder`（`{path}` 在资源管理器定位）/ `transfer:set-auto-accept` / `transfer:set-rename`（#9 rename/overwrite）/ `transfer:set-enc`（#14 加密开关）/ `transfer:recent-peers`（#11 读）/ `transfer:forget-peer`（#11 剔除）/ `transfer:answer-offer`（#15 `{tid,accept}` 答复接收询问）；主→渲染推送 `file-transfer:progress` / `file-transfer:received` / `file-transfer:batch-done` / `file-transfer:incoming-ask`（#15 `{tid,name,count,total}`，preload `on` 透传，仅 `file-transfer:` 前缀；见 `modules/file-transfer.md`）
- **更新**：`get-app-version` / `check-for-update` / `download-update` / `install-update` / `open-external-url`（`download-progress` 主→渲染）
- **主窗口**：`quit-app` / `max` / `set-startup` / `hide-app` / `palette-navigate` / `open-match-page`(主→渲染) / `confirm-hide-app`(主→渲染)

## 命名空间（preload 暴露）
- `tts.*` / `ebook.*` / `clipboard.*` 为封装后的高阶 API；新增 IPC 优先在 preload 加封装再给渲染用。

## ⚠️ 死 / 未接通道（封装前核实）
渲染端发出但主进程未找到 handler：`save-file`、`get-file-list`、`save-debug-data`（可能走 worker 或已废弃）。

## 何时读本文档
需要新增 / 对接任一 IPC 通道，或排查「发了没反应」时。

# 架构总览（architecture）

## 应用定位
渐离App（jianli-app）是一个以「健康 / 效率」为主题的桌面套件：工作时强制休息、护眼、习惯打卡、番茄钟、待办、剪贴板、笔记、电子书、股票、截图、天气、系统信息采集等。
技术栈：Electron + Vue3 + TypeScript + Vite + Pinia + Element Plus + ECharts + sqlite3 + electron-store + epubjs + pdfjs-dist + @vue-flow/* + systeminformation。

## 进程边界（最关键）
- **主进程**：`electron/main/index.ts` 为入口，启动时按顺序初始化各模块；`electron/preload/index.ts` 通过 `contextBridge` 暴露 `window.ipcRenderer` 及 `tts.*` / `ebook.*` / `clipboard.*` 命名空间。
- **渲染进程**：`src/` 下代码，`main.ts` 挂载 Pinia + Router + App。所有与系统 / 磁盘 / 数据库的交互都必须走 IPC，**渲染端严禁 `import electron/*`（含类型）**。
- **改主进程（`electron/**`）必须重启 Electron 才生效**；改渲染端（`src/**`）Vite 热重载即可。
- **小窗**也是独立的 `BrowserWindow`，路由以 `#hash` 形式加载同一份渲染代码（如 `#/habitMiniWindow?isSecondWindow=true`），是独立渲染进程、各自一套 Pinia。

## 目录约定
- `electron/main/module/*.ts`：每个功能的主进程实现，`initXxx()` 注册 IPC 通道。
- `src/views/<module>/`：各业务视图；子目录常见 `api/` `components/` `composables/` `utils/` `config/`。
- `src/store/*.ts`：Pinia store（每个业务一个 `useXxx.ts`）。
- `src/router/index.ts`：`RouteNames` 枚举 + `layoutRouters`（主功能）+ `routers`（顶层 / 小窗）。
- `src/utils/common.ts`：渲染端 IPC 封装（`getStore` / `setStore` / `send` / `sendSync` / `invoke`）。
- `src/components/`：全局组件（`AppDialog`、`VirtualList` 等）。
- `src/smallComponents/`、`src/layout/`：全局布局与小组件。

## 构建与打包
- **开发**：`npm run dev`（先 `prestart` 校验 node>=22，再 vite）。dev server `http://127.0.0.1:3344/`。
- **类型检查**：`vue-tsc --noEmit`（前端）；主进程有独立 noEmit tsconfig，**勿跑 `tsc -p tsconfig.node.json`**（composite emit 污染 git）。
- **打包**：`npm run build` = `increase-memory-limit` + `prestart` + `vue-tsc --noEmit` + `vite build` + `electron-builder`（win=nsis x64，`asar:false`，输出 `release/${version}`）。
- 打包环境 worker 路径与 dev 不同（见 `systemInfo`）；electron-builder 资源走 `public/`。
- 控制台中文乱码：在仓库根目录执行 `chcp 65001`。

## 提醒引擎（单一）
- 所有用户面向的「到点触发」统一由主进程 `electron/main/module/newReminder.ts` 调度（定点/周期/多状态/免打扰 + 番茄钟 + 习惯复用 + 待办截止提醒）。
- `job.ts` 现仅保留工作/休息定时器（`createJob`/`startJobFn`，cron）；待办截止提醒的 cron 调度已并入 newReminder（`syncTodoReminders`），`recurrence.ts` 每日 00:00 懒生成重复待办实例后调用它。
- 改 newReminder / job.ts / recurrence.ts 均**必须重启 Electron**。

## 资源管理器右键菜单 / 外部文件派发
- 统一由主进程 `electron/main/module/shellMenu.ts` 实现（`registerShellMenu()` 启动时注册 + `initShellMenu()` 应用就绪后注册 IPC）。命令定义集中在 `SUB_COMMANDS`（10 条，每条带 `exts` 按扩展名限定显示），`CliAction` 覆盖 `encrypt` / `decrypt` / `secure-delete` / `open-reader` / `pdf-*`(5) / `batch-rename`。
- 派发管线：`exe --flag "%1"` → `parseCliFiles`（`flagToAction` 映射，排除 `process.execPath` / `app.getAppPath()` 防误收集仓库目录）→ `queueCli` / `flushPending` → 渲染端 `app:cli-open` → `App.vue` 按 `action` 路由到对应 store（FileVault / EbookReader / PdfTools / FileRela）。多选文件多次触发 `second-instance` 聚合成一批。
- 启用集合与默认打开集合持久化于 `basic_info`（`shellMenuEnabled` / `shellMenuDefaultOpen`），设置页 `fileRela/ShellMenuManager.vue` 管理。改 `shellMenu.ts` 必须重启 Electron。

## 何时读本文档
初次接触本项目、需要判断「改哪类文件、要不要重启、走不走 IPC」时。具体模块见 `references/modules/*.md`。

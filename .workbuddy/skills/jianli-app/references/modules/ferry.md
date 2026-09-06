# 隔空互传 (ferry / QRFerry)

## 职责
把打包内的 QRFerry 静态站（屏幕→摄像头、fountain 码动态二维码文件传输，纯客户端、不经过服务器/局域网）
作为「内置资源」在 PC 端以独立 BrowserWindow 呈现，让用户无需局域网即可把小文件从屏幕二维码传给扫码设备（手机/另一台电脑）。

## 集成架构
- 资源：`electron/resources/qyferry`（dev）/ 打包后 `process.resourcesPath/qyferry`（由 electron-builder `extraResources` 拷入）。
- 主进程 `ferry.ts`：起一个随机端口的本地静态 http 服务（127.0.0.1，安全上下文，getUserMedia 可用）；
  独立 BrowserWindow 加载该 URL；对 localhost 源自动放行摄像头权限（`setPermissionRequestHandler`）；
  网页触发下载（接收文件）经 `will-download` 落盘到「文档/隔空互传/」。
- 渲染端 `src/views/ferry/index.vue`：入口页，按钮调用 `ferry:open` IPC 打开独立窗口。
- 网页本身自带扫码识别与解码，本模块**不写任何扫码逻辑**，只开放摄像头权限。

## 关键文件
- 主进程：`electron/main/module/ferry.ts`（`initFerry()` 入口；**改完必须重启 Electron**）
  - 静态服务：`ensureServer()`（随机端口、MIME 映射、防目录穿越、仅起一次缓存端口）
  - 窗口：`openFerry()`（title「隔空互传」、920×760、`partition:"ferry"` 隔离会话、`setPermissionRequestHandler` 对 media/camera/microphone 自动 `callback(true)`；`will-download` 落盘「文档/隔空互传/」）
  - IPC：`ferry:open`（渲染→主，`ipcMain.handle`）
- 打包：`electron-builder.json5` 的 `extraResources` 把 `electron/resources/qyferry` → `resources/qyferry`
- 渲染端入口（菜单四件套）：
  - `src/router/index.ts` 路由名 `FERRY` + `/ferry` 路由
  - `src/layout/index.vue` 与 `src/views/routeSetting/index.vue` 的「系统与资源」组均加 `ferry`（可见开关）
  - `src/utils/index.ts` iconMap `ferry:'ScanQrCode'`（`LucideIcon` nameMap 已含 `ScanQrCode`）

## 坑 / 注意
- **安全上下文**：QRFerry 的 `index.html` 用 `<script type="module" crossorigin>`，必须经 http(s) 加载（file:// 会被 CORS 拦截）；故必须起本地 http 服务而非 file://。127.0.0.1/localhost 是安全上下文，getUserMedia 摄像头可用。
- **改 ferry.ts / electron-builder.json5 必须重启 Electron 主进程**才生效。
- 接收文件走浏览器下载机制（`will-download`），落盘目录固定「文档/隔空互传/」；若需自定义目录再扩展。
- **≤10MB 限制**：屏幕→摄像头逐帧扫描机制固有，大文件极慢；两端（网页内联提示条 + 渲染端入口页）均带说明。
- 随机端口避免多实例冲突；服务单例常驻（仅起一次），多窗口复用同一端口。
- 与「文件互传」（`file-transfer`）是**两套独立机制**：文件互传走局域网 UDP+HTTP 数据面；隔空互传走屏幕二维码→摄像头，互不相干。

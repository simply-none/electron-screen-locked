# 文件互传（fileTransfer）双端方案与任务清单

> 状态：**方案草案，待用户确认后动码**（2026-09-06 依据双端代码勘察产出）。
> 实施完成后：本文件精简为协议与决策记录；桌面端细节转正到 `references/modules/file-transfer.md`，移动端细节记录在移动端技能 `jianli-mobile-app/references/file-transfer-plan.md`。

## 一、需求

- 双端各新增一个页面【文件互传】：桌面端（Electron）⇆ 移动端（Flutter）局域网互发文件。
- 支持**批量**互传：一次选多个文件、逐文件串行传输、逐文件进度与成功/失败结果。
- 双端**对称**：都能发送、都能接收，复用现有类 LocalSend 设施（UDP 47123 发现 + HTTP 47124 数据面）。

## 二、勘察结论（方案依据，2026-09-06 实测）

### 桌面端（本工程）
- 数据面 HTTP server：`electron/main/module/sync/syncModule.ts` L110-172，原生 `http.createServer` + 串行 if 路由（GET /ping、GET /export?table=、POST /sync、404 兜底），端口 `47124`；**加 /file/* 端点只需插一段 if 分支**，本方案改为导出可插拔注册函数（见任务 4）。
- UDP 发现 47123（L87-107）：广播包 `JIANLI_SYNC_DISCOVER_V1`，应答 `JIANLI_SYNC_INFO_V1|{json:{name,id,platform}}`；`scanPeers()` L179-207 只发 255.255.255.255 受限广播（**热点场景 PC 主动扫不到手机**，移动端已修）。
- 主进程模块注册：`electron/main/index.ts` L46 import + L174 `initSync()`（createWindow 末尾）；新 transfer 模块同样两处。
- preload 只透传 `handlePromise/send/sendSync`（`electron/preload/index.ts` L1-10、L573-579），**未透传 `on`** → 主进程推进度/接收事件需补 `on` 透传（限 `file-transfer:` 前缀）。
- 文件选择对话框先例：`file-vault:pick-import`（`electron/main/module/fileVault.ts` L284，`dialog.showOpenDialogSync` + `multiSelections`）。
- 导出统一规范：`src/utils/exportToFile.ts`（exportTextToCache/exportBufferToCache，直写 `fileCachePath`，回退链 `入参 dir → store.get('fileCachePath') → app.getPath('documents')`）+ `src/utils/fileNotify.ts`（蓝色可点击路径，点击走 `open-file-in-assets-manager`）。
- 建表正规姿势：`ensureTableExists(tableName, columns, 'key', {primaryKeyType:'TEXT'})`（`electron/main/module/qrcode.ts` L121-137 先例）。
- sha256 用 `node:crypto`（无第三方包，fileVault.ts/ebook.ts 先例）。
- 页面范式：`src/views/sync/` = index.vue 薄壳 + components/ + api/syncApi.ts + types.ts + `src/store/useSync.ts`（Pinia）。
- 菜单四件套：`src/router/index.ts`（RouteNames + layoutRouters）、`src/utils/index.ts` iconMap（Lucide 图标名）、`src/layout/index.vue` groupDefs（L133-139，sync 在「系统与资源」组 L135）、`src/views/routeSetting/index.vue` groupDefs（L69-75）。
- ⚠️ `.workbuddy\skills\jianli-app\references\` 存在同套文档副本，实施时需一并同步。

### 移动端（姊妹工程 jianli-mobile-app）
- 数据面：`lib/core/sync/sync_service.dart` L42-98，裸 `dart:io HttpServer` 绑 47124，if-else 分派（/ping、/export、/sync、404），**server 在同步页 `_init()` 才启动**（幂等守卫，`_server != null` 直接 return）。
- 发现：`lib/core/sync/sync_discovery.dart` —— `SyncDiscovery.scan()` 返回 `Map<ip, PeerDevice>`；`PeerDevice{ip,name,id,platform}`；`broadcastCandidates()` 已修热点定向广播。
- HTTP 客户端统一 dart:io `HttpClient`（sync_service L153-179 POST JSON 先例），**无 http/dio 依赖**；发二进制流可用 `req.addStream(file.openRead())`。
- file_picker 12.2.0（静态 API `FilePicker.pickFiles(...)`，先例都直接用 `f.path` 当真实路径）；`crypto` ^3.0.7、`path_provider`、`uuid` 已有；**share_plus / open_filex 没有**。
- drift：`app_database.dart` `schemaVersion = 1`，**onUpgrade 尚无先例**；表注册在 `@DriftDatabase(tables:[...])`；列名必须 `.named('snake_name')` 锁定。
- Android：`android/app/src/main/AndroidManifest.xml` **无任何 uses-permission**（INTERNET 只在 debug/profile manifest）；debug 模板自带 cleartext 放行，**release 包需显式配 INTERNET 权限 + usesCleartextTraffic**。
- 路由 `/sync` 注册先例：`lib/app/router/app_router.dart` L180-183（`fadeSlidePage` 包装）；工具组入口 `lib/features/hubs/hub_pages.dart` L67-73，`_Entry = (icon, title, subtitle, route, accentIndex)`，工具组已用 0/1/2/3/5。

## 三、协议设计 v1（文件互传，复用 47124，不新开端口与发现协议）

两端对称实现「发送客户端 + 接收服务端」。批量 = 一次 offer + 逐文件串行 data/end。

| 端点 | 方向 | 说明 |
|---|---|---|
| `POST /file/offer` | 发→收 | JSON `{tid, from:{name,id,platform}, files:[{fid,name,size,mime?}]}`；接收端回 `{ok:true, accepted:[fid...]}`；「自动接收」关闭时回 `{ok:false, reason:'rejected'}` |
| `POST /file/data?tid=&fid=` | 发→收 | **原始文件字节流**（带 Content-Length，全程流式、不落内存不 base64）；接收端先写 `<fid>.part`，回 `{ok:true, received:累计字节}` |
| `POST /file/end?tid=&fid=` | 发→收 | 单文件收尾：`.part` 改名为去重终名、写 file_transfer 历史、发接收通知，回 `{ok:true}` |

- `tid` = uuid 批次号；`fid` = 批次内序号（"1"、"2"…）。
- 文件名安全：接收端仅取 basename、过滤非法字符、重名追加 ` (n)`；**只允许落到专用接收目录**。
- 进度：发送端在写出流上按字节回调（节流 ~100ms）；接收端在请求 data 事件上累计；各自推送到本端 UI。
- 安全边界：与现有同步一致（明文传输、仅限受信局域网）；v1 默认自动接收，页面可关（关闭后 offer 被拒）。
- 校验：可选 sha256（两端 crypto 都现成）——v1 先做 size 比对，sha256 列 P2。

**双端同构历史表 `file_transfer`（TEXT key 主键，设备本地记录，不入同步白名单）**：
`key`(uuid,每文件一条) / `tid` / `fid` / `direction`('send'|'receive') / `peer_name` / `peer_ip` / `file_name` / `size`(INTEGER) / `mime`(可空) / `path`(本地路径) / `status`('done'|'failed'|'canceled') / `created_at`(ISO 文本)

## 四、桌面端任务清单

**新建**
- [ ] T1 `electron/main/module/transfer/transferModule.ts`（单文件职责：发送客户端 + 接收端点处理 + 历史读写 + IPC 注册 + 事件推送；`initTransfer()` 入口）
  - IPC：`transfer:status`（本机信息/接收目录）、`transfer:scan`（复用 scanPeers）、`transfer:pick-files`（dialog 多选）、`transfer:send`（`{peerIp, filePaths[]}` → offer→data→end 串行，流式读盘）、`transfer:history`、`transfer:open-received`（reveal 接收目录）。
  - 事件（webContents.send）：`file-transfer:progress` `{tid,fid,name,sent,total,phase}`、`file-transfer:received` `{name,path,size,from}`、`file-transfer:batch-done` `{tid,ok,fail}`。
  - 接收目录：`<fileCachePath>/文件互传/`（回退 documents）。
- [ ] T2 渲染端 `src/views/fileTransfer/`：`index.vue`（薄壳）+ `components/DeviceList.vue`（扫描/手动 IP，参考 sync 页交互）+ `components/TransferPanel.vue`（选文件发送 + 逐文件进度条 el-progress + 取消批次）+ `components/TransferLog.vue`（历史记录）+ `api/fileTransferApi.ts`（invoke 薄封装，参考 syncApi.ts）+ `types.ts`。
- [ ] T3 `src/store/useFileTransfer.ts`（Pinia：peers/selectedDevice/files/progress/logs/autoAccept）。

**修改**
- [ ] T4 `syncModule.ts`：数据面路由改为可插拔——导出 `registerDataRoute(method, prefix, handler)`（同步 server 实例保存在模块内，/ping、/sync、/export 行为不变），`/file/*` 由 transferModule 注册。⚠️ 改主进程**必须重启 Electron**。
- [ ] T5 `electron/main/index.ts`：import `initTransfer` + createWindow 内 `initSync()` 旁调用。
- [ ] T6 `electron/preload/index.ts`：补 `on(channel, cb)` 透传（**仅放行 `file-transfer:` 前缀**）。
- [ ] T7 菜单四件套：`src/router/index.ts` 加 `RouteNames.FILE_TRANSFER: "fileTransfer"` + 路由（path `/fileTransfer`，title 文件互传）；`src/utils/index.ts` iconMap 加 `fileTransfer: 'ArrowLeftRight'`；`src/layout/index.vue` groupDefs「系统与资源」组加 `fileTransfer`；`src/views/routeSetting/index.vue` groupDefs 同步加（可见开关）。
- [ ] T8 `src/layout/index.vue` onMounted 全局监听 `file-transfer:received` → `fileNotify`（页面外也能弹蓝色路径通知）。

**数据**
- [ ] T9 `initTransfer()` 内 `ensureTableExists('file_transfer', [...列如上], 'key', {primaryKeyType:'TEXT'})`。

**文档（实施后）**
- [ ] T10 新建 `references/modules/file-transfer.md`；`references/ipc-channels.md` 补通道表；`references/modules/sync.md` 补「数据面路由可插拔」小节；本 SKILL.md 导航与维护说明回写；`.workbuddy` 副本同步。

## 五、移动端任务清单（jianli-mobile-app）

**新建（`lib/features/file_transfer/`，feature-first 原子拆分 + 中文注释）**
- [ ] M1 `services/transfer_client.dart`（发送：offer→`req.addStream(file.openRead())`→end，字节回调节流进度，支持取消批次）。
- [ ] M2 `services/transfer_server.dart`（接收：offer/data/end 三端点实现，注册进 SyncService 路由钩子；接收目录 `Documents/渐离App文件互传/`）。
- [ ] M3 `models/transfer_models.dart` + `repositories/transfer_repository.dart`（drift 历史读写）+ `providers/file_transfer_providers.dart`（**顶层声明**，禁 build 内联——雷区 #9）。
- [ ] M4 `components/file_transfer_page.dart`（页面：PageBanner 粉 `accentIndex 4` + 设备扫描/手动 IP（模拟器 10.0.2.2）+ 选文件发送（file_picker 多选）+ FDeterminateProgress 逐文件进度 + 接收/发送记录列表；入页即 `startServer + startResponder`（均幂等，与 sync 页同款 `_init()`））。

**修改**
- [ ] M5 `lib/core/sync/sync_service.dart`：加可插拔路由注册 API（`registerRouteHandler`，保持既有端点行为不变）。
- [ ] M6 drift：新建 `lib/core/db/tables/file_transfer.dart`（列名 `.named()` 对齐上表）+ `app_database.dart` 注册 + **schemaVersion 1→2 + onUpgrade 首个迁移**（`m.createAll()`，drift 官方姿势，只建缺失表）→ **需跑 build_runner**。
- [ ] M7 `lib/app/router/app_router.dart` 加 `/file-transfer`（fadeSlidePage）；`lib/features/hubs/hub_pages.dart` 工具组加入口（`FLucideIcons.arrowLeftRight`，**先到 forui_lucide assets.g.dart grep 验证**，accent 4）。
- [ ] M8 `android/app/src/main/AndroidManifest.xml`：加 `<uses-permission android:name="android.permission.INTERNET"/>` + `<application>` 加 `android:usesCleartextTraffic="true"`（**release 包必需**，否则局域网明文 HTTP 被 Android 拦）。
- [ ] M9 pubspec **不新增依赖**（dart:io HttpClient + file_picker + crypto 已有）；file_picker 12.x 多选参数以包内实际签名为准（实施时先 grep 插件 API）。

**文档（实施后）**
- [ ] M10 SKILL.md：功能域清单加 file-transfer 行、「局域网同步」章节补文件协议、维护说明记一条；`references/file-transfer-plan.md` 转为决策记录。

## 六、验证清单（实施后走一遍，命令由用户本地执行）

1. 桌面端**重启 Electron**（改了主进程）；移动端 `flutter pub get → dart run build_runner build -d → flutter analyze（基线 0）→ flutter test（基线 5/5）→ flutter run -d emulator-5554`。
2. PC 发手机：选 ≥3 个文件（含大文件）批量发送，逐文件进度、结果落历史；手机端「文件互传」页与「接收目录」都能看到。
3. 手机发 PC：批量发送；PC 端 fileNotify 蓝色路径通知 + 历史记录正确。
4. 手动 IP：模拟器场景手机端填 `10.0.2.2` 直传。
5. 边界：重名文件去重 ` (n)`；文件名含非法字符；接收方「自动接收」关闭时发送端收到拒绝提示；取消批次后剩余文件状态 canceled。
6. 热点场景：手机开热点给 PC，从**手机侧**扫描发起互传（PC 侧扫描为已知受限，见可选项 A）。

## 七、v1 裁剪与可选项（需用户表态）

- **可选项 A（建议做）**：把移动端已修的 `broadcastCandidates()`（逐网卡 /24 定向广播）移植到桌面 `scanPeers()`，解决热点场景 PC 扫不到手机（改动小，但动 syncModule.ts，需重启 Electron）。
- P2：sha256 完整校验；断点续传（data 分块带 seq）；移动端接收文件「打开/分享」（需引 share_plus）；移动端文件预览。
- P3：传输会话加密（与同步协议加密同一规划）。
- 不做：传输历史跨设备同步（设备本地记录）；传输经云端中转（纯局域网直连）。

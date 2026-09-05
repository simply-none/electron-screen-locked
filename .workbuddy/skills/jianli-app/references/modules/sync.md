# 局域网同步 (sync)

## 职责
PC 与移动端（Flutter App）在同一局域网内互相发现并同步业务数据，类 LocalSend。
协议与移动端 `jianli-mobile-app/lib/core/sync/` 严格对称，双向幂等（按主键 INSERT OR REPLACE / ON CONFLICT upsert）。

## 协议 v1
- **发现**：UDP 广播 `47123`，请求文本 `JIANLI_SYNC_DISCOVER_V1`，应答 `JIANLI_SYNC_INFO_V1|{json:{name,id,platform}}`
- **数据**：HTTP `47124`：
  - `GET /ping` → 设备信息
  - `GET /export?table=x` → `{ok, rows}`（行内含桌面端遗留列，移动端按自身实际列过滤写入）
  - `POST /sync` → `{table, rows}` → 对端幂等 upsert
- **白名单**（两端一致）：habit_def / habit_checkin / todo_list / todo_tags / note_book / basic_info / countdown / qr_history / qr_template（TEXT 主键 key）+ conversation_theme / conversation / conversation_tag（**INTEGER 自增 id 主键**，2026-09-05 加入）。主键按 `syncModule.ts` 的 `tablePk()` 按表适配：upsert 走 `ON CONFLICT(pk) DO UPDATE`（newSql），移动端 `INSERT OR REPLACE`。**新增 INTEGER 主键表时：三处同改（主进程 SYNCABLE_TABLES + tablePk、渲染端 SYNC_TABLES、移动端 kSyncableTables）并重启 Electron。**

## 关键文件
- 主进程：`electron/main/module/sync/syncModule.ts`（发现应答 + 数据服务 + 主动扫描/推送/拉取 + IPC；**改完必须重启 Electron**）
  - 被动：`startDiscoveryResponder()`（UDP 应答）/ `startDataServer()`（/ping、/export、POST /sync）
  - 主动：`scanPeers()`（UDP 广播 3 秒收集、排除自身）/ `pushTables(ip, tables)`（query 本地 → POST 对端）/ `pullTables(ip, tables)`（GET 对端 → upsert 本地）
  - IPC：`sync:status` / `sync:scan` / `sync:push` / `sync:pull`（`{success, data}` 约定）
  - 注册：`electron/main/index.ts` 的 `initSync()`（createWindow 末尾）
- 渲染端（渲染端不 import electron，全走 IPC）：
  - `src/views/sync/types.ts` —— SyncPeerDevice / SyncTableResult / SyncStatus / SyncLogItem
  - `src/views/sync/api/syncApi.ts` —— 4 条 IPC 薄封装
  - `src/store/useSync.ts` —— Pinia：status/peers/selectedTables/logs + scan/push/pull/addManual；`SYNC_TABLES` 白名单（与主进程一致）
  - `src/views/sync/index.vue` —— 页面薄壳（本机状态条 + 设备 + 表选择 + 日志）
  - `src/views/sync/components/` —— `DeviceList.vue`（设备卡：拉取/发送）/ `TableSelector.vue`（表勾选）/ `SyncLog.vue`（日志，纯展示）
- 落地：路由 `/sync`（RouteNames.SYNC）；侧边栏「系统与资源」组；routeSetting 可见开关；iconMap `sync: 'RefreshCw'`

## 移动端对应实现
- `jianli-mobile-app/lib/core/sync/sync_discovery.dart`（UDP 发现）/ `sync_service.dart`（HTTP + PRAGMA 过滤列幂等写入；含对称的 `/export` 拉取端点）/ `features/sync`（同步页）
- 模拟器联通（NAT 双向不通广播）：
  - 手机→PC：手机同步页手动填 `10.0.2.2`（宿主回环）
  - PC→手机：`adb forward tcp:47125 tcp:47124`，桌面同步页手动填 `127.0.0.1:47125`（`ip:port` 格式；不能 reverse——47124 被宿主桌面端占用）
  - 移动端同步服务随「工具→局域网同步」页面首次打开而启动并常驻
- TODO：移动端 /ping 返回的 name/id 为空串（startServer 未传本机名），待补 Platform.localHostname。

## 用到的 IPC 通道
`sync:status` / `sync:scan` / `sync:push` / `sync:pull`（渲染→主，`ipcMain.handle`）

## 复用 / 集成点
- 数据读写走 `newSql.ts` 的 `query`/`upsert`（**严禁 `new-sql:execute`**，见 SKILL 红线）。
- 移动端由其同步页主动发起拉取/发送；PC 端由本页面发起，两端角色对等。

## 特有坑 / 注意
- **改 syncModule.ts 必须重启 Electron**（UDP/HTTP 服务与 IPC 都在主进程）。
- 防火墙首次弹窗需「允许访问」，否则对端连不进 47124。
- 同步为**明文 JSON**，仅限受信局域网（TODO(P3)：会话密钥）。
- 桌面端表带旧 SQL 层遗留列（id/name/value/created_at），移动端写入时会按其表结构过滤，属正常现象。
- INTEGER 主键表（pomodoro_status / conversation / ebook_* / screenshots 等）暂不同步（P3）。

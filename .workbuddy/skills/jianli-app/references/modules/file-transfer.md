# 文件互传 (fileTransfer)

## 职责
PC（Electron）⇆ 移动端（Flutter）在同一局域网内**批量互传文件**，双端对称（都能发、都能收），复用局域网同步既有的类 LocalSend 设施（UDP 47123 发现 + HTTP 47124 数据面），**不新开端口、不新写发现协议**。与 sync 模块平行，是第二个挂在 47124 数据面上的功能。

## 协议 v1（文件互传，与移动端 feature/file_transfer 同构）
批量 = 一次 offer + 逐文件串行 data/end。

| 端点 | 方向 | 说明 |
|---|---|---|
| `POST /file/offer` | 发→收 | JSON `{tid, from:{name,id,platform}, files:[{fid,name,size,mime?}]}`；收端回 `{ok:true, accepted:[fid...]}`；「自动接收」关闭时回 `{ok:false, reason:'rejected'}` |
| `POST /file/data?tid=&fid=` | 发→收 | **原始文件字节流**（带 Content-Length，全程流式、不落内存不 base64）；收端先写 `<fid>.part`，回 `{ok:true, received:累计字节}` |
| `POST /file/end?tid=&fid=` | 发→收 | 单文件收尾：`.part` 改名为去重终名、写 file_transfer 历史、推 `file-transfer:received`，回 `{ok:true, path, error?}`；**请求体 JSON 携带 `{hash}`（本文件 sha256），接收端比对** |

- `tid` = uuid 批次号；`fid` = 批次内序号（"1"、"2"…）。
- 文件名安全：收端仅取 basename、过滤非法字符、重名追加 ` (n)`；**只允许落到专用接收目录**。
- 进度：发送端在写出流上按字节回调；接收端在请求 data 事件上累计；各自推送到本端 UI。
- 安全边界：与 sync 一致（明文传输、仅限受信局域网）；v1 默认自动接收，页面可关（关闭后 offer 被拒）。
- 校验：**size 比对 + sha256 完整性校验双保险**（2026-09-06 已实施）。发送端 data 阶段流式算 sha256，随 `/file/end` 的 `{hash}` 带给接收端；接收端 `/file/data` 边收边算 sha256 暂存，`/file/end` 时与发送端 hash 比对，不一致则删坏文件、历史记 `failed`(error='hash mismatch')，且不弹通知。

**双端同构历史表 `file_transfer`（TEXT key 主键，设备本地记录，不入同步白名单）**：
`key`(uuid,每文件一条) / `tid` / `fid` / `direction`('send'|'receive') / `peer_name` / `peer_ip` / `file_name` / `size`(INTEGER) / `mime`(可空) / `path`(本地路径) / `status`('done'|'failed'|'canceled') / `error`(失败原因，可空) / `created_at`(ISO 文本)

## 数据面路由可插拔（与 sync 共用 47124）
`electron/main/module/sync/syncModule.ts` 导出 `registerDataRoute(method, prefix, handler)`：
- sync 服务实例保存在模块内，`/ping`、`/sync`、`/export` 行为不变；
- transfer 模块在 `initTransfer()` 里注册 `/file/offer`、`/file/data`、`/file/end` 三个路由；
- 服务端请求处理循环：先遍历 `dataRoutes`（前缀匹配）再回退到原有 if 分支 / 404。
- ⚠️ 改 syncModule.ts 或 transferModule.ts 都**必须重启 Electron**。

## 协议增强（2026-09-06 二批，向后兼容）

在原 v1 三端点之上叠加下列字段/行为；**未开启时完全退化为既有明文行为**，老版本双端仍可互通（与移动端 `jianli-mobile-app/.../file-transfer-plan.md` §二之一 同构，详见 `references/file-transfer-plan.md`）。

- **#9 重名策略**：`store._transfer_rename`（`'rename'` 默认 / `'overwrite'`）；`transfer:set-rename` 切换并持久化。
- **#10 文件夹 / 拖拽**：`transfer:pick-files` 支持选目录（`dialog.showOpenDialog` `properties:['openDirectory','multiSelections']`）递归 `walk` 展开为文件列表；渲染端支持拖拽文件夹。
- **#11 最近设备**：扫描/发送过的对端写入 `store._transfer_recent`（`RecentPeer{ip,name,id,platform,lastSeen}`）；`transfer:recent-peers` 读取、`transfer:forget-peer` 剔除；离线可见、点「发到此处」重发。
- **#13 断点续传**：offer 响应 `accepted` 每项带 `resumeFrom`（按 `recv-${safeName}-${size}.part` 稳定名查已有字节数）；`postBinary` 带 `startOffset`，data 带 `?from=resumeFrom`，Content-Length = `size - startOffset`，接收端 append + 用已有字节给 hash 播种。**加密批次不做续传**（CTR keystream 不可任意字节对齐）。
- **#14 会话加密（默认关）**：开启且 `encEnabled()` 时生成 `randomBytes(32)` key + `randomBytes(16)` iv，offer 带 `enc:{key,iv}` base64；对端确认后 `offer` 响应 `enc:true`，data 先 `tee` 算明文 hash 再 `createCipheriv('aes-256-ctr',key,iv)` 加密，Content-Length = `size - startOffset`。**需收发双端均开启**。
- **#15 接收询问模式**：`autoAccept=false` 时不立即拒（`403 rejected`），改经 `pendingAsk` + 事件 `file-transfer:incoming-ask` 弹确认框，等 UI 答复（`transfer:answer-offer {tid, accept}`）；`ASK_TIMEOUT_MS=60_000` 超时默认拒。
- **#16 磁盘预估**：`handleOffer` 先 `freeSpaceBytes(dir)`（node `fs.statfsSync`）比对 `total`，不足回 `507 no space` 拒绝。**移动端无可靠 free-space API，仅软预估不硬拒**。
- **#17 并发守卫**：同刻仅一个接收批次（`activeReceiveTid`）与一个发送批次（`activeSendTid`）；冲突回 `429 busy`。
- **#20 历史分页 + 自动清理**：`transfer:history` 支持 `{limit,offset}` 返 `{data,total}`；`handleEnd` 后 `trimHistory()` 超 `MAX_HISTORY_ROWS=1000` 删最旧。移动端 `TransferRepository.list/trim(1000)` 同语义。

## 设备发现（含手机热点场景，2026-09-06 补齐）
`scanPeers()`（syncModule.ts）向**多个目标各发一份** UDP 发现包，目标由 `discoveryTargets()` 计算：
- 全网受限广播 `255.255.255.255`（普通同网段场景）；
- 每个 IPv4 非回环接口的**定向广播** `x.y.z.255`（按真实子网掩码 `ip | ~mask` 逐字节计算，比移动端 `/24` 假设更准）；
- 网关 `x.y.z.1` **单播**（手机开热点时手机即网关，单播必达，热点场景的关键兜底）。

**为什么**：只发 `255.255.255.255` 在「手机开热点」场景会走默认路由、到不了热点网段，PC 扫不到手机（移动端早前已修同类问题，见 `jianli-mobile-app/lib/core/sync/sync_discovery.dart` 的 `broadcastCandidates`；其 responder 对任意来源地址都回包，所以单播也能被发现）。应答按 ip 去重、重复发送幂等。sync 与 transfer **共用** `scanPeers`，同步页一并受益。

## 关键文件
- 主进程：
  - `electron/main/module/transfer/transferModule.ts`（单文件职责：发送客户端 + 接收端点 + 历史读写 + IPC 注册 + 事件推送；`initTransfer()` 入口；**改完必须重启 Electron**）
    - 接收端点：`handleOffer`（自动接收关闭→403；**响应回传本机设备信息 `me`**）/ `handleData`（流式写 `.part` 并**边收边算 sha256** 暂存）/ `handleEnd`（读 body 的 `{hash}` + 改名去重 + size/sha256 双重校验 + 写历史(error) + 推事件 + 收完回收 `incoming`）
    - 发送端：`sendBatch`（offer→data 流式(Transform 累计字节+节流+算 hash)→end(带 hash)，串行逐文件，按字节回调 `emit('file-transfer:progress')`；每批次一个 `AbortController`，可经 `transfer:cancel` 中止；**从 offer 响应 `me` 取对端名**填发送历史 peer_name）
    - 历史：`ensureTableExists('file_transfer', [... , 'error'], 'key', {primaryKeyType:'TEXT'})`
    - **残留清理**：`sweepStale()` 在 `initTransfer` 启动期执行一次 + 每 10 分钟定时——回收超时（30min）的 `incoming` 批次并删其 `.part`，删除超时（30min）的孤立 `.part`
    - IPC：`transfer:status` / `transfer:scan`（复用 scanPeers）/ `transfer:pick-files`（dialog 多选；#10 支持 `openDirectory` 递归展开）/ `transfer:send` / `transfer:cancel` / `transfer:history`（#20 支持 `{limit,offset}` 返 `{data,total}`）/ `transfer:open-received` / `transfer:open-file`（openPath 打开指定文件）/ `transfer:open-folder`（showItemInFolder 定位）/ `transfer:set-auto-accept` / `transfer:set-rename`（#9 rename/overwrite）/ `transfer:set-enc`（#14 加密开关）/ `transfer:recent-peers`（#11 读）/ `transfer:forget-peer`（#11 剔除）/ `transfer:answer-offer`（#15 `{tid,accept}`）
    - 事件（webContents.send）：`file-transfer:progress` `{tid,fid,name,sent,total,phase}`（phase: `data|done|failed|canceled`）/ `file-transfer:received` `{name,path,size,from}` / `file-transfer:batch-done` `{tid,ok,fail,canceled}` / `file-transfer:incoming-ask` `{tid,name,count,total}`（#15 弹确认框，等 `transfer:answer-offer`）
    - 接收目录：`<fileCachePath>/文件互传/`（回退 documents）
  - 注册：`electron/main/index.ts` 的 `initTransfer()`（紧挨 `initSync()` 调用）
- 渲染端（不 import electron，全走 IPC）：
  - `src/views/fileTransfer/types.ts` —— TransferPeerDevice / TransferProgress / TransferHistoryItem / TransferStatus / LocalFileItem
  - `src/views/fileTransfer/api/fileTransferApi.ts` —— 7 条 IPC 薄封装（`window.ipcRenderer.handlePromise`）
  - `src/store/useFileTransfer.ts` —— Pinia：status/peers/selectedDeviceIp/files/progress(key=`${tid}|${fid}`)/history/autoAccept + scan/addManual/pickFiles/send/**cancel**/loadHistory/openReceived/**openFile/openFolder** + 批次聚合 `batchTotalBytes/batchSentBytes/batchPercent/batchRate/batchEta`（基于 progress 累加，驱动总进度/速率/ETA）+ `bindEvents()`（订阅 `file-transfer:*` 三事件）
  - `src/views/fileTransfer/index.vue` —— 页面薄壳（本机状态条 + 设备 + 发送面板 + 传输记录），onMounted `bindEvents`、onUnmounted `unbindEvents`
  - `src/views/fileTransfer/components/` —— `DeviceList.vue`（设备卡+发送，busy 时禁用）/ `TransferPanel.vue`（选文件+逐文件 el-progress+**批次总进度条/速率/ETA**+自动接收开关+发送中「取消发送」）/ `TransferLog.vue`（历史列表，每条成功记录可「打开文件 / 打开所在文件夹」，失败显示 error 原因）
  - 菜单四件套：`RouteNames.FILE_TRANSFER` + 路由 `/fileTransfer`；`src/utils/index.ts` iconMap `fileTransfer:'ArrowLeftRight'`；`LucideIcon.vue` 已加 `ArrowLeftRight`（nameMap）；侧边栏与 routeSetting 的「系统与资源」组均加 `fileTransfer`
  - 全局通知：`src/layout/index.vue` onMounted 监听 `file-transfer:received` → `fileNotify`（蓝色可点击路径，页面外也能弹）
- 落地：路由 `/fileTransfer`（RouteNames.FILE_TRANSFER）；侧边栏「系统与资源」组；routeSetting 可见开关；iconMap `fileTransfer:'ArrowLeftRight'`

## 移动端对应实现
- `jianli-mobile-app/lib/features/file_transfer/`（models / repositories / providers / services / components / page）：与桌面端同协议同历史表；接收目录 `Documents/渐离App文件互传/`；详见其技能 `references/file-transfer-plan.md`（已转为决策记录）。

## 用到的 IPC 通道
`transfer:status` / `transfer:scan` / `transfer:pick-files` / `transfer:send` / `transfer:cancel` / `transfer:history` / `transfer:open-received` / `transfer:open-file` / `transfer:open-folder` / `transfer:set-auto-accept` / `transfer:set-rename` / `transfer:set-enc` / `transfer:recent-peers` / `transfer:forget-peer` / `transfer:answer-offer`（渲染→主，`ipcMain.handle`）；事件 `file-transfer:progress` / `file-transfer:received` / `file-transfer:batch-done` / `file-transfer:incoming-ask`（主→渲染，preload `on` 透传）。

## 特有坑 / 注意
- **改 transferModule.ts / syncModule.ts 必须重启 Electron**（数据面 HTTP 服务与 IPC 在主进程）。
- 接收端 `.part` 临时文件在 `receiveDir()` 内（`<fileCachePath>/文件互传/`），正常流程 `handleEnd` 改名；异常残留由 `sweepStale()` 定时（10min）清理，无需手动。
- 发送端历史 `peer_name` 经 offer 响应 `me` 回填，不再空白（对端未回传时回退 `peer_ip`）。
- **取消批次（2026-09-06 已补齐）**：`transfer:cancel {tid}` → `cancelFlags[tid]=true` + `abortControllers[tid].abort()`，中止流式 fetch；当前文件记 `canceled`（进度转橙色 warning），后续文件不再发送。⚠️ `transfer:send` 要等整批结束才返回，**tid 只能从开头那次初始 `file-transfer:progress` 事件拿**，所以渲染端 `currentTid` 由 `onProgress` 写入，`cancel()` 用它发起取消。取消后收端未收到 `/file/end` 的 `.part` 会被 `sweepStale` 周期性清掉。
- **完整性校验（2026-09-06 已实施）**：size 比对 + sha256 双保险；校验失败收端删坏文件、历史记 `failed` 并写 `error`（size mismatch / hash mismatch / peer rejected），不弹通知。
- **断点续传（2026-09-06 二批，#13）**：仅当未加密时生效；发送端 `postBinary(file, {startOffset})`，data 带 `?from=startOffset`，Content-Length 同步缩减；接收端按 `recv-${safeName}-${size}.part` 稳定名查已有字节数作为 `resumeFrom`，data 阶段 `appendFile` + 用已有字节给 hash 播种。**加密批次 `resumeFrom` 强制 0、整文件重发**（CTR keystream 无法任意字节对齐）。
- **会话加密（2026-09-06 二批，#14，默认关）**：对称 AES-256-CTR。发送端开启且收端确认 `enc:true` 后，data 阶段 `stream.pipe(createCipheriv('aes-256-ctr', key, iv))` 发密文；接收端 `createDecipheriv` 解密。密钥经 offer `enc:{key,iv}` base64 协商，**需收发双端均开启**；任一端未开则整批明文（向后兼容）。密钥用 `crypto.randomBytes`（密码学安全随机源）。
- **接收询问模式（2026-09-06 二批，#15）**：`autoAccept=false` 时不再直接 `403 rejected`，而是 `pendingAsk[tid]` 登记 + `webContents.send('file-transfer:incoming-ask', {tid, from, files})`；UI 经 `transfer:answer-offer {tid, accept}` 答复，唤醒 `handleOffer` 等待。`ASK_TIMEOUT_MS=60_000` 超时默认拒绝（防止 UI 未回应导致批次挂起）。
- **并发守卫（2026-09-06 二批，#17）**：`activeReceiveTid`/`activeSendTid` 保证同刻仅一个接收/发送批次；冲突回 `429 busy`。发送端 `sendBatch` 开头若已有 `_activeSendTid` 直接失败返回。
- **最近设备（2026-09-06 二批，#11）**：扫描/发送成功后写入 `store._transfer_recent`（最多 20 条，`lastSeen` 为 epoch ms）；`transfer:recent-peers` 返回列表、`transfer:forget-peer {ip}` 剔除；页面「最近设备」区离线也展示，点「发到此处」用记忆的 ip 重发。与移动端 `RecentPeers`（shared_preferences 键 `transfer_recent_peers`）同构。
- **磁盘预估（2026-09-06 二批，#16）**：`handleOffer` 先 `freeSpaceBytes(dir)`（`fs.statfsSync(dir).bsize * blocks`）比对本批 `total`，不足回 `507 no space` 拒绝。移动端无可靠 free-space API，仅软预估不硬拒。
- **历史分页 + 自动清理（2026-09-06 二批，#20）**：`transfer:history` 支持 `{limit,offset}`，缺省全量、返 `{data,total}`；`handleEnd` 后 `trimHistory()` 超 `MAX_HISTORY_ROWS=1000` 删最旧 excess 行。前端「加载更多」按钮递增 offset。

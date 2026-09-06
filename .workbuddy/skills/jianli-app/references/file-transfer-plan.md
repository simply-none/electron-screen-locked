# 文件互传（fileTransfer）双端方案 · 决策记录

> 状态：**已实施完成（2026-09-06）**。本文件由方案草案转为决策记录，保留协议设计与实施决策；实现细节见 `references/modules/file-transfer.md`（桌面端）与移动端技能 `references/file-transfer-plan.md`。
> 移动端姊妹文档：`C:\cod\jianli\jianli-mobile-app\.workbuddy\skills\jianli-mobile-app\references\file-transfer-plan.md`（同协议、同历史表）。
> **2026-09-06 追加完成后续（两批）**：① `transfer:cancel` 取消批次 + `scanPeers()` 热点定向广播（可选项 A）；② 健壮性 + 体验补齐（1–8 + 12）：sha256 完整性校验（双端）、历史 `error` 失败原因列（双端）、进度节流 + 取消/中断残留 `.part` 清理 + `incoming` 回收、发送端 `peer_name` 经 offer `me` 回填、桌面端历史「打开文件 / 打开所在文件夹」、批次总进度/速率/ETA、移动端历史「打开 / 分享」（`open_filex`+`share_plus`）。
> **P2 断点续传（已完成，2026-09-06 二批）**：offer 响应回 `accepted:[{fid,resumeFrom}]`、data 带 `?from=N` 追加写 + hash 播种；加密批次整文件重发（CTR keystream 不可任意字节对齐）。**P3 会话加密（已完成，2026-09-06 二批）**：AES-256-CTR，offer 协商 `enc` 字段、data 密文流，默认关、向后兼容。其余增强（#9 重名覆盖 / #10 文件夹拖拽 / #11 最近设备 / #15 接收询问 / #16 磁盘预估 / #17 并发守卫 / #20 历史分页+自动清理）同批落地，详见 §二之一。

## 一、需求（已落地）
- 双端各一个【文件互传】页面：PC（Electron）⇆ 手机（Flutter）局域网互发文件。
- **批量**互传：一次选多文件、逐文件串行、逐文件进度与成败结果。
- **双端对称**：都能发、都能收，复用既有类 LocalSend 设施（UDP 47123 发现 + HTTP 47124 数据面），**不新开端口、不新写发现协议**。

## 二、协议 v1（文件互传，复用 47124，已落地）

两端对称实现「发送客户端 + 接收服务端」。批量 = 一次 offer + 逐文件串行 data/end。

| 端点 | 方向 | 说明 |
|---|---|---|
| `POST /file/offer` | 发→收 | JSON `{tid, from:{name,id,platform}, files:[{fid,name,size,mime?}]}`；收端回 `{ok:true, accepted:[fid...]}`；「自动接收」关闭时回 `{ok:false, reason:'rejected'}` |
| `POST /file/data?tid=&fid=` | 发→收 | **原始文件字节流**（带 Content-Length，全程流式、不落内存不 base64）；收端先写 `<fid>.part`，回 `{ok:true, received:累计字节}` |
| `POST /file/end?tid=&fid=` | 发→收 | 单文件收尾：`.part` 改名去重终名、写 file_transfer 历史、推接收事件，回 `{ok:true, error?}`；**请求体 JSON 携带本文件 sha256 `{hash}`，接收端比对** |

- `tid`=uuid 批次号；`fid`=批次内序号（"1"、"2"…）。
- 文件名安全：收端仅取 basename、过滤非法字符、重名追加 ` (n)`；只允许落专用接收目录。
- 进度：发送端按字节回调（Transform 计数流）；接收端在请求 data 事件累计；各自推本端 UI。
- 安全边界：与同步一致（明文、仅限受信局域网）；v1 默认自动接收，页面可关（关后 offer 被拒）。
- 校验：**size 比对 + sha256 完整性校验双保险（2026-09-06 已实施）**。发送端 data 阶段流式算 sha256 随 `/file/end` 的 `{hash}` 带出；接收端 `/file/data` 边收边算 sha256 暂存，`/file/end` 比对，不符则删坏文件、历史记 `failed`(error=`hash mismatch`) 且不弹通知。

**双端同构历史表 `file_transfer`（TEXT key 主键，设备本地记录，不入同步白名单）**：
`key`(uuid,每文件一条) / `tid` / `fid` / `direction`('send'|'receive') / `peer_name` / `peer_ip` / `file_name` / `size`(INTEGER) / `mime`(可空) / `path`(本地路径) / `status`('done'|'failed'|'canceled') / `error`(失败原因，可空) / `created_at`(ISO 文本)

## 二之一、协议增强（2026-09-06 二批，向后兼容）

在原 v1 三端点之上叠加下列字段/行为；**未开启时完全退化为既有明文行为**，老版本双端仍可互通（与移动端 `jianli-mobile-app/.../file-transfer-plan.md` §二之一 同构）。

- **#9 重名策略**：接收端按 `store._transfer_rename`（`'rename'` 默认 / `'overwrite'`）决定——`rename` 追加 ` (n)`，`overwrite` 先删同名再改名。`transfer:set-rename` 切换并持久化。
- **#10 文件夹 / 拖拽**：`transfer:pick-files` 支持选目录（`openDirectory`）+ 递归 `walk` 展开为文件列表；渲染端支持拖拽文件夹。
- **#11 最近设备**：扫描/发送过的对端持久化进 `store._transfer_recent`（`RecentPeer{ip,name,id,platform,lastSeen}`），`transfer:recent-peers` 读取、`transfer:forget-peer` 剔除；页面「最近设备」区离线也展示，点「发送」重发。与移动端 `RecentPeers` 同构。
- **#13 断点续传**：offer 响应 `accepted` 每项带 `resumeFrom`（收端按 `.recv-${safeName}-${size}.part` 稳定名查已有字节数）；发送端 `postBinary` 带 `startOffset`，data 请求 `?from=resumeFrom`，Content-Length = `size - startOffset`，接收端 append + 用已有字节给 hash 播种。**加密批次不做续传**（CTR keystream 不可任意字节对齐）。
- **#14 会话加密（默认关）**：发送端开启且 `encEnabled()` 时生成 `randomBytes(32)` key + `randomBytes(16)` iv，offer 带 `enc:{key,iv}` base64；对端确认后 `offer` 响应 `enc:true`，发送端 data 先 `tee` 算明文 hash 再 `createCipheriv('aes-256-ctr',key,iv)` 加密，Content-Length = `size - startOffset`；接收端 `createDecipheriv` 解密。**需收发双端均开启**。
- **#15 接收询问模式**：`autoAccept=false` 时不立即拒（`403 rejected`），改经 `pendingAsk` + 事件 `file-transfer:incoming-ask` 弹确认框，等 UI 答复（`transfer:answer-offer {tid, accept}`）；`ASK_TIMEOUT_MS=60_000` 超时默认拒。
- **#16 磁盘预估**：`handleOffer` 先 `freeSpaceBytes(dir)`（node `fs.statfsSync`）比对 `total`，不足回 `507 no space` 拒绝。**移动端无可靠 free-space API，仅软预估不硬拒**。
- **#17 并发守卫**：同刻仅一个接收批次（`activeReceiveTid`）与一个发送批次（`activeSendTid`）；冲突回 `429 busy`。
- **#20 历史分页 + 自动清理**：`transfer:history` 支持 `{limit,offset}` 返回 `{data,total}`；`handleEnd` 后 `trimHistory()` 超 `MAX_HISTORY_ROWS=1000` 删最旧。移动端 `TransferRepository.list/trim(1000)` 同语义。

## 三、实施决策与偏差（相对原草案）
- **数据面可插拔**：`syncModule.ts` 由串行 if 改为导出 `registerDataRoute(method, prefix, handler)`；`transferModule.ts` 的 `initTransfer()` 注册 `/file/*` 三端点，共用 47124 服务实例。违背「改主进程需重启 Electron」红线——见维护说明。
- **preload `on` 透传**：实测 preload 已原生 `on(...)` 透传全部通道，无需为 `file-transfer:` 前缀单独改造（草案 T6 的改造被省去）。渲染端经 `window.ipcRenderer.on` 订阅 `file-transfer:progress/received/batch-done`。
- **取消批次（已完成，2026-09-06）**：桌面端 `sendBatch` 每批次建 `AbortController`（存 `abortControllers[tid]`），`postBinary` 的 `fetch` 带其 `signal`；`transfer:cancel {tid}` 置位 `cancelFlags[tid]` 并 `abort()`，中止流式上传，当前文件记 `canceled`、其后文件不再发送。⚠️ `transfer:send` 的 handle 要等整批结束才返回，**tid 只能经开头的初始 `file-transfer:progress` 事件带出**，渲染端据此调用取消（发送中 UI 显示「取消发送」）。取消语义：用户在传输中途点「取消发送」→ 当前文件标 canceled，后续文件不再发；非取消的失败不中断整批（记 failed 后继续下一个）。
- **发送端历史 `peer_name`**：offer 响应回传本机设备信息 `me`（双端都回），发送端据此回填对端名，不再空白（对端未回传时回退 `peer_ip`）。
- **接收目录**：`<fileCachePath>/文件互传/`（回退 documents）；`.part` 临时文件同目录，正常流程 `handleEnd` 改名；取消/中断/校验失败的孤立 `.part` 由 `sweepStale()` 定时（10min）+ 启动期清理（2026-09-06 新增）。
- **图标**：菜单 iconMap 用 `ArrowLeftRight`，已补进 `LucideIcon.vue` 的 `nameMap`（该组件仅渲染 nameMap 内显式注册的图标）。
- **无新增依赖**：桌面端纯 node 原生（http/fs/stream/crypto），渲染端复用既有 Element Plus / Pinia；移动端纯 dart:io + 既有 file_picker/crypto/uuid。

## 四、桌面端任务完成状态（T1–T10）
- [x] T1 `transferModule.ts`：发送客户端 + 接收端点 + 历史 + IPC + 事件推送
- [x] T2 `src/views/fileTransfer/`：index 薄壳 + DeviceList/TransferPanel/TransferLog + api + types
- [x] T3 `useFileTransfer.ts`：Pinia（peers/files/progress/history/autoAccept + bindEvents）
- [x] T4 `syncModule.ts`：可插拔路由 `registerDataRoute`
- [x] T5 `index.ts`：`import initTransfer` + createWindow 内 `initSync()` 旁调用
- [x] T6 preload `on`：实测已原生透传，无需改造
- [x] T7 菜单四件套：`RouteNames.FILE_TRANSFER` + 路由 `/fileTransfer` + iconMap `ArrowLeftRight` + layout/routeSetting 组
- [x] T8 `layout/index.vue` 监听 `file-transfer:received` → `fileNotify`
- [x] T9 `ensureTableExists('file_transfer', ..., 'key', {primaryKeyType:'TEXT'})`
- [x] T10 文档：本决策记录 + `modules/file-transfer.md` + ipc-channels/sync 补章节 + SKILL.md 回写
- [x] **T11（2026-09-06）健壮性 + 体验补齐**：进度节流（~100ms，修复累计字节回传 bug）/ `.part` 定时清理 + `incoming` 回收 / 历史 `error` 列（双端）/ sha256 双端校验 / 桌面端历史「打开文件 / 打开所在文件夹」/ 批次总进度·速率·ETA / 移动端历史「打开 / 分享」（`open_filex`+`share_plus`）/ `peer_name` 经 offer `me` 回填
- [x] **T12（2026-09-06 二批 · 全部剩余增强已落地）**：
  - `transferModule.ts`：#9 重名策略（`store._transfer_rename` `'rename'`/`overwrite'` + `transfer:set-rename`）/ #10 文件夹·拖拽（`transfer:pick-files` 支持 `openDirectory` 递归 `walk` 展开；渲染端拖拽文件夹）/ #11 最近设备（`store._transfer_recent` + `transfer:recent-peers` + `transfer:forget-peer`）/ #13 续传（`postBinary` 带 `startOffset`、data `?from=N`、接收端 append + 用已有字节给 hash 播种）/ #14 加密（`encEnabled()` 生成 `randomBytes(32/16)`、offer 带 `enc`、data `createCipheriv('aes-256-ctr')` 密文流）/ #15 询问（`pendingAsk` + 事件 `file-transfer:incoming-ask` + `transfer:answer-offer {tid,accept}`、`ASK_TIMEOUT_MS=60_000`）/ #16 磁盘预估（`freeSpaceBytes(dir)` 用 `fs.statfsSync`，不足回 `507 no space`）/ #17 并发守卫（`activeReceiveTid`/`activeSendTid`，冲突回 `429 busy`）/ #20 分页+清理（`transfer:history` 支持 `{limit,offset}` 返 `{data,total}`、`handleEnd` 后 `trimHistory()` 删最旧超 `MAX_HISTORY_ROWS=1000`）。
  - `src/views/fileTransfer/`：最近设备区（#11）/ 重名策略开关（#9）/ 加密开关（#14）/ 接收询问弹窗（订阅 `file-transfer:incoming-ask`，#15）/ 历史「加载更多」（#20）。
  - 桌面端本批 IPC 通道：`transfer:recent-peers` / `transfer:forget-peer` / `transfer:set-rename` / `transfer:set-enc` / `transfer:answer-offer`（#25/#26 前序已落地，本批沿用并接入 UI）。
  - ⚠️ 加密批次不做续传（CTR keystream 不可任意字节对齐），与移动端同语义。

## 五、验证清单（命令由用户本地执行）
1. **重启 Electron**（改了主进程 transferModule/syncModule/index）。
2. PC 发手机：批量 ≥3 文件（含大文件），逐文件进度 + 结果；手机 `Documents/渐离App文件互传/` 收到。
3. 手机发 PC：批量发送；PC `fileNotify` 蓝色路径通知 + 历史正确。
4. 手动 IP：模拟器填 `10.0.2.2` 直传。
5. 边界：重名去重 ` (n)`、非法文件名、接收方关自动接收→发送端被拒。
6. **取消批次**：发大文件途中点「取消发送」→ 当前文件进度转橙色（canceled）、后续文件不再发送、历史出现 `canceled` 记录、按钮恢复可用；取消后 PC 不应崩溃、可再次发送。
7. **热点场景**：手机开热点给 PC，PC 侧点「扫描」应能发现手机（定向广播 + 网关单播，见可选项 A）；再双向收发一次。
8. **sha256 校验**：正常收发后两端历史均 `done`；可人为截断接收（如中途杀进程）观察孤立 `.part` 被 `sweepStale` 清掉；校验失败路径（理论）历史记 `failed` 且 `error` 非空、不弹通知。
9. **历史可操作**：桌面端成功记录点「打开文件」「打开所在文件夹」应正确打开/定位；移动端成功记录点「打开」「分享」。
10. **总进度/速率/ETA**：发送中面板顶部显示批次总进度条 + 速率 + 剩余时间。

## 六、v1 裁剪与后续（P2/P3）
- [x] **可选项 A（已完成，2026-09-06）**：`syncModule.ts` 新增 `discoveryTargets()`——全网受限广播 `255.255.255.255` + 每个 IPv4 非回环接口按真实掩码算的定向广播 `x.y.z.255` + 网关 `x.y.z.1` 单播；`scanPeers` 向全部目标各发一份发现包（应答按 ip 去重）。解决热点场景 PC 扫不到手机。sync 与 transfer 共用 `scanPeers`，同步页一并受益（动 syncModule.ts，需重启 Electron）。
- [x] **sha256 完整校验（已完成，2026-09-06）**：双端流式算 sha256，发送端经 `/file/end` 的 `{hash}` 带出，接收端比对；不一致删坏文件、历史记 `failed`(error=`hash mismatch`)，不弹通知。
- [x] **移动端接收文件「打开/分享」（已完成，2026-09-06）**：新增 `open_filex`+`share_plus`，历史成功记录可「打开」「分享」。
- [x] **健壮性 + 体验补齐（已完成，2026-09-06）**：进度节流、`.part` 定时清理、`incoming` 回收、历史 `error` 列、桌面端历史打开/定位、批次总进度·速率·ETA、`peer_name` 回填。
- [x] **P2 断点续传（已完成，2026-09-06 二批）**：data 带 `?from=N` 追加写 + hash 播种；加密批次整文件重发（见 §二之一 #13）。
- [x] **P3 会话加密（已完成，2026-09-06 二批）**：AES-256-CTR，offer 协商 `enc` 字段、data 密文流；默认关、向后兼容（见 §二之一 #14）。
- [x] **#9 重名覆盖策略 / #10 文件夹·拖拽 / #11 最近设备 / #15 接收询问 / #16 磁盘预估 / #17 并发守卫 / #20 历史分页+自动清理**（均已完成，2026-09-06 二批，见 §二之一）。
- 不做：传输历史跨设备同步（设备本地）；云端中转（纯局域网直连）。

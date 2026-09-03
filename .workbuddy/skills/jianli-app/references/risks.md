# 已知差异与风险（risks）

> 封装 / 开发前必读，避免踩历史雷。以下为代码探查时发现的与文档 / 规范不符或易错处。

1. **node 版本不一致**：README「安装」写 v20.13.1，但 `package.json` `engines` 要求 `>=22` 且 `prestart` 跑 `check-node-version.js` 会拦截——**以代码为准，需 node 22+**。
2. **get-store typo**：`store.ts` 注册的是 `get-stort-all`（疑似拼写错误），调用方若用 `get-store-all` 将失效。
3. **双数据层已合并（2026-09-03）**：`module/sql.ts` 已删除，`newSql.ts` 为唯一连接池（启动按打包路径打开只读 `shiciDb` 并跳过 WAL）。渲染端旧通道 `query-data`/`set-data`/`delete-data` 早已迁移到 `new-sql:query`/`upsert`/`delete`；`utils/sql.ts` 仅留无独立连接的回调式辅助函数。新增业务一律走 newSql 三件套，语义差异：旧层 `whereStr`/`limit`/`orderBy` 塞 `conditions` 内，新层必须放顶层 options。详见 `data-layer.md`。
4. **死 / 未接通道**：渲染端 `invoke`/`send` 的 `save-file`、`get-file-list`、`save-debug-data` 在主进程未找到 handler（可能走 worker 或已废弃），封装前核实。
5. **new-sql:execute 仍存在**：危险通道代码层未移除，只靠规范约束——**永远不要调用**。
6. **遗留 / 未注册项**：`src/views/chart` 目录存在但未注册路由（疑似废弃）；`src/views/test.vue`、`src/demos/ipc.ts` 为调试残留；根 `功能清单.md` 为空占位。
7. **命令面板作用域耦合**：新增源需同时改 `REGISTRY`、`SCOPE_PREFIX_MAP`/`SCOPE_LABEL`/`TYPE_META`、`CommandType`、`SCOPE_PATTERN`，否则作用域不生效。
8. **小窗穿透**：新常驻小窗务必 `mouseEvents:true`，否则点不动 / 拖不动。
9. **Tab 内容面板勿用 `<transition mode="out-in">`**：`out-in` 离场动画结束后进入态 `transitionend` 不触发，新面板卡在 `opacity:0` → 点 Tab 后下方空白。多 Tab 页（homeMode / windowMode）改为直接 `v-if`/`:key` 渲染当前面板；切换动画要用就在子元素上做、不要包 `out-in`。
10. **顶部 Tab 复用 `TopTabs`**：多 Tab 页统一用 `src/smallComponents/TopTabs.vue`（单行不换行 + 滚轮横滚 + 滚动条仅 hover 显示），不要各页自写 tab 栏；其 `emit` 为 `string | number`，消费方需 `as` 回严格联合类型。

16. **待办已移除裸 `new-sql:execute`**：`index.vue`/`todoSource` 改为 `new-sql:query` + 客户端过滤，`TodoDetailDialog` 用 `new-sql:upsert`；新增待办逻辑一律走三件套，禁止 execute。
17. **重复任务引擎在主进程**：`electron/main/module/recurrence.ts` 的 `initRecurrence()` 在 `main/index.ts`（`initJob()` 之后）注册，改它或 `job.ts` 必须重启 Electron；生成实例写入 todo_list（recurrenceId/isRecurrenceInstance），默认列表隐藏模板。
18. **待办迷你窗(todoMiniWindow)已统一到新数据层**：原本地 `new-sql:execute` 全部替换为 `fetchAllTodos`/`saveTodo`（走 `new-sql:query`/`upsert`）；新增待办经 `normalize` 补全新模型字段，列表默认隐藏子任务(`parentId` 非空)与重复模板(`recurrenceRule` 非空且 `recurrenceId` 为空)，与主窗口默认行为一致。
19. **标签筛选/编辑改为 TagSelectPopover 多选**：`useTodo.tagFilter`(单值) 已改为 `tagFilters`(`string[]` 数组，或逻辑匹配)；筛选栏与 `TodoDetailDialog` 的标签编辑均复用新组件 `components/TagSelectPopover.vue`（el-popover 内彩色 chip 多选 + 底部新增标签）。日历视图点击日期改为 `el-popover`(`virtual-ref` 锚定日期格) 弹出当日列表，移除原下方常驻面板。

20. **upsert 依赖 key 列唯一索引（编辑变新增的根因）**：`newSql.upsert` 用 `ON CONFLICT(key)` 实现更新，但 `ensureTableExists` 原逻辑仅当「主键列不存在」时才建 UNIQUE 索引。重构前用裸 `execute` 建表的旧 `todo_list`/`todo_tags`，其 `key`/`id` 列**已存在却无唯一约束**，导致 `ON CONFLICT` 永不命中、upsert 退化为重复 INSERT——典型表现「编辑待办却新增一条」。已修复：`ensureTableExists` 改为「无论列是否存在都确保 UNIQUE 索引，失败时先按主键去重(保留最新一条)再重试」；并在 `main/index.ts` 启动时主动 `ensureTableExists('todo_list','key')` / `('todo_tags','id')` 清理历史重复。**改主进程必须重启 Electron 生效。**

21. **单一提醒引擎（2026-09-03 统一）**：原 newReminder（setTimeout）与 job.ts+recurrence.ts（cron）的待办截止提醒已统一为 newReminder 引擎——待办截止提醒写成 `reminders` 表 `source='todo'` 行由 `syncTodoReminders()` 调度，`get-tips` 已过滤系统行，`update-todo-reminders` IPC 现由 newReminder 监听。job.ts 仅留工作/休息定时器（`createJob`/`startJobFn`）。清理 todo 行走 `query` 列出 + `del`，**勿用 `new-sql:execute`**；`source`/`refKey` 列由 upsert 自动补，勿手动加列。改 newReminder/job.ts/recurrence.ts 均须重启 Electron。

## 维护建议
- 每次大改动后更新对应 `references/modules/*.md` 与 `risks.md`，保持 skill 与代码同步。
- skill 内容会随代码演进过时，把它作为「项目知识基线」，发现不符就改。

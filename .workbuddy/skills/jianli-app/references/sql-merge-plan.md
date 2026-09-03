# 双 SQL 层合并设计方案

> **执行状态（2026-09-03）**：Phase 0 + 旧层文件删除已完成 —— `electron/main/module/sql.ts` 已删除，`newSql.ts` 成为唯一连接池（启动按打包路径 `vitePublic/宋词/ci.db` 打开只读 `shiciDb` 并跳过 WAL）；10 个主进程调用方的 `myDb` 导入改指 `newSql.ts`；deprecated IPC `query-data`/`set-data`/`delete-data` 一并移除；`index.ts` 仅 `initNewSqlite()`、`backup.ts` 去掉 `oldMyDb`/`reopenSqlite`。详见 `data-layer.md`。`utils/sql.ts` 保留为无独立连接的辅助层。

> 目标：把并存的「旧层 `sql.ts`/`utils/sql.ts`」与「新层 `newSql.ts`」收敛为**唯一数据层 `newSql.ts`**，消除重复逻辑、回调/Promise 双风格、以及 deprecated IPC，降低后续扩展（统一日历、AI 检索、笔记合并等）的摩擦。

## 1. 现状盘点（已核实）

**旧层**
- `electron/main/utils/sql.ts`：回调式核心实现 `createTable` / `queryByConditions` / `upsertData` / `deleteData` / `ensureTableColumns`，自带互斥锁 `withDbLock`。
- `electron/main/module/sql.ts`：导出 `myDb`（{db,userDb,shiciDb}）、`initSqlite`、`reopenSqlite`，并注册 deprecated IPC `query-data`/`set-data`/`delete-data`。
- 语义特点：`orderBy/orderByDesc/limit/offset/whereStr/SqlStr` 都塞在 `conditions` 内；`upsertData` 自动建表 + 自动 `ALTER ADD COLUMN TEXT` + `ON CONFLICT(id)`，无唯一索引；多库靠 `db: myDb.xxx` 选择。

**新层**
- `electron/main/module/newSql.ts`：Promise API `query/count/insert/upsert/update/del/transaction/execute/ensureTableExists/listTables/tableInfo`，WAL 模式，强约束（`ensureTableExists` 自动建唯一索引 + 重复主键去重修复）。
- 所有操作**固定落在 `myDb.db`**，无 db 选择参数。

**仍引用旧层的调用方（主进程）**
`index.ts`(initSqlite)、`backup.ts`(双库都引用)、`job.ts`、`newWindow.ts`、`poetData.ts`(shiciDb)、`registerShortcut.ts`、`stock.ts`(部分)、`stockCache.ts`、`stockTtlStore.ts`、`store.ts`、`tray.ts`。`clipboard.ts` 已大量迁到 newSql，仅残留旧 import。

**关键事实**
- 渲染端（`src/**`）已不再调用旧 IPC `query-data/set-data/delete-data`（仅注释提及）→ deprecated IPC 可安全删除。
- `userDb`：除旧层自身 `initSqliteFn('userDb')` 与 `backup.ts` 备份清单条目外无人使用 → 判定为死库，合并时删除。
- `shiciDb`：仅 `poetData` 使用（宋词只读库）→ 保留，通过新层 `dbName:'shiciDb'` 承接。

## 2. 目标态

- 单一数据层 `newSql.ts`；`sql.ts` 与 `utils/sql.ts` 删除。
- 新层新增可选 `dbName?: 'db' | 'shiciDb'`（默认 `'db'`），`query/insert/upsert/update/del/transaction/count/execute` 内部 `getDb(dbName)` 取连接。
- 删除 deprecated IPC；`index.ts` 仅 `initNewSqlite()`；`backup.ts` 仅 `reopenNewSqlite()` 且备份清单去掉 `userDb`。

## 3. 设计决策

1. **不写兼容垫片长期存在**：短期用「旧层薄适配器」做零风险过渡（Phase 0），但 Phase 2 直接删除旧层，不让两套 API 长期共存。
2. **多库用 `dbName` 参数而非多实例**：避免旧层 `myDb.xxx` 散落调用；`shiciDb` 是唯一多库场景。
3. **`userDb` 直接删除**：无业务表、无渲染端引用，删除连接池项与备份清单条目。
4. **deprecated IPC 删除**：渲染端已无调用，删除 `query-data/set-data/delete-data` 注册。
5. **保留 `execute` 但继续红线禁用**：代码层保留（系统/迁移工具需要），靠 `data-layer.md`/`sql-db-ops.md` 红线约束业务不使用。

## 4. 三阶段实施

### Phase 0 — 薄适配器（零风险、可回滚）
- 用 newSql 重新实现 `utils/sql.ts` 的导出（`queryByConditions/upsertData/deleteData/createTable`）作为适配层：内部 `getDb` 把 `db` 实例映射回 `dbName`，转换为 `query/upsert/del/ensureTableExists` 调用，`orderBy/limit/offset` 从 `conditions` 提升到顶层。
- `module/sql.ts` 的 `myDb`/`initSqlite`/`reopenSqlite` 改为委托 newSql；deprecated IPC 暂留。
- 效果：旧层逻辑已退役，但调用方无需改动即可继续工作；后续可独立迁移。

### Phase 1 — 调用方直迁 newSql（按模块，逐个 PR）
每个模块机械替换（见 `sql-db-ops.md` §5）：去回调改 `await`、提升 `orderBy/limit/offset`、改 `dbName`。迁移顺序（按风险从低到高）：
1. `store.ts`、`tray.ts`、`registerShortcut.ts`、`newWindow.ts` —— 纯配置表。
2. `job.ts` —— 待办截止提醒。
3. `stock.ts`、`stockCache.ts`、`stockTtlStore.ts` —— 股票缓存。
4. `poetData.ts` —— 改 `dbName:'shiciDb'`。
5. `clipboard.ts` —— 删除残留旧 import。
6. `backup.ts` —— 去掉 `oldMyDb`/`reopenSqlite`，仅 `reopenNewSqlite()`，备份清单移除 `userDb`。
7. `index.ts` —— 删除 `initSqlite()` 调用，保留 `initNewSqlite()`。

每步后用 grep 确认该模块不再 `import ... from "../utils/sql.ts"` 或 `from "./sql.ts"`。

### Phase 2 — 删除旧层
- 删除 `electron/main/utils/sql.ts`、`electron/main/module/sql.ts`。
- 删除 `module/sql.ts` 中 deprecated IPC 注册。
- 全仓 grep `utils/sql.ts`、`module/sql.ts`、`query-data|set-data|delete-data`、`myDb.userDb` 确认无残留。
- 更新 `data-layer.md`：把「两套并存」改为「唯一 newSql 层」并指向本文与 `sql-db-ops.md`。

## 5. 验证与回滚

- **静态**：`vue-tsc --noEmit`（或主进程独立 noEmit tsconfig）零错误；grep 无旧层 import。
- **动态冒烟**（测试库先 `cp` 备份 `db.sqlite`）：启动后 `new-sql:listTables` 表齐全；`basic_info`/`clipboard_history` 可读写；股票缓存刷新正常；宋词（`shiciDb`）能查；触发一次备份恢复，`reopenNewSqlite` 无报错。
- **回滚**：Phase 0/1 出问题只需 `git revert` 单个模块；Phase 2 前务必保留旧层文件一份于分支。数据层面：测试前复制 `db.sqlite`，异常即用复制覆盖。

## 6. 风险与缓解
- **`conditions` 内 `orderBy` 等漏提升** → 自动退化为等值过滤条件，可能查出脏数据；迁移时 grep `orderBy:` 在 `conditions` 对象内的写法人工核对。
- **`shiciDb` 漏加 `dbName`** → 查到主库空表；`poetData` 迁移时显式传 `dbName:'shiciDb'` 并冒烟。
- **备份恢复断连** → `backup.ts` 删旧引用后必须保留 `reopenNewSqlite` 且 WAL 重建；冒烟覆盖。
- **`execute` 误用污染表** → 红线 + Code Review 拦截；业务一律 `query/upsert/del`。

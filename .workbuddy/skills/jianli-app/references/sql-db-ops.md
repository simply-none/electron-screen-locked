# SQL 数据库操作（统一数据层 newSql）

> 本文是「渐离App」统一的 SQLite 数据层操作手册。合并双 SQL 层后，**唯一数据层即 `electron/main/module/newSql.ts`**（旧层 `sql.ts` / `utils/sql.ts` 已删除，详见 `sql-merge-plan.md`）。任何建表、读写、迁移都走这里。

## 1. 入口与初始化

- `initNewSqlite()`：建库文件 + 开启 WAL 模式（`journal_mode=WAL`、`synchronous=NORMAL`、`busy_timeout=5000`）。`index.ts` 启动期调用。
- `reopenNewSqlite()`：备份恢复流程关闭并重建连接（不重复注册 IPC）。渲染端 `pick` 恢复后由主进程调用。
- 连接池 `myDb` 仅保留主库 `db`（对应 `db.sqlite`）。多库通过**操作函数的 `dbName` 参数**选择（见 §4），不再用单独的 `myDb.xxx` 实例。

## 2. 核心 API（全部 Promise，落在 `myDb[dbName]`，默认 `db`）

| 函数 | 用途 | 关键参数 |
|---|---|---|
| `query(opts)` | 查询 | `tableName, conditions?, columns?, orderBy?, orderByDesc?, limit?, offset?, whereStr?, SqlStr?, primaryKey?, config?, dbName?` |
| `count(tableName, condition?)` | 计数 | 返回 number |
| `insert(opts)` | 插入（冲突报错，不更新） | `tableName, data`(单/批), `config?` |
| `upsert(opts)` | 插入或更新 | 靠 `config.primaryKey` 上的**唯一索引**触发更新 |
| `update(opts)` | 按条件更新 | `tableName, data, condition`（均不可空） |
| `del(opts)` | 按条件删除 | `tableName, condition`（**不可空**，防误删全表） |
| `transaction({sqls, params?})` | 多语句事务 | 原子提交，失败回滚 |
| `ensureTableExists(tableName, columns?, primaryKey?, config?)` | 幂等建表 | 自动建表 + 建唯一索引 + 去重修复 |
| `listTables()` / `tableInfo(tableName)` | 自省 | 表清单 / 列信息 |
| `execute(sql, params?, primaryKey?)` | 任意 SQL | ❌ **业务禁用**（见 §6） |

> `query` 支持三种形态：① 完整 SQL `SqlStr`（顶层或 `conditions.SqlStr`）；② `whereStr` 自定义 WHERE；③ `conditions` 等值条件对象（自动拼 `col = ?`）。`orderBy/limit/offset` 必须在 **options 顶层**，不要塞进 `conditions`（这是与旧层最大的语义差异）。

## 3. 渲染端调用（IPC）

主进程已注册 `new-sql:query / count / insert / upsert / update / delete / transaction / listTables / tableInfo / record-pomodoro`。渲染端统一封装薄函数后调用：

```ts
// src/views/xxx/api/xxxApi.ts
export async function queryData(opts: QueryOptions) {
  const res = await window.ipcRenderer.invoke('new-sql:query', opts);
  return res.success ? (res.data ?? []) : [];
}
export async function upsertRow(tableName: string, data: Record<string, any>, primaryKey = 'id') {
  return window.ipcRenderer.invoke('new-sql:upsert', { tableName, data, config: { primaryKey } });
}
```

> 渲染端**禁止** `import electron/*`；所有 DB 操作必须经 IPC。剪贴板等每秒热路径用进程内缓存，不要高频查库。

## 4. 多库选择（迁移自旧层）

旧层用 `myDb.db / myDb.userDb / myDb.shiciDb` 三个实例选择库；新层收敛为单主库 + `dbName` 参数：

- 默认 `'db'`（主库 `db.sqlite`）。
- `'shiciDb'`：宋词只读库（原 `public/宋词/ci.db`），仅 `poetData` 模块使用。
- `userDb` 已删除（无业务表，仅旧备份清单引用，合并时一并移除备份清单条目）。

```ts
// 旧层
queryByConditions({ db: myDb.shiciDb, tableName: 'ci', conditions: { author: '苏轼' } }, cb);
// 新层
await query({ tableName: 'ci', conditions: { author: '苏轼' }, dbName: 'shiciDb' });
```

## 5. 旧层 → 新层 迁移映射（接手人速查）

| 旧层（`utils/sql.ts`，回调式） | 新层（`newSql.ts`，Promise） |
|---|---|
| `queryByConditions({db,tableName,conditions:{...SqlStr/whereStr/orderBy/orderByDesc/limit/offset, 列}})` | `query({tableName, conditions:{列}, orderBy, orderByDesc, limit, offset, whereStr, SqlStr, dbName})` |
| `upsertData({db,tableName,data,config:{primaryKey}}, cb)` | `upsert({tableName, data, config:{primaryKey, primaryKeyType}, dbName})` |
| `deleteData({db,tableName,condition}, cb)` | `del({tableName, condition, dbName})` |
| `createTable({db,tableName,config:{primaryKey}}, cb)` | `ensureTableExists(tableName, undefined, primaryKey, {primaryKeyType}, dbName)` |

**迁移三步机械替换**：① 去掉回调，改为 `await`；② 把 `conditions` 里的 `orderBy/orderByDesc/limit/offset` 提到 options 顶层；③ `db: myDb.xxx` 改为 `dbName:'xxx'`（默认 `db` 可省）。

## 6. 红线（务必遵守）

1. ❌ **严禁裸 `new-sql:execute`**：其 `extractColumnNames` 对 `SELECT *`/`DELETE` 猜不出列名时会兜底 `['name','value','created_at']` 并 `ALTER ADD COLUMN`，污染业务表（曾致 `habit_def` 破表）。只读/写业务表请用 `query/upsert/insert/update/del`。
2. SQLite **不允许 `ALTER TABLE ADD COLUMN ... PRIMARY KEY`**。补主键两步：① `ADD COLUMN key TEXT`；② `CREATE UNIQUE INDEX uq_t_key ON t(key)`。`ensureTableExists` 已自动处理。
3. 业务表统一以 `key(TEXT)` 作主键；`upsert` 透传 `primaryKey:'key'`，否则退化为重复 INSERT。
4. 改主进程 `newSql.ts` 后**必须重启 Electron**。
5. 多写并发：WAL 已开启；跨进程唯一入口（如番茄钟去重 `recordPomodoro`）需在主进程串行，不要放到渲染端。

## 7. 何时读本文档
任何「建表 / 读写业务数据 / 补列 / 多库 / 迁移旧层调用」任务。具体模块的数据访问见 `modules/*.md`。

/**
 * 高性能 SQLite 数据库操作模块
 * 
 * 本模块基于 sqlite3 库实现，提供以下特性：
 * - WAL (Write-Ahead Logging) 模式支持，提升并发读写性能
 * - Promise 风格 API，替代回调模式
 * - 自动表创建和列扩展
 * - 事务支持
 * - IPC 通信接口，供渲染进程调用
 * 
 * @module newSql
 */

import { ipcMain, app } from "electron";
import defaultSqlite3 from "sqlite3";
import type { Database } from "sqlite3";
import path from "node:path";
import fs from "node:fs";
import { store } from "./store.ts";
import { vitePublic } from "../variables.ts";

const verbose = defaultSqlite3.verbose;

/**
 * 数据库实例集合
 * - db: 主数据库
 * - userDb: 用户数据库
 * - shiciDb: 诗词数据库
 */
export let myDb: Record<string, Database> = {
  db: null,
  userDb: null,
  shiciDb: null,
};

/**
 * 查询选项接口
 */
interface QueryOptions {
  /** 表名 */
  tableName: string;
  /** 查询条件对象 */
  conditions?: Record<string, any>;
  /** 指定查询的列 */
  columns?: string[];
  /** 排序字段 */
  orderBy?: string;
  /** 是否降序排序 */
  orderByDesc?: boolean;
  /** 查询条数限制 */
  limit?: number;
  /** 查询偏移量 */
  offset?: number;
  /** 自定义 WHERE 条件字符串 */
  whereStr?: string;
  /**
   * 完整的 SQL 查询语句。
   * 可放在顶层（SqlStr），也可放在 conditions.SqlStr —— query() 两者都支持。
   */
  SqlStr?: string;
  /**
   * 首次自动建表时使用的主键字段名（可选）。
   * 透传给 ensureTableExists：对以 query 作为首次访问的表，
   * 可借此指定主键（否则使用默认的 id 自增主键）。
   * 既存表不受影响，纯增量、向后兼容。
   */
  primaryKey?: string;
  /** 首次自动建表时的主键配置（可选），透传给 ensureTableExists */
  config?: { primaryKeyType?: "INTEGER" | "TEXT" };
}

/**
 * 插入选项接口
 */
interface InsertOptions {
  /** 表名 */
  tableName: string;
  /** 要插入的数据，支持单条或多条 */
  data: Record<string, any> | Record<string, any>[];
  /** 配置选项 */
  config?: {
    /** 主键字段名，默认为 id */
    primaryKey?: string;
    /** 主键类型，INTEGER 或 TEXT，缺省按主键名推导（id→INTEGER，其它→TEXT） */
    primaryKeyType?: "INTEGER" | "TEXT";
  };
}

/**
 * 更新选项接口
 */
interface UpdateOptions {
  /** 表名 */
  tableName: string;
  /** 要更新的数据 */
  data: Record<string, any>;
  /** 更新条件 */
  condition: Record<string, any>;
}

/**
 * 删除选项接口
 */
interface DeleteOptions {
  /** 表名 */
  tableName: string;
  /** 删除条件 */
  condition: Record<string, any>;
}

/**
 * 事务选项接口
 */
interface TransactionOptions {
  /** 要执行的 SQL 语句数组 */
  sqls: string[];
  /** 对应的参数数组 */
  params?: any[][];
}

/**
 * 初始化 SQLite 数据库
 *
 * 执行流程：
 * 1. 创建数据库文件（如果不存在）
 * 2. 初始化 WAL 模式以提升并发性能
 *
 * @returns {Promise<void>}
 */
export async function initNewSqlite() {
  await createDBFile();
  await initWALMode();
}

/**
 * 重新打开数据库连接并恢复 WAL 模式（供备份恢复流程调用）
 *
 * 执行流程：
 * 1. 逐个关闭现有数据库连接（close 回调式，容忍单个失败）
 * 2. 重新执行 createDBFile 建立连接
 * 3. 重新初始化 WAL 模式
 *
 * @returns {Promise<void>} 重连完成时 resolve；单库关闭失败不中断整体流程
 */
export async function reopenNewSqlite() {
  for (const dbName of Object.keys(myDb)) {
    const conn = myDb[dbName];
    if (!conn) continue;
    try {
      await new Promise<void>((resolve) => conn.close(() => resolve()));
    } catch (err) {
      console.error("reopenNewSqlite 关闭连接失败:", dbName, err);
    }
  }
  await createDBFile();
  await initWALMode();
}

/**
 * 创建数据库文件
 * 
 * 检查并创建数据库文件目录，初始化数据库连接实例。
 * 数据库文件存储在用户文档目录或配置的缓存路径中。
 * 
 * @returns {Promise<void>}
 */
async function createDBFile() {
  const userDataPath = app.getPath("documents");
  let cachePath: string = (store.get("fileCachePath") ||
    userDataPath) as string;

  if (!fs.existsSync(cachePath)) {
    fs.mkdirSync(cachePath, { recursive: true });
  }

  Object.keys(myDb).forEach((dbName) => {
    const sqlite3 = verbose();
    // 宋词只读库：随应用分发，从打包资源打开（与旧层行为一致），不写缓存、不切 WAL
    if (dbName === "shiciDb") {
      const shiciDbPath = path.resolve(vitePublic, "宋词/ci.db");
      myDb[dbName] = new sqlite3.Database(shiciDbPath);
      return;
    }
    let dbFullName = dbName + ".sqlite";
    if (!fs.existsSync(path.resolve(cachePath, dbFullName))) {
      fs.writeFileSync(path.resolve(cachePath, dbFullName), "");
    }

    let dbPath = path.resolve(cachePath, dbFullName);
    myDb[dbName] = new sqlite3.Database(dbPath);
  });
}

/**
 * 初始化 WAL 模式
 * 
 * WAL (Write-Ahead Logging) 模式可以提升 SQLite 的并发读写性能。
 * 同时设置：
 * - synchronous = NORMAL：平衡性能和安全性
 * - busy_timeout = 5000ms：锁等待超时时间
 * 
 * @returns {Promise<void>}
 */
async function initWALMode() {
  for (const dbName of Object.keys(myDb)) {
    // 宋词只读库不参与 WAL（打包资源不可写），跳过 PRAGMA
    if (dbName === "shiciDb") continue;
    await new Promise<void>((resolve, reject) => {
      myDb[dbName].run("PRAGMA journal_mode = WAL;", (err) => {
        if (err) {
          reject(err);
        } else {
          myDb[dbName].run("PRAGMA synchronous = NORMAL;", (err2) => {
            if (err2) {
              reject(err2);
            } else {
              myDb[dbName].run("PRAGMA busy_timeout = 5000;", (err3) => {
                err3 ? reject(err3) : resolve();
              });
            }
          });
        }
      });
    });
  }
}

/**
 * 查询数据
 * 
 * 支持多种查询方式：
 * 1. 完整 SQL 语句查询（SqlStr）
 * 2. 条件对象查询（conditions）
 * 3. 自定义 WHERE 字符串查询（whereStr）
 * 
 * 自动确保表存在，支持排序、分页。
 * 
 * @param {QueryOptions} options - 查询选项
 * @returns {Promise<any[]>} 查询结果数组
 */
export async function query(options: QueryOptions): Promise<any[]> {
  const { tableName, conditions, columns, orderBy, orderByDesc, limit, offset, whereStr, SqlStr, primaryKey, config } = options;
  await ensureTableExists(tableName, undefined, primaryKey, config);
  const db = myDb.db;

  // 支持两种传完整 SQL 的方式：顶层 SqlStr，或 conditions.SqlStr（与注释/其它模块约定一致）
  const rawSql = SqlStr || (conditions && conditions.SqlStr);

  return new Promise((resolve, reject) => {
    if (rawSql) {
      db.all(rawSql, [], (err, rows) => {
        if (err) {
          reject(err);
        } else {
          resolve(rows);
        }
      });
      return;
    }

    let sql = "";
    const params: any[] = [];

    const selectColumns = columns && columns.length > 0 ? columns.join(", ") : "*";

    if (whereStr) {
      sql = `SELECT ${selectColumns} FROM ${tableName} WHERE ${whereStr}`;
    } else {
      const whereClauses: string[] = [];

      if (conditions) {
        for (const [key, value] of Object.entries(conditions)) {
          // SqlStr 已在上方作为完整 SQL 处理；orderBy 等属于 options 级参数，非列过滤
          if (["orderBy", "orderByDesc", "limit", "offset", "SqlStr"].includes(key)) {
            continue;
          }
          whereClauses.push(`${key} = ?`);
          params.push(value);
        }
      }

      const wherePart = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";
      sql = `SELECT ${selectColumns} FROM ${tableName} ${wherePart}`;
    }

    if (orderBy) {
      sql += ` ORDER BY ${orderBy} ${orderByDesc ? "DESC" : "ASC"}`;
    }

    if (limit) {
      sql += ` LIMIT ${limit}`;
    }

    if (offset) {
      sql += ` OFFSET ${offset}`;
    }

    db.all(sql, params, (err, rows) => {
      if (err) {
        reject(err);
      } else {
        resolve(rows);
      }
    });
  });
}

/**
 * 计数查询
 * 
 * 查询表中满足条件的记录数。
 * 
 * @param {string} tableName - 表名
 * @param {Record<string, any>} [condition] - 查询条件
 * @returns {Promise<number>} 记录数量
 */
export async function count(tableName: string, condition?: Record<string, any>): Promise<number> {
  const db = myDb.db;

  return new Promise((resolve, reject) => {
    let sql = `SELECT COUNT(*) as count FROM ${tableName}`;
    const params: any[] = [];

    if (condition && Object.keys(condition).length > 0) {
      const whereClauses = Object.keys(condition).map((key) => `${key} = ?`);
      sql += ` WHERE ${whereClauses.join(" AND ")}`;
      params.push(...Object.values(condition));
    }

    db.get(sql, params, (err, row) => {
      if (err) {
        reject(err);
      } else {
        resolve((row as any)?.count || 0);
      }
    });
  });
}

/**
 * 插入数据
 * 
 * 支持单条和批量插入，自动确保表和列存在。
 * 使用事务保证批量插入的原子性。
 * 
 * @param {InsertOptions} options - 插入选项
 * @returns {Promise<{ lastID: number; changes: number }>} 插入结果
 * @throws {Error} 当数据为空时抛出异常
 */
export async function insert(options: InsertOptions): Promise<{ lastID: number; changes: number }> {
  const { tableName, data, config } = options;
  await ensureTableExists(tableName, undefined, config?.primaryKey, config);
  const db = myDb.db;
  const newData = Array.isArray(data) ? data : [data];

  if (newData.length === 0) {
    throw new Error("No data provided");
  }

  const columns = Object.keys(newData[0]);
  if (columns.length === 0) {
    throw new Error("No data fields provided");
  }

  return new Promise((resolve, reject) => {
    db.run("BEGIN TRANSACTION;", async (beginErr) => {
      if (beginErr) {
        reject(beginErr);
        return;
      }

      try {
        await ensureTableColumns(db, tableName, newData, config);

        const placeholders = columns.map(() => "?").join(",");
        const sql = `INSERT INTO ${tableName} (${columns.join(",")}) VALUES (${placeholders})`;

        let lastID = 0;
        let totalChanges = 0;

        const stmt = db.prepare(sql);

        for (const item of newData) {
          await new Promise<void>((res, rej) => {
            const values = columns.map((col) => item[col]);
            stmt.run(values, function (err) {
              if (err) {
                rej(err);
              } else {
                lastID = this.lastID;
                totalChanges += this.changes;
                res();
              }
            });
          });
        }

        stmt.finalize();

        db.run("COMMIT;", (commitErr) => {
          if (commitErr) {
            db.run("ROLLBACK;", () => {});
            reject(commitErr);
          } else {
            resolve({ lastID, changes: totalChanges });
          }
        });
      } catch (err) {
        db.run("ROLLBACK;", () => {});
        reject(err);
      }
    });
  });
}

/**
 * 插入或更新数据 (Upsert)
 * 
 * 使用 SQLite 的 ON CONFLICT 语法实现插入或更新。
 * 当主键冲突时自动更新已有记录。
 * 
 * @param {InsertOptions} options - 插入选项
 * @returns {Promise<{ lastID: number; changes: number }>} 操作结果
 * @throws {Error} 当数据为空时抛出异常
 */
export async function upsert(options: InsertOptions): Promise<{ lastID: number; changes: number }> {
  const { tableName, data, config } = options;
  await ensureTableExists(tableName, undefined, config?.primaryKey, config);
  const db = myDb.db;
  const newData = Array.isArray(data) ? data : [data];

  if (newData.length === 0) {
    throw new Error("No data provided");
  }

  const columns = Object.keys(newData[0]);
  if (columns.length === 0) {
    throw new Error("No data fields provided");
  }

  return new Promise((resolve, reject) => {
    db.run("BEGIN TRANSACTION;", async (beginErr) => {
      if (beginErr) {
        reject(beginErr);
        return;
      }

      try {
        await ensureTableColumns(db, tableName, newData, config);

        const placeholders = columns.map(() => "?").join(",");
        const primaryKey = config?.primaryKey || "id";
        const updateClause = columns.map((col) => `${col}=excluded.${col}`).join(",");
        
        const sql = `INSERT INTO ${tableName} (${columns.join(",")}) VALUES (${placeholders}) ON CONFLICT(${primaryKey}) DO UPDATE SET ${updateClause}`;

        let lastID = 0;
        let totalChanges = 0;

        const stmt = db.prepare(sql);

        for (const item of newData) {
          await new Promise<void>((res, rej) => {
            const values = columns.map((col) => item[col]);
            stmt.run(values, function (err) {
              if (err) {
                rej(err);
              } else {
                lastID = this.lastID;
                totalChanges += this.changes;
                res();
              }
            });
          });
        }

        stmt.finalize();

        db.run("COMMIT;", (commitErr) => {
          if (commitErr) {
            db.run("ROLLBACK;", () => {});
            reject(commitErr);
          } else {
            resolve({ lastID, changes: totalChanges });
          }
        });
      } catch (err) {
        db.run("ROLLBACK;", () => {});
        reject(err);
      }
    });
  });
}

/**
 * 更新数据
 * 
 * 根据条件更新表中的记录。
 * 
 * @param {UpdateOptions} options - 更新选项
 * @returns {Promise<{ changes: number }>} 更新结果
 * @throws {Error} 当数据为空或条件为空时抛出异常
 */
export async function update(options: UpdateOptions): Promise<{ changes: number }> {
  const { tableName, data, condition } = options;
  await ensureTableExists(tableName);
  const db = myDb.db;

  if (Object.keys(data).length === 0) {
    throw new Error("No data fields provided");
  }

  if (!condition || Object.keys(condition).length === 0) {
    throw new Error("Condition cannot be empty");
  }

  return new Promise((resolve, reject) => {
    const updateColumns = Object.keys(data).map((key) => `${key} = ?`).join(", ");
    const whereClauses = Object.keys(condition).map((key) => `${key} = ?`).join(" AND ");
    const values = [...Object.values(data), ...Object.values(condition)];

    const sql = `UPDATE ${tableName} SET ${updateColumns} WHERE ${whereClauses}`;

    db.run(sql, values, function (err) {
      if (err) {
        reject(err);
      } else {
        resolve({ changes: this.changes });
      }
    });
  });
}

/**
 * 删除数据
 * 
 * 根据条件删除表中的记录。
 * 
 * @param {DeleteOptions} options - 删除选项
 * @returns {Promise<{ changes: number }>} 删除结果
 * @throws {Error} 当条件为空时抛出异常
 */
export async function del(options: DeleteOptions): Promise<{ changes: number }> {
  const { tableName, condition } = options;
  await ensureTableExists(tableName);
  const db = myDb.db;

  if (!condition || Object.keys(condition).length === 0) {
    throw new Error("Condition cannot be empty");
  }

  return new Promise((resolve, reject) => {
    const whereClauses = Object.keys(condition).map((key) => `${key} = ?`).join(" AND ");
    const values = Object.values(condition);

    const sql = `DELETE FROM ${tableName} WHERE ${whereClauses}`;

    db.run(sql, values, function (err) {
      if (err) {
        reject(err);
      } else {
        resolve({ changes: this.changes });
      }
    });
  });
}

/**
 * 执行任意 SQL 语句
 * 
 * 支持 SELECT/INSERT/UPDATE/DELETE 等所有 SQL 语句。
 * 自动提取表名和列名，确保表和列存在。
 * 如果执行失败且原因是缺少列，会自动添加列并重试。
 * 
 * @param {string} sql - SQL 语句
 * @param {any[]} [params] - SQL 参数
 * @param {string} [primaryKey='id'] - 主键字段名，默认为 id
 * @returns {Promise<{ lastID: number; changes: number; rows?: any[] }>} 执行结果
 */
export async function execute(sql: string, params: any[] = [], primaryKey: string = 'id'): Promise<{ lastID: number; changes: number; rows?: any[] }> {
  const tableName = extractTableName(sql);
  if (tableName) {
    const columns = extractColumnNames(sql);
    await ensureTableExists(tableName, columns, primaryKey);
  }
  const db = myDb.db;

  /**
   * 执行 SQL 语句的内部函数
   * @returns {Promise<{ lastID: number; changes: number; rows?: any[] }>}
   */
  async function executeSql(): Promise<{ lastID: number; changes: number; rows?: any[] }> {
    return new Promise((resolve, reject) => {
      const isSelect = /^\s*SELECT/i.test(sql);
      
      if (isSelect) {
        db.all(sql, params, (err, rows) => {
          if (err) {
            reject(err);
          } else {
            resolve({ lastID: 0, changes: 0, rows });
          }
        });
      } else {
        db.run(sql, params, function (err) {
          if (err) {
            reject(err);
          } else {
            resolve({ lastID: this.lastID, changes: this.changes });
          }
        });
      }
    });
  }

  try {
    return await executeSql();
  } catch (err) {
    const errorMsg = (err as Error).message;
    const noColumnMatch = errorMsg.match(/no column named (\w+)/i);
    const tableMatch = errorMsg.match(/table (\w+)/i);
    
    if (noColumnMatch && tableMatch && tableName) {
      const missingColumn = noColumnMatch[1];
      const errorTableName = tableMatch[1];
      
      if (errorTableName === tableName) {
        await new Promise<void>((resolve) => {
          db.run(`ALTER TABLE ${tableName} ADD COLUMN ${missingColumn} TEXT`, (alterErr) => {
            if (alterErr) {
              const errMsg = (alterErr as Error).message;
              if (!errMsg.includes("duplicate column name")) {
                console.warn(`Failed to add column ${missingColumn} to ${tableName}:`, errMsg);
              }
            }
            resolve();
          });
        });
        
        return await executeSql();
      }
    }
    
    throw err;
  }
}

/**
 * 获取 SQL 执行计划
 * 
 * 使用 EXPLAIN QUERY PLAN 分析 SQL 查询的执行计划，帮助优化查询性能。
 * 
 * @param {string} sql - SQL 查询语句
 * @returns {Promise<any[]>} 执行计划结果
 */
export async function explain(sql: string): Promise<any[]> {
  const db = myDb.db;

  return new Promise((resolve, reject) => {
    db.all(`EXPLAIN QUERY PLAN ${sql}`, [], (err, rows) => {
      if (err) {
        reject(err);
      } else {
        resolve(rows);
      }
    });
  });
}

/**
 * 执行事务
 * 
 * 在事务中执行多条 SQL 语句，保证原子性。
 * 任意一条语句失败则回滚所有操作。
 * 
 * @param {TransactionOptions} options - 事务选项
 * @returns {Promise<{ success: boolean; results?: any[] }>} 事务执行结果
 */
export async function transaction(options: TransactionOptions): Promise<{ success: boolean; results?: any[] }> {
  const { sqls, params = [] } = options;
  const db = myDb.db;

  return new Promise((resolve, reject) => {
    db.run("BEGIN TRANSACTION;", async (beginErr) => {
      if (beginErr) {
        reject(beginErr);
        return;
      }

      try {
        const results: any[] = [];

        for (let i = 0; i < sqls.length; i++) {
          const sql = sqls[i];
          const sqlParams = params[i] || [];

          const result = await new Promise<{ lastID: number; changes: number; rows?: any[] }>((res, rej) => {
            const isSelect = /^\s*SELECT/i.test(sql);
            
            if (isSelect) {
              db.all(sql, sqlParams, (err, rows) => {
                if (err) rej(err);
                else res({ lastID: 0, changes: 0, rows });
              });
            } else {
              db.run(sql, sqlParams, function (err) {
                if (err) rej(err);
                else res({ lastID: this.lastID, changes: this.changes });
              });
            }
          });

          results.push(result);
        }

        db.run("COMMIT;", (commitErr) => {
          if (commitErr) {
            db.run("ROLLBACK;", () => {});
            reject(commitErr);
          } else {
            resolve({ success: true, results });
          }
        });
      } catch (err) {
        db.run("ROLLBACK;", () => {});
        reject(err);
      }
    });
  });
}

/**
 * 番茄钟状态记录：写入 pomodoro_status 表，并做「同天 + 同状态 + 10 秒内」去重。
 *
 * 为什么去重要在主进程做：主窗口与番茄钟小窗是两个独立渲染进程，都会收到主进程下发的
 * tips-state-change 并各自发起写入；若去重放在渲染端，会因两进程「读都早于彼此写」出现竞态、
 * 各自落一条，导致同一状态进入被记成两条。本函数经主进程唯一 IPC 入口串行执行，
 * 保证每次真实状态进入（启动 / 状态切换）只落一条。
 *
 * @param data 渲染端构造的记录对象（含 label/value/date/dateTime/mode 等）
 * @returns 写入结果；若被判定为碎片返回 { deduped: true }
 */
export async function recordPomodoro(data: Record<string, any>) {
  await ensureTableExists('pomodoro_status');
  const { date, value, dateTime } = data || {};
  // 去重改为「按开始时刻」：记录的 dateTime 现为主进程下发的真实状态进入时刻。
  // 同状态 + 同开始时刻（如启动补偿通道 B 在多处重复下发同一段起点）→ 视为重复，合并为一条；
  // 真正的新状态进入（开始时刻不同）→ 放行落库。相比旧的「|now-last.dateTime|<=10s」，
  // 新的判定能正确区分「同一段被重复下发」与「同一状态再次进入（不同开始时刻）」，不会误合并、也不会漏记。
  if (date && value != null && dateTime != null) {
    const rows: any[] = await query({ tableName: 'pomodoro_status', conditions: { date } });
    if (Array.isArray(rows) && rows.length) {
      const sameStart = rows.find(
        (r: any) => r.value === value && r.dateTime === dateTime
      );
      if (sameStart) {
        return { success: true, deduped: true, data: sameStart };
      }
    }
  }
  const result = await insert({ tableName: 'pomodoro_status', data });
  return { success: true, ...result };
}

/**
 * 确保表存在
 * 
 * 如果表不存在则自动创建，支持指定初始列和自定义主键。
 * 如果表已存在但缺少指定列，会自动添加。
 * 
 * @param {string} tableName - 表名
 * @param {string[]} [columns] - 需要确保存在的列名数组
 * @param {string} [primaryKey='id'] - 主键字段名，默认为 id
 * @returns {Promise<void>}
 */
/**
 * 生成主键列定义。
 * - 主键名为 id 且类型为 INTEGER：使用自增整数（兼容截图/电子书等老表的自增 id）。
 * - 其余情况：使用调用方指定的类型（默认 TEXT）作为主键，支持字符串 id（如 reminders）。
 */
function getPrimaryKeyDef(primaryKey: string, pkType: string): string {
  const upper = (pkType || "INTEGER").toUpperCase();
  if (primaryKey === "id" && upper === "INTEGER") {
    return "id INTEGER PRIMARY KEY AUTOINCREMENT";
  }
  return `${primaryKey} ${upper} PRIMARY KEY`;
}

export async function ensureTableExists(
  tableName: string,
  columns?: string[],
  primaryKey: string = "id",
  config?: { primaryKeyType?: "INTEGER" | "TEXT" }
): Promise<void> {
  const db = myDb.db;
  return new Promise((resolve, reject) => {
    db.get(
      "SELECT name FROM sqlite_master WHERE type='table' AND name = ?",
      [tableName],
      async (err, row) => {
        if (err) {
          reject(err);
          return;
        }

        if (!row) {
          const defaultColumns = (columns?.length ? columns : ['name', 'value', 'created_at']).filter(col => col.toLowerCase() !== primaryKey.toLowerCase());
          const columnDefs = defaultColumns.map(col => `${col} TEXT`).join(', ');

          const pkType = config?.primaryKeyType || (primaryKey === 'id' ? 'INTEGER' : 'TEXT');
          const primaryKeyDef = getPrimaryKeyDef(primaryKey, pkType);
            
          await new Promise<void>((res, rej) => {
            const sql = columnDefs
              ? `CREATE TABLE IF NOT EXISTS ${tableName} (
              ${primaryKeyDef},
              ${columnDefs}
            )`
              : `CREATE TABLE IF NOT EXISTS ${tableName} (
              ${primaryKeyDef}
            )`;
            db.run(sql, (createErr) => {
              if (createErr) rej(createErr);
              else res();
            });
          });
          resolve();
          return;
        }

        const existingColumns = await new Promise<string[]>((resolve, reject) => {
          db.all(`PRAGMA table_info(${tableName})`, [], (err, rows) => {
            if (err) reject(err);
            else resolve((rows as any[]).map(row => row.name));
          });
        });

        // 确保主键列存在（旧表可能缺该列）
        if (!existingColumns.includes(primaryKey)) {
          const pkType = config?.primaryKeyType || (primaryKey === 'id' ? 'INTEGER' : 'TEXT');
          await new Promise<void>((res) => {
            db.run(`ALTER TABLE ${tableName} ADD COLUMN ${primaryKey} ${pkType}`, (alterErr) => {
              if (alterErr) {
                const errMsg = (alterErr as Error).message;
                if (!errMsg.includes("duplicate column name")) {
                  console.warn(`Failed to add column ${primaryKey} to ${tableName}:`, errMsg);
                }
              }
              res();
            });
          });
        }

        // 确保主键列具备唯一索引：upsert 依赖 ON CONFLICT(primaryKey) 触发更新。
        // 旧表常出现「列已存在但无唯一约束」的情况，导致 ON CONFLICT 永不命中、
        // upsert 退化为重复 INSERT（表现为「编辑待办却变成新增一条」）。
        await new Promise<void>((res) => {
          const createIdx = () => {
            db.run(
              `CREATE UNIQUE INDEX IF NOT EXISTS uq_${tableName}_${primaryKey} ON ${tableName}(${primaryKey})`,
              (idxErr) => {
                const msg = (idxErr as Error)?.message || '';
                // 唯一约束冲突说明存在重复主键：清理重复（保留每 key 最新一条）后重试一次
                if (idxErr && /UNIQUE constraint failed|duplicate/i.test(msg)) {
                  db.run(
                    `DELETE FROM ${tableName} WHERE rowid NOT IN (SELECT MAX(rowid) FROM ${tableName} GROUP BY ${primaryKey}) AND ${primaryKey} IS NOT NULL`,
                    (delErr) => {
                      if (delErr) {
                        console.warn(`Failed to dedupe ${tableName}(${primaryKey}):`, (delErr as Error).message);
                        return res();
                      }
                      db.run(
                        `CREATE UNIQUE INDEX IF NOT EXISTS uq_${tableName}_${primaryKey} ON ${tableName}(${primaryKey})`,
                        (e2) => {
                          if (e2) console.warn(`Failed to create unique index on ${tableName}(${primaryKey}):`, (e2 as Error).message);
                          res();
                        },
                      );
                    },
                  );
                } else {
                  if (idxErr) console.warn(`Failed to create unique index on ${tableName}(${primaryKey}):`, msg);
                  res();
                }
              },
            );
          };
          createIdx();
        });

        if (columns && columns.length > 0) {
          await ensureColumns(db, tableName, columns.filter(col => col.toLowerCase() !== primaryKey.toLowerCase()));
        }

        resolve();
      }
    );
  });
}

/**
 * 确保列存在
 * 
 * 检查并添加表中缺少的列。
 * 在并发场景下，重复添加同一列会静默忽略（duplicate column name）。
 * 
 * @param {Database} db - 数据库实例
 * @param {string} tableName - 表名
 * @param {string[]} columns - 需要确保存在的列名数组
 * @returns {Promise<void>}
 */
async function ensureColumns(db: Database, tableName: string, columns: string[]): Promise<void> {
  const existingColumns = await new Promise<string[]>((resolve, reject) => {
    db.all(`PRAGMA table_info(${tableName})`, [], (err, rows) => {
      if (err) reject(err);
      else resolve((rows as any[]).map(row => row.name));
    });
  });

  const missingColumns = columns.filter(col => !existingColumns.includes(col));
  
  if (missingColumns.length > 0) {
    for (const col of missingColumns) {
      await new Promise<void>((resolve) => {
        db.run(`ALTER TABLE ${tableName} ADD COLUMN ${col} TEXT`, (alterErr) => {
          if (alterErr) {
            const errMsg = (alterErr as Error).message;
            if (!errMsg.includes("duplicate column name")) {
              console.warn(`Failed to add column ${col} to ${tableName}:`, errMsg);
            }
          }
          resolve();
        });
      });
    }
  }
}

/**
 * 从 SQL 语句中提取表名
 * 
 * 支持 SELECT/INSERT/UPDATE/DELETE 语句的表名提取。
 * 
 * @param {string} sql - SQL 语句
 * @returns {string | null} 提取的表名，失败返回 null
 */
function extractTableName(sql: string): string | null {
  const match = sql.match(/^\s*(SELECT|INSERT|UPDATE|DELETE)\s+(?:INTO|FROM)?\s*([a-zA-Z_][a-zA-Z0-9_]*)/i);
  return match ? match[2] : null;
}

/**
 * 从 SQL 语句中提取列名
 * 
 * 根据 SQL 语句类型提取涉及的列名：
 * - INSERT: 提取 VALUES 前括号中的列名
 * - UPDATE: 提取 SET 后面的列名
 * - SELECT: 提取 SELECT 后面的列名（非 * 情况）
 * - 默认: 返回 ['name', 'value', 'created_at']
 * 
 * @param {string} sql - SQL 语句
 * @returns {string[]} 提取的列名数组
 */
function extractColumnNames(sql: string): string[] {
  const columns: string[] = [];
  
  const insertMatch = sql.match(/INSERT\s+INTO\s+\w+\s*\(\s*([^)]+)\s*\)/i);
  if (insertMatch) {
    insertMatch[1].split(',').forEach(col => {
      const trimmed = col.trim();
      const nameMatch = trimmed.match(/["'`]?([a-zA-Z_][a-zA-Z0-9_]*)["'`]?/);
      if (nameMatch) {
        columns.push(nameMatch[1]);
      }
    });
    return columns;
  }
  
  const updateMatch = sql.match(/UPDATE\s+\w+\s+SET\s+([^WHERE]+)/i);
  if (updateMatch) {
    updateMatch[1].split(',').forEach(col => {
      const trimmed = col.trim();
      const nameMatch = trimmed.match(/^["'`]?([a-zA-Z_][a-zA-Z0-9_]*)["'`]?/);
      if (nameMatch) {
        columns.push(nameMatch[1]);
      }
    });
    return columns;
  }
  
  const selectMatch = sql.match(/SELECT\s+([^FROM]+)/i);
  if (selectMatch && selectMatch[1].trim() !== '*') {
    selectMatch[1].split(',').forEach(col => {
      const trimmed = col.trim();
      const nameMatch = trimmed.match(/["'`]?([a-zA-Z_][a-zA-Z0-9_]*)["'`]?/);
      if (nameMatch) {
        columns.push(nameMatch[1]);
      }
    });
    return columns;
  }
  
  return ['name', 'value', 'created_at'];
}

/**
 * 确保表列存在（用于 insert/upsert）
 * 
 * 根据数据对象自动检测并添加缺失的列。
 * 如果表不存在则创建表。
 * 
 * @param {Database} db - 数据库实例
 * @param {string} tableName - 表名
 * @param {Record<string, any>[]} data - 数据数组
 * @param {{ primaryKey?: string }} [config] - 配置选项
 * @returns {Promise<void>}
 */
async function ensureTableColumns(
  db: Database,
  tableName: string,
  data: Record<string, any>[],
  config?: { primaryKey?: string; primaryKeyType?: "INTEGER" | "TEXT" }
) {
  return new Promise<void>((resolve, reject) => {
    db.get(`SELECT sql FROM sqlite_master WHERE type='table' AND name='${tableName}'`, async (err, result: any) => {
      if (err) return reject(err);

      const pk = config?.primaryKey || 'id';
      const pkType = config?.primaryKeyType || (pk === 'id' ? 'INTEGER' : 'TEXT');

      if (!result || !result.sql) {
        const primaryKey = getPrimaryKeyDef(pk, pkType);

        await new Promise<void>((res, rej) => {
          db.run(`CREATE TABLE IF NOT EXISTS ${tableName} (${primaryKey});`, [], (createErr) => {
            if (createErr) rej(createErr);
            else res();
          });
        });
      } else {
        const existingColumns = await new Promise<string[]>((resolve, reject) => {
          db.all(`PRAGMA table_info(${tableName})`, [], (err, rows) => {
            if (err) reject(err);
            else resolve((rows as any[]).map(row => row.name));
          });
        });

        if (!existingColumns.includes(pk)) {
          // SQLite 不支持通过 ALTER 给既存表加主键列，故分两步：
          // 1) 先加普通列；2) 再建唯一索引，等价于主键的唯一约束（ON CONFLICT 可用）。
          await new Promise<void>((res) => {
            db.run(`ALTER TABLE ${tableName} ADD COLUMN ${pk} ${pkType}`, (alterErr) => {
              if (alterErr) {
                const errMsg = (alterErr as Error).message;
                if (!errMsg.includes("duplicate column name")) {
                  console.warn(`Failed to add column ${pk} to ${tableName}:`, errMsg);
                }
              }
              res();
            });
          });
          await new Promise<void>((res) => {
            db.run(
              `CREATE UNIQUE INDEX IF NOT EXISTS uq_${tableName}_${pk} ON ${tableName}(${pk})`,
              (idxErr) => {
                if (idxErr) {
                  console.warn(`Failed to create unique index on ${tableName}(${pk}):`, (idxErr as Error).message);
                }
                res();
              }
            );
          });
        }
      }

      const newCreateSQL = result ? result.sql : "";
      const newColumnsPart = newCreateSQL
        .replace(/^CREATE\s+TABLE\s+\w+\s*\(/i, "")
        .replace(/\)[^)]*$/, "")
        .trim();

      const newExistingColumns = newColumnsPart
        .split(/,(?![^(]*\))/)
        .map((col) => col.trim())
        .filter((col) => col && !/^(CONSTRAINT|PRIMARY KEY|FOREIGN KEY|CHECK)/i.test(col))
        .map((col) => {
          const match = col.match(/^["'`]?([\w]+)["'`]?/);
          return match ? match[1] : null;
        })
        .filter(Boolean);

      const newColumns = Object.keys(data[0] || {}).filter(
        (key) => !newExistingColumns.includes(key) && key.toLowerCase() !== pk.toLowerCase()
      );

      if (newColumns.length > 0) {
        const alterPromises = newColumns.map(
          (col) =>
            new Promise<void>((res) => {
              db.run(`ALTER TABLE ${tableName} ADD COLUMN ${col} TEXT`, (alterErr) => {
                if (alterErr) {
                  const errMsg = (alterErr as Error).message;
                  if (!errMsg.includes("duplicate column name")) {
                    console.warn(`Failed to add column ${col} to ${tableName}:`, errMsg);
                  }
                }
                res();
              });
            })
        );
        await Promise.all(alterPromises);
      }

      resolve();
    });
  });
}

/**
 * IPC 处理器：查询数据
 * 
 * 渲染进程调用方式：
 * ```javascript
 * await window.ipcRenderer.handlePromise("new-sql:query", options);
 * ```
 */
ipcMain.handle("new-sql:query", async (event, options: QueryOptions) => {
  try {
    const data = await query(options);
    return { success: true, data };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

/**
 * IPC 处理器：计数查询
 * 
 * 渲染进程调用方式：
 * ```javascript
 * await window.ipcRenderer.handlePromise("new-sql:count", { tableName, condition });
 * ```
 */
ipcMain.handle("new-sql:count", async (event, { tableName, condition }: { tableName: string; condition?: Record<string, any> }) => {
  try {
    const data = await count(tableName, condition);
    return { success: true, data };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

/**
 * IPC 处理器：插入数据
 * 
 * 渲染进程调用方式：
 * ```javascript
 * await window.ipcRenderer.handlePromise("new-sql:insert", options);
 * ```
 */
ipcMain.handle("new-sql:insert", async (event, options: InsertOptions) => {
  try {
    const data = await insert(options);
    return { success: true, data };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

/**
 * IPC 处理器：番茄钟状态记录（带去重）
 *
 * 主窗口与番茄钟小窗是独立渲染进程，各自收到 tips-state-change 后都会请求写入，
 * 去重在主进程串行执行，保证每次真实状态进入只落一条。
 *
 * 渲染进程调用方式：
 * ```javascript
 * await window.ipcRenderer.handlePromise("new-sql:record-pomodoro", data);
 * ```
 */
ipcMain.handle("new-sql:record-pomodoro", async (event, data: Record<string, any>) => {
  try {
    const result = await recordPomodoro(data);
    return { success: true, ...result };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

/**
 * IPC 处理器：插入或更新数据
 * 
 * 渲染进程调用方式：
 * ```javascript
 * await window.ipcRenderer.handlePromise("new-sql:upsert", options);
 * ```
 */
ipcMain.handle("new-sql:upsert", async (event, options: InsertOptions) => {
  try {
    const data = await upsert(options);
    return { success: true, data };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

/**
 * IPC 处理器：更新数据
 * 
 * 渲染进程调用方式：
 * ```javascript
 * await window.ipcRenderer.handlePromise("new-sql:update", options);
 * ```
 */
ipcMain.handle("new-sql:update", async (event, options: UpdateOptions) => {
  try {
    const data = await update(options);
    return { success: true, data };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

/**
 * IPC 处理器：删除数据
 * 
 * 渲染进程调用方式：
 * ```javascript
 * await window.ipcRenderer.handlePromise("new-sql:delete", options);
 * ```
 */
ipcMain.handle("new-sql:delete", async (event, options: DeleteOptions) => {
  try {
    const data = await del(options);
    return { success: true, data };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

/**
 * IPC 处理器：执行 SQL 语句
 * 
 * 渲染进程调用方式：
 * ```javascript
 * await window.ipcRenderer.handlePromise("new-sql:execute", { sql, params, primaryKey });
 * ```
 */
ipcMain.handle("new-sql:execute", async (event, { sql, params, primaryKey }: { sql: string; params?: any[]; primaryKey?: string }) => {
  try {
    const data = await execute(sql, params || [], primaryKey);
    return { success: true, data };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

/**
 * IPC 处理器：获取执行计划
 * 
 * 渲染进程调用方式：
 * ```javascript
 * await window.ipcRenderer.handlePromise("new-sql:explain", { sql });
 * ```
 */
ipcMain.handle("new-sql:explain", async (event, { sql }: { sql: string }) => {
  try {
    const data = await explain(sql);
    return { success: true, data };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

/**
 * IPC 处理器：执行事务
 * 
 * 渲染进程调用方式：
 * ```javascript
 * await window.ipcRenderer.handlePromise("new-sql:transaction", options);
 * ```
 */
ipcMain.handle("new-sql:transaction", async (event, options: TransactionOptions) => {
  try {
    const data = await transaction(options);
    return { success: true, data };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

/**
 * IPC 处理器：获取表列表
 * 
 * 获取数据库中所有用户表（排除系统表）。
 * 
 * 渲染进程调用方式：
 * ```javascript
 * await window.ipcRenderer.handlePromise("new-sql:listTables", {});
 * ```
 */
ipcMain.handle("new-sql:listTables", async () => {
  const db = myDb.db;
  return new Promise((resolve) => {
    db.all(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      [],
      (err, rows) => {
        if (err) {
          resolve({ success: false, error: err.message });
        } else {
          resolve({ success: true, data: rows.map((row: any) => row.name) });
        }
      }
    );
  });
});

/**
 * IPC 处理器：获取表结构信息
 * 
 * 使用 PRAGMA table_info 获取表的字段信息。
 * 
 * 渲染进程调用方式：
 * ```javascript
 * await window.ipcRenderer.handlePromise("new-sql:tableInfo", { tableName });
 * ```
 */
ipcMain.handle("new-sql:tableInfo", async (event, { tableName }: { tableName: string }) => {
  const db = myDb.db;
  return new Promise((resolve) => {
    db.all(`PRAGMA table_info(${tableName})`, [], (err, rows) => {
      if (err) {
        resolve({ success: false, error: err.message });
      } else {
        resolve({ success: true, data: rows });
      }
    });
  });
});
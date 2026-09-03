/**
 * 股票缓存 TTL 覆盖配置的持久化（基础表 basic_info）。
 *
 * 与 stock.ts 中 API Key 的存取共用同一张 basic_info 表，
 * 但此处仅负责缓存 TTL 覆盖（key = stock_cache_ttl），
 * 独立成模块以避免在主进程循环依赖（stock.ts 已 import stockCache.ts）。
 */

import { myDb } from './newSql.ts'
import { queryByConditions, upsertData } from '../utils/sql.ts'
import { tableName as basicInfoTable } from './store.ts'
import { CACHE_TTL_DB_KEY } from './stockCache.ts'

/** 从基础表读取 TTL 覆盖配置（已 JSON.parse），不存在返回 null */
export function queryBasicInfoTtl(): Promise<Record<string, number> | null> {
  return new Promise((resolve) => {
    queryByConditions({
      db: myDb.db,
      tableName: basicInfoTable,
      conditions: { key: CACHE_TTL_DB_KEY },
      callback: (err, rows) => {
        if (err || !rows || rows.length === 0) {
          resolve(null)
          return
        }
        try {
          const raw = JSON.parse(rows[0].value)
          resolve(raw && typeof raw === 'object' ? raw : null)
        } catch {
          resolve(null)
        }
      },
    })
  })
}

/** 写入 TTL 覆盖配置（value 以 JSON 字符串存储，与基础表约定一致） */
export function upsertBasicInfoTtl(map: Record<string, number>): Promise<void> {
  return new Promise((resolve, reject) => {
    upsertData({
      db: myDb.db,
      tableName: basicInfoTable,
      data: { key: CACHE_TTL_DB_KEY, value: JSON.stringify(map) },
      config: { primaryKey: 'key' },
      callback: (err) => (err ? reject(err) : resolve()),
    })
  })
}

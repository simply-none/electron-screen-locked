/**
 * 股票接口数据缓存层（SQLite）
 *
 * 设计要点：
 * - 单张统一缓存表 `stock_cache`，用确定性缓存键覆盖全部 8 个 TickFlow 接口。
 * - 表字段：cache_key(主键) / endpoint(接口说明) / url(接口地址) /
 *          data(响应 JSON 文本) / created_at / expires_at(均为毫秒时间戳)。
 * - 命中且未过期直接返回，避免重复请求浪费调用次数；过期或缺失才回源并写回。
 * - TTL 全部抽为常量，便于调整。实时类短缓存、历史类长缓存。
 *
 * 本模块被 stock.ts 的带缓存 IPC 处理器调用，渲染端无感。
 */

import { myDb } from './newSql.ts'
import { queryByConditions, upsertData, createTable } from '../utils/sql.ts'

/** 缓存表名 */
export const STOCK_CACHE_TABLE = 'stock_cache'

/** 缓存 TTL 覆盖配置在基础表的存储键 */
export const CACHE_TTL_DB_KEY = 'stock_cache_ttl'

/** TickFlow 服务根地址（与 stock.ts 保持一致） */
const TICKFLOW_BASE_URL = 'https://api.tickflow.org'

/** TTL 常量（毫秒） */
export const TTL = {
  /** 实时行情 / 市场深度（含批量） */
  realtime: 5_000,
  /** 当日分钟 K 线（含批量） */
  intraday: 30_000,
  /** 历史 K 线（含批量，历史数据不变，可长缓存） */
  kline: 3_600_000,
  /** 标的元数据（名称/交易所/类型等极少变动，一天获取一次） */
  daily: 86_400_000,
  /** 交易所列表 / 标的池（行业分类）等缓慢变动数据，缓存一周 */
  weekly: 7 * 86_400_000,
}

/** 单个接口的缓存元数据 */
export interface CacheMeta {
  /** 接口说明，如 "GET /v1/quotes" */
  endpoint: string
  /** 接口完整地址，如 "https://api.tickflow.org/v1/quotes" */
  url: string
  /** 过期时长（毫秒） */
  ttl: number
  /** 由请求参数构造确定性缓存键（符号统一排序去重） */
  buildKey: (params: any) => string
}

/**
 * 符号归一化：逗号串或数组 → 去空、转大写、排序，保证
 * "600000.SH,000001.SZ" 与 "000001.SZ,600000.SH" 视为同一键。
 */
function normSymbols(input?: string | string[]): string {
  if (!input) return ''
  const arr = (Array.isArray(input) ? input : String(input).split(','))
    .map((s) => String(s).trim().toUpperCase())
    .filter(Boolean)
  return arr.sort().join(',')
}

/**
 * 运行时 TTL 覆盖表（按 IPC 通道名 → 毫秒）。
 * 用户可在设置中调整；仅影响「之后新写入」的缓存条目，
 * 已存在的条目 expires_at 保持不变（不会因改设置而回源重拉）。
 */
let ttlOverrides: Record<string, number> = {}

/** 读取某通道当前生效的 TTL（覆盖值优先，否则用元数据默认值） */
export function getEffectiveTtl(channel: string): number {
  const meta = CACHE_META[channel]
  if (!meta) return 0
  const override = ttlOverrides[channel]
  return typeof override === 'number' && override > 0 ? override : meta.ttl
}

/** 从基础表加载 TTL 覆盖配置到内存（启动或显式调用） */
export async function loadTtlOverrides(): Promise<void> {
  try {
    const { queryBasicInfoTtl } = await import('./stockTtlStore.ts')
    const map = await queryBasicInfoTtl()
    if (map && typeof map === 'object') {
      ttlOverrides = map
    }
  } catch {
    // 加载失败保持内存默认（空覆盖），不影响既有缓存逻辑
  }
}

/** 持久化 TTL 覆盖配置到基础表并同步内存 */
export async function saveTtlOverrides(map: Record<string, number>): Promise<void> {
  // 仅保留声明在 CACHE_META 中的合法通道，且为正数
  const next: Record<string, number> = {}
  for (const [channel, ms] of Object.entries(map || {})) {
    if (CACHE_META[channel] && typeof ms === 'number' && ms > 0) {
      next[channel] = ms
    }
  }
  ttlOverrides = next
  try {
    const { upsertBasicInfoTtl } = await import('./stockTtlStore.ts')
    await upsertBasicInfoTtl(next)
  } catch {
    // 持久化失败：内存已更新，下次启动会回退到库值；此处不抛错
  }
}

/** 返回全部通道的 { 默认 TTL, 当前覆盖 TTL }，供渲染端设置面板渲染 */
export function getCacheTtlConfig(): {
  defaults: Record<string, number>
  overrides: Record<string, number>
} {
  const defaults: Record<string, number> = {}
  const overrides: Record<string, number> = {}
  for (const channel of Object.keys(CACHE_META)) {
    defaults[channel] = CACHE_META[channel].ttl
    if (typeof ttlOverrides[channel] === 'number') {
      overrides[channel] = ttlOverrides[channel]
    }
  }
  return { defaults, overrides }
}

/** 8 个接口的缓存元数据表（键为 IPC 通道名） */
export const CACHE_META: Record<string, CacheMeta> = {
  'stock:getQuotes': {
    endpoint: 'GET /v1/quotes',
    url: `${TICKFLOW_BASE_URL}/v1/quotes`,
    ttl: TTL.realtime,
    buildKey: (p) => `quotes::${normSymbols(p?.symbols)}`,
  },
  'stock:getQuotesBatch': {
    endpoint: 'POST /v1/quotes',
    url: `${TICKFLOW_BASE_URL}/v1/quotes`,
    ttl: TTL.realtime,
    buildKey: (p) => `quotes_batch::${normSymbols(p?.symbols)}::${normSymbols(p?.universes)}`,
  },
  'stock:getDepth': {
    endpoint: 'GET /v1/depth',
    url: `${TICKFLOW_BASE_URL}/v1/depth`,
    ttl: TTL.realtime,
    buildKey: (p) => `depth::${String(p?.symbol || '').toUpperCase()}`,
  },
  'stock:getDepthBatch': {
    endpoint: 'GET /v1/depth/batch',
    url: `${TICKFLOW_BASE_URL}/v1/depth/batch`,
    ttl: TTL.realtime,
    buildKey: (p) => `depth_batch::${normSymbols(p?.symbols)}`,
  },
  'stock:getKlines': {
    endpoint: 'GET /v1/klines',
    url: `${TICKFLOW_BASE_URL}/v1/klines`,
    ttl: TTL.kline,
    buildKey: (p) =>
      `klines::${String(p?.symbol || '').toUpperCase()}::${p?.period || '1d'}::${p?.count ?? 100}::${p?.start_time ?? 0}::${p?.end_time ?? 0}::${p?.adjust || 'none'}`,
  },
  'stock:getKlinesBatch': {
    endpoint: 'GET /v1/klines/batch',
    url: `${TICKFLOW_BASE_URL}/v1/klines/batch`,
    ttl: TTL.kline,
    buildKey: (p) =>
      `klines_batch::${normSymbols(p?.symbols)}::${p?.period || '1d'}::${p?.count ?? 100}::${p?.start_time ?? 0}::${p?.end_time ?? 0}::${p?.adjust || 'none'}`,
  },
  'stock:getIntraday': {
    endpoint: 'GET /v1/klines/intraday',
    url: `${TICKFLOW_BASE_URL}/v1/klines/intraday`,
    ttl: TTL.intraday,
    buildKey: (p) =>
      `intraday::${String(p?.symbol || '').toUpperCase()}::${p?.period || '1m'}::${p?.count ?? 0}`,
  },
  'stock:getIntradayBatch': {
    endpoint: 'GET /v1/klines/intraday/batch',
    url: `${TICKFLOW_BASE_URL}/v1/klines/intraday/batch`,
    ttl: TTL.intraday,
    buildKey: (p) =>
      `intraday_batch::${normSymbols(p?.symbols)}::${p?.period || '1m'}::${p?.count ?? 0}`,
  },
  'stock:getInstruments': {
    endpoint: 'GET /v1/instruments',
    url: `${TICKFLOW_BASE_URL}/v1/instruments`,
    ttl: TTL.daily,
    buildKey: (p) => `instruments_single::${normSymbols(p?.symbols)}`,
  },
  'stock:getInstrumentsBatch': {
    endpoint: 'POST /v1/instruments',
    url: `${TICKFLOW_BASE_URL}/v1/instruments`,
    ttl: 86_400_000,
    buildKey: (p) => `instruments_batch::${normSymbols(p?.symbols)}`,
  },
  'stock:getExchanges': {
    endpoint: 'GET /v1/exchanges',
    url: `${TICKFLOW_BASE_URL}/v1/exchanges`,
    ttl: TTL.weekly,
    buildKey: () => 'exchange_list',
  },
  'stock:getExchangeInstruments': {
    endpoint: 'GET /v1/exchanges/{exchange}/instruments',
    url: `${TICKFLOW_BASE_URL}/v1/exchanges`,
    ttl: TTL.weekly,
    buildKey: (p) => `exchange_instruments::${String(p?.exchange || '').toUpperCase()}`,
  },
  'stock:getUniverses': {
    endpoint: 'GET /v1/universes',
    url: `${TICKFLOW_BASE_URL}/v1/universes`,
    ttl: TTL.weekly,
    buildKey: () => 'universe_list',
  },
  'stock:getUniverseDetail': {
    endpoint: 'GET /v1/universes/{id}',
    url: `${TICKFLOW_BASE_URL}/v1/universes`,
    ttl: TTL.weekly,
    buildKey: (p) => `universe_detail::${String(p?.id || '').toUpperCase()}`,
  },
}

/** 缓存读取结果 */
export interface CacheEntry {
  data: any
  expires_at: number
}

/** 确保缓存表存在（首次自动建表；其余列由 upsertData 动态添加为 TEXT） */
export function ensureStockCacheTable(): Promise<void> {
  return new Promise((resolve) => {
    createTable({
      db: myDb.db,
      tableName: STOCK_CACHE_TABLE,
      config: { primaryKey: 'cache_key' },
      callback: () => resolve(),
    })
  })
}

/** 按缓存键读取；命中且未过期返回条目，否则返回 null */
export function getFromCache(key: string): Promise<CacheEntry | null> {
  return new Promise((resolve) => {
    queryByConditions({
      db: myDb.db,
      tableName: STOCK_CACHE_TABLE,
      conditions: { cache_key: key },
      callback: (err, rows) => {
        if (err || !rows || rows.length === 0) return resolve(null)
        const row = rows[0] as Record<string, any>
        try {
          resolve({ data: JSON.parse(row.data), expires_at: Number(row.expires_at) })
        } catch {
          resolve(null)
        }
      },
    })
  })
}

/** 写入/更新缓存（按 cache_key upsert）。TTL 取运行时生效值（覆盖优先），
 *  因此改设置只影响本次及之后写入的条目，旧条目过期时间不变。 */
export function setToCache(key: string, channel: string, data: unknown): Promise<void> {
  const meta = CACHE_META[channel]
  const now = Date.now()
  const ttl = getEffectiveTtl(channel)
  return new Promise((resolve, reject) => {
    upsertData({
      db: myDb.db,
      tableName: STOCK_CACHE_TABLE,
      data: {
        cache_key: key,
        endpoint: meta?.endpoint ?? '',
        url: meta?.url ?? '',
        data: JSON.stringify(data),
        created_at: now,
        expires_at: now + ttl,
      },
      config: { primaryKey: 'cache_key' },
      callback: (err) => (err ? reject(err) : resolve()),
    })
  })
}

/** 清空缓存表（一键失效，重新回源拉全量） */
export function clearStockCache(): Promise<void> {
  return new Promise((resolve, reject) => {
    const db = myDb.db as any
    db.run(`DELETE FROM ${STOCK_CACHE_TABLE}`, (err: any) =>
      err ? reject(err) : resolve(),
    )
  })
}

/**
 * 从缓存表中提炼「常用股票」：
 * - 仅识别含个股代码的缓存键（行情 / 深度 / K线 / 当日分钟K线 / 标的元数据），
 *   跳过交易所列表、标的池等非个股条目；
 * - 同一股票按「最近一次写入」的时间排序，返回最近最多 limit 个（默认 30）。
 * 解析依据 cache_key 的命名空间（第一段），避免误吞交易所/标的池键。
 */
const SYMBOL_NAMESPACES = new Set([
  'quotes',
  'quotes_batch',
  'depth',
  'depth_batch',
  'klines',
  'klines_batch',
  'intraday',
  'intraday_batch',
  'instruments_single',
  'instruments_batch',
])

export function getRecentSymbols(limit = 30): Promise<string[]> {
  return new Promise((resolve) => {
    const db = myDb.db as any
    // 取出全部行，在 JS 端按数值时间戳排序（created_at 在 SQLite 中按 TEXT 存储，避免字典序陷阱）
    db.all(
      `SELECT cache_key, created_at FROM ${STOCK_CACHE_TABLE}`,
      (err: any, rows: Array<{ cache_key: string; created_at: number | string }>) => {
        if (err || !Array.isArray(rows)) return resolve([])

        // 缓存键格式：<通道名>::<命名空间>::<符号串[,符号串]>[::...]
        // 例：stock:getQuotes::quotes::600000.SH,000001.SZ
        // 第一段是 IPC 通道名（如 stock:getQuotes），第二段才是命名空间。
        const latest = new Map<string, number>()
        for (const row of rows) {
          const key = row.cache_key || ''
          const parts = key.split('::')
          const ns = parts[1] // 第二段：命名空间
          if (!SYMBOL_NAMESPACES.has(ns)) continue
          const seg = parts[2] || ''
          const ts = Number(row.created_at) || 0
          for (const raw of seg.split(',')) {
            const sym = raw.trim().toUpperCase()
            if (!sym)  continue
            const prev = latest.get(sym)
            if (prev === undefined || ts > prev) latest.set(sym, ts)
          }
        }

        // 按「最近一次查询时间」降序；不足 limit 时返回全部命中的标的（只要有查询就录入）
        const sorted = [...latest.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, limit)
          .map(([sym]) => sym)
        resolve(sorted)
      },
    )
  })
}

/* ===================== 交易所 / 个股 持久化表 =====================
 * 与 stock_cache 不同：stock_cache 是按「接口+参数」缓存的原始响应（会过期）；
 * 这两张表是按「实体」长期落库的真实数据，每次请求相关接口都会 upsert，
 * 便于后续直接检索交易所主数据与个股主数据，不依赖缓存有效期。
 *
 * - stock_exchanges：交易所主表，主键 exchange。
 * - stock_instruments：个股主表，主键 symbol；ext 存为 JSON 文本。
 */

export const STOCK_EXCHANGE_TABLE = 'stock_exchanges'
export const STOCK_INSTRUMENT_TABLE = 'stock_instruments'

/** 确保两张实体表存在 */
export function ensureStockMetaTables(): Promise<void> {
  return new Promise((resolve) => {
    createTable({
      db: myDb.db,
      tableName: STOCK_EXCHANGE_TABLE,
      config: { primaryKey: 'exchange' },
      callback: () => {
        createTable({
          db: myDb.db,
          tableName: STOCK_INSTRUMENT_TABLE,
          config: { primaryKey: 'symbol' },
          callback: () => resolve(),
        })
      },
    })
  })
}

/** 落库交易所列表：数组每一项 = 一条记录，按 exchange 幂等 upsert */
export function saveExchanges(rows: Array<{ exchange: string; region?: string; count?: number }>): Promise<void> {
  const now = Date.now()
  const items = (rows || []).map((r) => ({
    exchange: String(r.exchange),
    region: String(r.region ?? ''),
    count: Number(r.count ?? 0),
    updated_at: now,
  }))
  if (!items.length) return Promise.resolve()
  return new Promise((resolve, reject) => {
    upsertData({
      db: myDb.db,
      tableName: STOCK_EXCHANGE_TABLE,
      data: items,
      config: { primaryKey: 'exchange' },
      callback: (err) => (err ? reject(err) : resolve()),
    })
  })
}

/**
 * 落库个股列表：数组每一项 = 一条记录，按 symbol 幂等 upsert。
 * exchangeCtx 为调用上下文（来自接口路径的交易所），用于补全 instrument 缺失的 exchange 字段。
 * ext 对象以 JSON 文本存储（动态列类型为 TEXT，JSON 字符串可正确序列化）。
 */
export function saveInstruments(
  rows: Array<{
    symbol: string
    exchange?: string
    region?: string
    name?: string
    type?: string
    ext?: unknown
  }>,
  exchangeCtx?: string,
): Promise<void> {
  const now = Date.now()
  console.log('saveInstruments', rows.length)
  const items = (rows || []).map((r) => ({
    symbol: String(r.symbol),
    exchange: String(r.exchange || exchangeCtx || ''),
    region: String(r.region ?? ''),
    name: String(r.name ?? ''),
    type: String(r.type ?? ''),
    ext: JSON.stringify(r.ext ?? null),
    updated_at: now,
  }))
  if (!items.length) return Promise.resolve()
  return new Promise((resolve, reject) => {
    upsertData({
      db: myDb.db,
      tableName: STOCK_INSTRUMENT_TABLE,
      data: items,
      config: { primaryKey: 'symbol' },
      callback: (err) => (err ? reject(err) : resolve()),
    })
  })
}

/** 从交易所主表读取全部交易所（按 updated_at 倒序） */
export function getAllExchangesDb(): Promise<Array<{ exchange: string; region: string; count: number; updated_at: number }>> {
  return new Promise((resolve) => {
    const db = myDb.db as any
    db.all(`SELECT exchange, region, count, updated_at FROM ${STOCK_EXCHANGE_TABLE} ORDER BY updated_at DESC`, (err: any, rows: any[]) => {
      if (err || !Array.isArray(rows)) return resolve([])
      resolve(rows)
    })
  })
}

/**
 * 从个股主表读取个股：可按交易所过滤（可选），按 updated_at 倒序。
 * 返回时把 ext 文本还原为对象（失败则保留原始字符串）。
 */
export function getInstrumentsDb(exchange?: string): Promise<
  Array<{ symbol: string; exchange: string; region: string; name: string; type: string; ext: unknown; updated_at: number }>
> {
  return new Promise((resolve) => {
    const db = myDb.db as any
    const sql = exchange
      ? `SELECT symbol, exchange, region, name, type, ext, updated_at FROM ${STOCK_INSTRUMENT_TABLE} WHERE exchange = ? ORDER BY updated_at DESC`
      : `SELECT symbol, exchange, region,  name, type, ext, updated_at FROM ${STOCK_INSTRUMENT_TABLE} ORDER BY updated_at DESC`
    const params = exchange ? [exchange] : []
    db.all(sql, params, (err: any, rows: any[]) => {
      if (err || !Array.isArray(rows)) return resolve([])
      resolve(
        rows.map((r) => {
          let ext: unknown = r.ext
          if (typeof r.ext === 'string' && r.ext) {
            try {
              ext = JSON.parse(r.ext)
            } catch {
              /* 保留原始文本 */
            }
          }
          return { ...r, ext }
        }),
      )
    })
  })
}

/**
 * 在本地个股主表中按关键词模糊匹配（代码 / 名称 / 简写）。
 * keyword 为空时返回空数组；匹配 symbol、name 两个字段（大小写不敏感）。
 * 返回去重后的候选列表（最多 limit 条，默认 50）。
 */
export function searchInstrumentsDb(
  keyword: string,
  limit = 50,
): Promise<Array<{ symbol: string; exchange: string; region: string; name: string; type: string }>> {
  return new Promise((resolve) => {
    const kw = (keyword || '').trim()
    if (!kw) return resolve([])
    const db = myDb.db as any
    const like = `%${kw}%`
    const sql = `SELECT symbol, exchange, region, name, type FROM ${STOCK_INSTRUMENT_TABLE} WHERE symbol LIKE ? OR name LIKE ? ORDER BY updated_at DESC LIMIT ?`
    db.all(sql, [like, like, limit], (err: any, rows: any[]) => {
      if (err || !Array.isArray(rows)) return resolve([])
      const seen = new Set<string>()
      const out: Array<{ symbol: string; exchange: string; region: string;  name: string; type: string }> = []
      for (const r of rows) {
        if (seen.has(r.symbol)) continue
        seen.add(r.symbol)
        out.push({ symbol: r.symbol, exchange: r.exchange, region: r.region, name: r.name, type: r.type })
      }
      resolve(out)
    })
  })
}

/* ===================== 自选股表 =====================
 * 与「常用」（从缓存提炼）不同，自选股是用户主动维护的标的集合，
 * 长期落库、可增删。主键 symbol；name/exchange/region/type 冗余存一份，
 * 便于离线直接展示；created_at 用于排序（新加入的排在前面）。
 *
 * 注意：不使用通用 upsertData（它会把 created_at 也覆盖成新值），
 * 这里用专属 SQL，冲突时只更新元数据字段、保留 created_at。
 */

export const STOCK_WATCHLIST_TABLE = 'stock_watchlist'

/** 自选股单条（对外返回结构） */
export interface WatchlistItem {
  symbol: string
  name: string
  exchange: string
  region: string
  type: string
  created_at: number
}

/** 加入自选股时传入的单条（symbol 必填，其余可选，前端尽量带全） */
export interface WatchlistInput {
  symbol: string
  name?: string
  exchange?: string
  region?: string
  type?: string
}

/** 确保表存在（首次自动建表，仅 symbol 主键一列；其余列在写入时按需 ALTER 补齐） */
export function ensureStockWatchlistTable(): Promise<void> {
  return new Promise((resolve) => {
    createTable({
      db: myDb.db,
      tableName: STOCK_WATCHLIST_TABLE,
      config: { primaryKey: 'symbol' },
      callback: () => resolve(),
    })
  })
}

/** 写入前确保 name/exchange/region/type/created_at 列存在（表由 createTable 仅建主键列） */
function ensureWatchlistColumns(): Promise<void> {
  return new Promise((resolve) => {
    const db = myDb.db as any
    db.get(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name='${STOCK_WATCHLIST_TABLE}'`,
      (err: any, row: any) => {
        if (err || !row?.sql) return resolve()
        const sql = String(row.sql)
        const needed = ['name', 'exchange', 'region', 'type', 'created_at']
        const existing = needed.filter((c) => new RegExp(`\\b${c}\\b`, 'i').test(sql))
        const missing = needed.filter((c) => !existing.includes(c))
        if (!missing.length) return resolve()
        let i = 0
        const next = () => {
          if (i >= missing.length) return resolve()
          const col = missing[i++]
          db.run(`ALTER TABLE ${STOCK_WATCHLIST_TABLE} ADD COLUMN ${col} TEXT`, (e: any) => {
            if (e) console.warn('补齐自选股列失败:', e)
            next()
          })
        }
        next()
      },
    )
  })
}

/** 加入 / 更新自选股（可批量）。symbol 统一转大写。返回最新全量列表。 */
export function addToWatchlist(rows: WatchlistInput[]): Promise<WatchlistItem[]> {
  const items = (rows || [])
    .filter((r) => r && r.symbol)
    .map((r) => ({
      symbol: String(r.symbol).toUpperCase(),
      name: String(r.name ?? ''),
      exchange: String(r.exchange ?? ''),
      region: String(r.region ?? ''),
      type: String(r.type ?? ''),
      created_at: Date.now(),
    }))
  if (!items.length) return Promise.resolve([])
  return new Promise((resolve, reject) => {
    const db = myDb.db as any
    ensureWatchlistColumns()
      .then(() => {
        const sql = `INSERT INTO ${STOCK_WATCHLIST_TABLE} (symbol, name, exchange, region, type, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(symbol) DO UPDATE SET
            name=excluded.name, exchange=excluded.exchange, region=excluded.region, type=excluded.type`
        const stmt = db.prepare(sql)
        let errored: Error | null = null
        let pending = items.length
        for (const it of items) {
          stmt.run(
            [it.symbol, it.name, it.exchange, it.region, it.type, it.created_at],
            (err: any) => {
              if (err) errored = err
              pending--
              if (pending === 0) {
                stmt.finalize()
                if (errored) reject(errored)
                else getWatchlist().then(resolve).catch(reject)
              }
            },
          )
        }
      })
      .catch(reject)
  })
}

/** 移出自选股（可批量，按 symbol 大写匹配）。返回最新全量列表。 */
export function removeFromWatchlist(symbols: string[]): Promise<WatchlistItem[]> {
  const syms = (symbols || [])
    .map((s) => String(s).toUpperCase())
    .filter(Boolean)
  if (!syms.length) return getWatchlist()
  return new Promise((resolve, reject) => {
    const db = myDb.db as any
    const placeholders = syms.map(() => '?').join(',')
    db.run(
      `DELETE FROM ${STOCK_WATCHLIST_TABLE} WHERE symbol IN (${placeholders})`,
      syms,
      (err: any) => {
        if (err) return reject(err)
        getWatchlist().then(resolve).catch(reject)
      },
    )
  })
}

/** 读取自选股全量（按 created_at 倒序：新加入的排前面） */
export function getWatchlist(): Promise<WatchlistItem[]> {
  return new Promise((resolve) => {
    const db = myDb.db as any
    db.all(
      `SELECT symbol, name, exchange, region, type, created_at FROM ${STOCK_WATCHLIST_TABLE} ORDER BY created_at DESC`,
      (err: any, rows: any[]) => {
        if (err || !Array.isArray(rows)) return resolve([])
        resolve(
          rows.map((r) => ({
            symbol: r.symbol,
            name: r.name || '',
            exchange: r.exchange || '',
            region: r.region || '',
            type: r.type || '',
            created_at: Number(r.created_at) || 0,
          })),
        )
      },
    )
  })
}


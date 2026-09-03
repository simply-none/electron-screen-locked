/**
 * 股票查询模块（TickFlow）
 *
 * 合并自原 src/stock/{types,client,index}.ts，统一放在主进程模块下。
 *
 * - 通过 8 个 IPC 通道暴露图中接口，实际网络请求在主进程完成（绕开 CORS、保护 API Key）。
 * - API Key 经 vault/crypto.ts（AES-256-GCM + PBKDF2）以「设备绑定主密钥」加密后，
 *   信封存于基础表 basic_info（key = stockVault），明文仅驻留主进程内存，读取后缓存到内存。
 * - 与 2FA / 应用锁 / 密保共用同一套密钥安全架构（详见 ./vault/crypto.ts）。
 * - 网络请求使用 Node 22 自带的全局 fetch，零额外依赖。
 *
 * 文档参考：https://docs.tickflow.org/zh-Hans/api-reference
 */

import { ipcMain } from 'electron'
import { queryByConditions, upsertData } from '../utils/sql.ts'
import { myDb } from './newSql.ts'
import {
  ensureStockCacheTable,
  getFromCache,
  setToCache,
  clearStockCache,
  getRecentSymbols,
  CACHE_META,
  getCacheTtlConfig,
  loadTtlOverrides,
  saveTtlOverrides,
  ensureStockMetaTables,
  saveExchanges,
  saveInstruments,
  getAllExchangesDb,
  getInstrumentsDb,
  searchInstrumentsDb,
  ensureStockWatchlistTable,
  addToWatchlist,
  removeFromWatchlist,
  getWatchlist,
} from './stockCache.ts'
import { tableName as basicInfoTable } from './store.ts'
import { del } from './newSql.ts'
import { encryptVault, decryptVault, type VaultEnvelope } from './vault/crypto.ts'
import { getDeviceMasterKey } from './vault/deviceKey.ts'

/* ===================== 类型定义 ===================== */

/** K 线周期 */
export type Period =
  | '1m' | '5m' | '10m' | '15m' | '30m' | '60m'
  | '1d' | '1w' | '1M' | '1Q' | '1Y'

/** 复权方式 */
export type AdjustType =
  | 'forward'            // 前复权
  | 'backward'           // 后复权
  | 'forward_additive'   // 前复权（加减方式）
  | 'backward_additive'  // 后复权（加减方式）
  | 'none'               // 不复权

/** 地区（文档中 region 字段，如 cn / us / hk 等） */
export type Region = string

/** 实时行情单条记录 */
export interface Quote {
  symbol: string
  region?: Region
  last_price?: number
  prev_close?: number
  open?: number
  high?: number
  low?: number
  volume?: number
  amount?: number
  timestamp?: number
  /** 地区扩展字段（美股/港股等可能有额外字段） */
  ext?: Record<string, unknown>
  /** 交易时段标识 */
  session?: string
}

/** 五档行情（买一~买五 降序，卖一~卖五 升序） */
export interface MarketDepth {
  symbol?: string
  region?: Region
  timestamp?: number
  bid_prices?: number[]
  bid_volumes?: number[]
  ask_prices?: number[]
  ask_volumes?: number[]
}

/**
 * K 线（列式存储）：同一字段按时间顺序放在数组里，
 * 第 i 个下标对应同一根 K 线的各字段。
 */
export interface CompactKlineData {
  symbol?: string
  timestamp?: number[]
  open?: number[]
  high?: number[]
  low?: number[]
  close?: number[]
  volume?: number[]
  amount?: number[]
}

/** 统一的接口返回包裹结构（文档中响应包在 data 字段） */
export interface ApiEnvelope<T> {
  data: T
}

/* ===================== 请求参数 ===================== */

/** 查询实时行情（GET /v1/quotes） */
export interface QuotesParams {
  /** 逗号分隔的标的，如 "600000.SH,000001.SZ" */
  symbols?: string
  /** 逗号分隔的标的池，如 "CN_Equity_A,CN_ETF" */
  universes?: string
}

/** 查询市场深度（GET /v1/depth，单标的） */
export interface DepthParams {
  symbol: string
}

/** 批量查询市场深度（GET /v1/depth/batch） */
export interface DepthBatchParams {
  symbols: string
}

/** 批量查询实时行情（POST /v1/quotes） */
export interface QuotesBatchBody {
  symbols?: string[]
  universes?: string[]
}

/** 查询 K 线数据（GET /v1/klines，单标的） */
export interface KlinesParams {
  symbol: string
  period?: Period
  /** 根数，默认 100，最大 10000 */
  count?: number
  /** 起始时间（毫秒时间戳） */
  start_time?: number
  /** 结束时间（毫秒时间戳） */
  end_time?: number
  adjust?: AdjustType
}

/** 批量查询 K 线数据（GET /v1/klines/batch） */
export interface KlinesBatchParams {
  symbols: string
  period?: Period
  count?: number
  start_time?: number
  end_time?: number
  adjust?: AdjustType
}

/** 查询当日分钟 K 线（GET /v1/klines/intraday，单标的） */
export interface IntradayParams {
  symbol: string
  period?: Period
  /** 根数，最小 0 */
  count?: number
}

/** 批量查询当日分钟 K 线（GET /v1/klines/intraday/batch） */
export interface IntradayBatchParams {
  symbols: string
  period?: Period
  count?: number
}

/** 查询标的元数据（GET /v1/instruments，逗号分隔字符串） */
export interface InstrumentsParams {
  /** 逗号分隔的标的，如 "600000.SH,000001.SZ,AAPL.US" */
  symbols: string
}

/** 批量查询标的元数据（POST /v1/instruments，符号数组，最多 1000 个） */
export interface InstrumentsBatchBody {
  symbols: string[]
}

/* ===================== 响应类型（已提取 data） ===================== */

export type QuotesResponse = Quote[]
export type DepthResponse = MarketDepth
export type DepthBatchResponse = Record<string, MarketDepth>
export type KlinesResponse = CompactKlineData
export type KlinesBatchResponse = Record<string, CompactKlineData>
export type IntradayResponse = CompactKlineData
export type IntradayBatchResponse = Record<string, CompactKlineData>

/** 标的元数据扩展字段（ext 子对象） */
export interface InstrumentExt {
  /** 标的类别，如 cn_equity / us_equity / hk_equity */
  type?: string
  /** 流通股本 */
  float_shares?: number
  /** 涨停价 */
  limit_up?: number
  /** 跌停价 */
  limit_down?: number
  /** 上市日期（字符串，如 1999-11-10） */
  listing_date?: string
  /** 英文名 */
  name_en?: string
  /** 最小价格变动单位 */
  tick_size?: number
  /** 总股本 */
  total_shares?: number
  /** 其它未知扩展字段 */
  [key: string]: unknown
}

/** 单个标的元数据 */
export interface Instrument {
  /** 代码（通常为空或等同于 symbol 内部编码） */
  code?: string
  /** 交易所，如 SSE / SZSE / XNAS / XHKG */
  exchange?: string
  /** 地区，如 cn / us / hk */
  region?: string
  /** 标的代码（带市场后缀，如 600000.SH） */
  symbol: string
  /** 中文名 */
  name?: string
  /** 顶层类型，如 stock / index / etf */
  type?: string
  /** 扩展字段 */
  ext?: InstrumentExt
}

/** 批量查询标的元数据响应（data 为数组） */
export type InstrumentsResponse = Instrument[]

/** 交易所信息（GET /v1/exchanges） */
export interface ExchangeInfo {
  /** 交易所代码，如 SSE / SZSE / XNAS / XHKG */
  exchange: string
  /** 所属地区，如 cn / us / hk */
  region: string
  /** 该交易所标的数量 */
  count: number
}

/** 交易所列表响应（data 为数组） */
export type ExchangesResponse = ExchangeInfo[]

/** 某交易所的标的列表响应：直接是 Instrument 数组（与 getInstrumentsBatch 一致） */
export type ExchangeInstrumentsResponse = InstrumentsResponse

/** 标的池（行业分类）概要（GET /v1/universes） */
export interface UniverseSummary {
  /** 唯一标识，如 CN_Equity_A */
  id: string
  /** 显示名称 */
  name: string
  /** 地区代码，如 cn / us / hk */
  region: string
  /** 分类，如 equity / etf / index */
  category: string
  /** 标的数量 */
  symbol_count: number
  /** 描述（可选） */
  description?: string
}

/** 标的池列表响应（data 为数组） */
export type UniversesResponse = UniverseSummary[]

/** 标的池详情（GET /v1/universes/{id}），在概要基础上含具体股票列表 */
export interface UniverseDetail extends UniverseSummary {
  /** 标的代码列表，如 ["600000.SH","000001.SZ"] */
  symbols: string[]
}

/** 主进程经 IPC 返回给渲染端的统一结构 */
export interface StockResult<T> {
  success: boolean
  data?: T
  error?: string
  /** 失败时的 HTTP 状态码（如 401/429） */
  status?: number
}

/* ===================== TickFlow REST 客户端 ===================== */

/** TickFlow 完整服务地址（需 API Key） */
const TICKFLOW_BASE_URL = 'https://api.tickflow.org'

const API_PREFIX = '/v1'

/** 请求失败时抛出的错误，携带 HTTP 状态码 */
export class TickFlowError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'TickFlowError'
    this.status = status
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST'
  /** GET 查询参数（undefined / 空字符串会被忽略）；接受任意键值对象 */
  query?: object
  /** POST 请求体 */
  body?: unknown
}

/**
 * 发起一次 TickFlow 请求，并返回响应中 data 字段的内容。
 *
 * @param apiKey  完整服务的 API Key（注入到 x-api-key 头）
 * @param path    API 路径（不含前缀，如 /quotes）
 * @param opts    请求选项
 * @returns 响应体中 data 字段（若不存在 data 则回退整包 JSON）
 */
async function tickflowRequest<T>(
  apiKey: string,
  path: string,
  opts: RequestOptions = {},
): Promise<T> {
  const { method = 'GET', query, body } = opts

  const url = new URL(API_PREFIX + path, TICKFLOW_BASE_URL)
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== '') {
        url.searchParams.set(key, String(value))
      }
    }
  }

  const headers: Record<string, string> = {
    'x-api-key': apiKey,
  }
  if (method === 'POST') {
    headers['Content-Type'] = 'application/json'
  }

  console.log('开始 请求：', url.toString())
  const res = await fetch(url.toString(), {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })

  // 读取原始文本，避免 JSON 解析失败导致丢失错误信息
  const text = await res.text()
  let json: unknown = null
  if (text) {
    try {
      json = JSON.parse(text)
    } catch {
      json = null
    }
  }

  if (!res.ok) {
    const msg =
      (json && typeof json === 'object' && ('message' in json || 'error' in json)
        ? String((json as Record<string, unknown>).message ?? (json as Record<string, unknown>).error)
        : null) ||
      res.statusText ||
      'TickFlow 请求失败'
    throw new TickFlowError(msg, res.status)
  }

  // 文档约定响应包在 data 字段；若没有 data 字段则直接返回整包
  if (json && typeof json === 'object' && 'data' in json) {
    return (json as { data: T }).data
  }
  return json as T
}

/* ===================== 8 个接口函数 ===================== */

/** 1. 查询实时行情（GET /v1/quotes） */
function getQuotes(apiKey: string, params: QuotesParams): Promise<QuotesResponse> {
  return tickflowRequest<QuotesResponse>(apiKey, '/quotes', { query: params })
}

/** 2. 查询市场深度（五档行情，单标的）（GET /v1/depth） */
function getDepth(apiKey: string, params: DepthParams): Promise<DepthResponse> {
  return tickflowRequest<DepthResponse>(apiKey, '/depth', { query: params })
}

/** 3. 批量查询市场深度（五档行情）（GET /v1/depth/batch） */
function getDepthBatch(apiKey: string, params: DepthBatchParams): Promise<DepthBatchResponse> {
  return tickflowRequest<DepthBatchResponse>(apiKey, '/depth/batch', { query: params })
}

/** 4. 批量查询实时行情（POST /v1/quotes） */
function getQuotesBatch(apiKey: string, body: QuotesBatchBody): Promise<QuotesResponse> {
  return tickflowRequest<QuotesResponse>(apiKey, '/quotes', { method: 'POST', body })
}

/** 5. 查询 K 线数据（单标的）（GET /v1/klines） */
function getKlines(apiKey: string, params: KlinesParams): Promise<KlinesResponse> {
  return tickflowRequest<KlinesResponse>(apiKey, '/klines', { query: params })
}

/** 6. 批量查询 K 线数据（GET /v1/klines/batch） */
function getKlinesBatch(apiKey: string, params: KlinesBatchParams): Promise<KlinesBatchResponse> {
  return tickflowRequest<KlinesBatchResponse>(apiKey, '/klines/batch', { query: params })
}

/** 7. 查询当日分钟 K 线（单标的）（GET /v1/klines/intraday） */
function getIntraday(apiKey: string, params: IntradayParams): Promise<IntradayResponse> {
  return tickflowRequest<IntradayResponse>(apiKey, '/klines/intraday', { query: params })
}

/** 8. 批量查询当日分钟 K 线（GET /v1/klines/intraday/batch） */
function getIntradayBatch(apiKey: string, params: IntradayBatchParams): Promise<IntradayBatchResponse> {
  return tickflowRequest<IntradayBatchResponse>(apiKey, '/klines/intraday/batch', { query: params })
}

/** 9. 查询标的元数据（GET /v1/instruments，逗号分隔字符串） */
function getInstruments(apiKey: string, params: InstrumentsParams): Promise<InstrumentsResponse> {
  return tickflowRequest<InstrumentsResponse>(apiKey, '/instruments', { query: params })
}

/** 10. 批量查询标的元数据（POST /v1/instruments，符号数组） */
function getInstrumentsBatch(apiKey: string, body: InstrumentsBatchBody): Promise<InstrumentsResponse> {
  return tickflowRequest<InstrumentsResponse>(apiKey, '/instruments', { method: 'POST', body })
}

/** 11. 获取交易所列表（GET /v1/exchanges） */
function getExchanges(apiKey: string, params?: Record<string, unknown>): Promise<ExchangesResponse> {
  return tickflowRequest<ExchangesResponse>(apiKey, '/exchanges', { query: params })
}

/** 12. 获取某交易所的标的列表（GET /v1/exchanges/{exchange}/instruments） */
function getExchangeInstruments(apiKey: string, params: { exchange: string }): Promise<InstrumentsResponse> {
  const exchange = String(params.exchange).trim()
  return tickflowRequest<InstrumentsResponse>(apiKey, `/exchanges/${encodeURIComponent(exchange)}/instruments`)
}

/** 13. 获取标的池列表（行业分类）（GET /v1/universes） */
function getUniverses(apiKey: string, params?: Record<string, unknown>): Promise<UniversesResponse> {
  return tickflowRequest<UniversesResponse>(apiKey, '/universes', { query: params })
}

/** 14. 获取标的池详情（含行业分类下的股票列表）（GET /v1/universes/{id}） */
function getUniverseDetail(apiKey: string, params: { id: string }): Promise<UniverseDetail> {
  const id = String(params.id).trim()
  return tickflowRequest<UniverseDetail>(apiKey, `/universes/${encodeURIComponent(id)}`)
}

/* ===================== API Key 管理（基础表，设备绑定密钥加密） ===================== */

/**
 * 股票 API Key 保险库在 basic_info 中的存储键。
 *
 * 与 2FA / 应用锁 / 密保共用同一套 vault/crypto 加密架构（AES-256-GCM + PBKDF2），
 * 密钥来源为「设备绑定主密钥」（deviceKey.ts），明文仅驻留主进程内存。
 *
 * 旧实现用 legacy crypto.ts 的 RSA + 硬编码口令，密文存 basic_info(tickflow_api_key)。
 * 本项目采用「强制重新录入」：initStock 启动时清理旧的 tickflow_api_key 行，旧密文不再被读取。
 */
const API_KEY_DB_KEY = 'stockVault'

/** 内存缓存（解密后的明文 Key），避免每次请求都读库解密 */
let cachedApiKey = ''

/** 查询基础表某 key 的 value（已 JSON.parse），不存在返回 null */
function queryBasicInfoValue(key: string): Promise<unknown | null> {
  return new Promise((resolve) => {
    queryByConditions({
      db: myDb.db,
      tableName: basicInfoTable,
      conditions: { key },
      callback: (err, rows) => {
        if (err || !rows || rows.length === 0) {
          resolve(null)
          return
        }
        try {
          resolve(JSON.parse(rows[0].value))
        } catch {
          resolve(rows[0].value)
        }
      },
    })
  })
}

/** 写入基础表（value 以 JSON 字符串存储，与现有约定一致） */
function upsertBasicInfo(key: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    upsertData({
      db: myDb.db,
      tableName: basicInfoTable,
      data: { key, value: JSON.stringify(value) },
      config: { primaryKey: 'key' },
      callback: (err) => (err ? reject(err) : resolve()),
    })
  })
}

/** 读取并解密 API Key（带内存缓存） */
async function getDecryptedApiKey(): Promise<string> {
  if (cachedApiKey) return cachedApiKey
  const raw = await queryBasicInfoValue(API_KEY_DB_KEY)
  // 旧版密文为 RSA 加密的 base64 字符串，缺少 vault 信封结构 → 视为未配置，强制重新录入
  if (!raw || typeof raw !== 'object' || !('ct' in raw)) {
    cachedApiKey = ''
    return cachedApiKey
  }
  try {
    const arr = decryptVault<string>(raw as VaultEnvelope, getDeviceMasterKey())
    cachedApiKey = arr[0] ?? ''
  } catch {
    // GCM 认证失败（设备密钥不匹配 / 信封损坏）→ 视为未配置，强制重新录入
    cachedApiKey = ''
  }
  return cachedApiKey
}

/** 加密并保存 API Key（信封落 basic_info，明文仅留内存） */
async function setApiKey(plain: string): Promise<void> {
  const env = encryptVault<string>([plain], getDeviceMasterKey())
  await upsertBasicInfo(API_KEY_DB_KEY, env)
  cachedApiKey = plain
}

/* ===================== IPC 注册 ===================== */

/**
 * 带缓存的通用 IPC 处理器：
 * 1. 取 API Key；2. 按"通道 + 参数"算缓存键，命中且未过期直接返回；
 * 3. 否则真实请求 TickFlow 并写回缓存表 stock_cache。
 * 渲染端无感，继续调用原 IPC 通道即可（可选 noCache 强制回源）。
 */
async function cachedHandler<T, P>(
  channel: string,
  fn: (apiKey: string, params: P) => Promise<T>,
  params: P,
): Promise<StockResult<T> & { cached?: boolean }> {
  const meta = CACHE_META[channel]
  const apiKey = await getDecryptedApiKey()
  if (!apiKey) {
    return { success: false, error: '未配置 TickFlow API Key，请在设置中填写' }
  }

  const noCache = (params as Record<string, unknown>)?.noCache === true
  const key = `${channel}::${meta.buildKey(params)}`

  if (!noCache) {
    const cached = await getFromCache(key)
    if (cached && cached.expires_at > Date.now()) {
      console.log('[缓存命中]', key, '剩余有效期(ms):', cached.expires_at - Date.now())
      return { success: true, data: cached.data, cached: true }
    }
  }
  console.log('[缓存未命中]', key)

  // 剥离 noCache 等内部字段，避免作为查询参数发往 TickFlow
  const reqParams = { ...(params as Record<string, unknown>) } as P
  if (noCache) delete (reqParams as Record<string, unknown>).noCache

  try {
    const data = await fn(apiKey, reqParams)
    // 写回缓存（失败静默，不影响本次返回）。TTL 取运行时生效值：
    // 改设置只影响此后写入的条目，旧条目过期时间不变。
    setToCache(key, channel, data).catch(() => {})
    return { success: true, data }
  } catch (e) {
    const err = e as { message?: string; status?: number }
    return { success: false, error: err?.message || 'TickFlow 请求失败', status: err?.status }
  }
}

/** 初始化股票查询模块：预加载 Key、建缓存表、注册全部 IPC 通道 */
export function initStock() {
  // 预热内存缓存（不阻塞，失败静默）
  getDecryptedApiKey().catch(() => {})

  // 清理遗留的旧版 RSA 加密 API Key（tickflow_api_key，强制重新录入，旧密文不再读取）
  del({ tableName: basicInfoTable, condition: { key: 'tickflow_api_key' } }).catch(() => {})

  // 加载缓存 TTL 覆盖配置（失败静默，回退到元数据默认值）
  loadTtlOverrides().catch(() => {})

  // 确保缓存表存在（首次自动建表，失败静默）
  ensureStockCacheTable().catch(() => {})

  // 确保交易所 / 个股主表存在（首次自动建表，失败静默）
  ensureStockMetaTables().catch(() => {})

  // 确保自选股表存在（首次自动建表，失败静默）
  ensureStockWatchlistTable().catch(() => {})

  // 10 个图中接口（全部走统一缓存处理器）
  ipcMain.handle('stock:getQuotes', (_e, p) => cachedHandler('stock:getQuotes', getQuotes, p))
  ipcMain.handle('stock:getDepth', (_e, p) => cachedHandler('stock:getDepth', getDepth, p))
  ipcMain.handle('stock:getDepthBatch', (_e, p) => cachedHandler('stock:getDepthBatch', getDepthBatch, p))
  ipcMain.handle('stock:getQuotesBatch', (_e, p) => cachedHandler('stock:getQuotesBatch', getQuotesBatch, p))
  ipcMain.handle('stock:getKlines', (_e, p) => cachedHandler('stock:getKlines', getKlines, p))
  ipcMain.handle('stock:getKlinesBatch', (_e, p) => cachedHandler('stock:getKlinesBatch', getKlinesBatch, p))
  ipcMain.handle('stock:getIntraday', (_e, p) => cachedHandler('stock:getIntraday', getIntraday, p))
  ipcMain.handle('stock:getIntradayBatch', (_e, p) => cachedHandler('stock:getIntradayBatch', getIntradayBatch, p))
  // 标的元数据：请求成功后额外落库到 stock_instruments（单条标的也能离线命中名字）
  ipcMain.handle('stock:getInstruments', async (_e, p) => {
    const res = await cachedHandler('stock:getInstruments', getInstruments, p)
    if (res.success && Array.isArray(res.data)) {
      saveInstruments(res.data).catch(() => {})
    }
    return res
  })
  ipcMain.handle('stock:getInstrumentsBatch', async (_e, p) => {
    const res = await cachedHandler('stock:getInstrumentsBatch', getInstrumentsBatch, p)
    if (res.success && Array.isArray(res.data)) {
      saveInstruments(res.data).catch(() => {})
    }
    return res
  })

  // 11~14：交易所 / 标的池（行业分类）相关接口，缓存一周
  // 交易所列表：请求成功后额外落库到 stock_exchanges（数组每项 = 一条）
  ipcMain.handle('stock:getExchanges', async (_e, p) => {
    const res = await cachedHandler('stock:getExchanges', getExchanges, p || {})
    if (res.success && Array.isArray(res.data)) {
      saveExchanges(res.data).catch(() => {})
    }
    return res
  })
  // 交易所下的标的：请求成功后额外落库到 stock_instruments（数组每项 = 一条）
  ipcMain.handle('stock:getExchangeInstruments', async (_e, p) => {
    const res = await cachedHandler('stock:getExchangeInstruments', getExchangeInstruments, p)
    // res.data 已是 Instrument[]（tickflowRequest 已剥离外层 data 信封）；直接整体落库
    if (res.success && Array.isArray(res.data)) {
      const exchangeCtx = (p as { exchange?: string })?.exchange
      saveInstruments(res.data, exchangeCtx).catch(() => {})
    }
    return res
  })
  ipcMain.handle('stock:getUniverses', (_e, p) => cachedHandler('stock:getUniverses', getUniverses, p || {}))
  ipcMain.handle('stock:getUniverseDetail', (_e, p) => cachedHandler('stock:getUniverseDetail', getUniverseDetail, p))

  // 交易所 / 个股主表查询（直接从本地持久化的实体表读取，用于离线检索）
  ipcMain.handle('stock:getExchangesDb', async () => {
    try {
      return { success: true, data: await getAllExchangesDb() }
    } catch (e) {
      return { success: false, error: (e as { message?: string })?.message || '读取交易所表失败' }
    }
  })
  ipcMain.handle('stock:getInstrumentsDb', async (_e, p: { exchange?: string }) => {
    try {
      return { success: true, data: await getInstrumentsDb(p?.exchange) }
    } catch (e) {
      return { success: false, error: (e as { message?: string })?.message || '读取个股表失败' }
    }
  })
  // 个股模糊搜索（代码 / 名称 / 简写）
  ipcMain.handle('stock:searchInstruments', async (_e, p: { keyword?: string; limit?: number }) => {
    try {
      return { success: true, data: await searchInstrumentsDb(p?.keyword || '', p?.limit) }
    } catch (e) {
      return { success: false, error: (e as { message?: string })?.message || '个股搜索失败' }
    }
  })

  // API Key ,读取（供将来 UI 调用；当前无 UI）
  ipcMain.handle('stock:setApiKey', async (_event, apiKey: string) => {
    try {
      await setApiKey(apiKey)
      return { success: true }
    } catch (e) {
      return { success: false, error: (e as { message?: string })?.message || '保存失败' }
    }
  })

  ipcMain.handle('stock:getApiKey', async () => {
    const key = await getDecryptedApiKey()
    return { success: true, data: key }
  })

  // 清空股票接口缓存表（一键失效，重新回源）
  ipcMain.handle('stock:clearStockCache', async () => {
    try {
      await clearStockCache()
      return { success: true }
    } catch (e) {
      return { success: false, error: (e as { message?: string })?.message || '清理缓存失败' }
    }
  })

  // 常用股票：从缓存表提炼最近访问过的个股（最多 limit 个，默认 30）
  ipcMain.handle('stock:getRecentSymbols', async (_e, p: { limit?: number }) => {
    try {
      const list = await getRecentSymbols(typeof p?.limit === 'number' ? p.limit : 30)
      return { success: true, data: list }
    } catch (e) {
      return { success: false, error: (e as { message?: string })?.message || '读取常用股票失败' }
    }
  })

  // 自选股：增 / 删 / 查（用户主动维护的标的集合，长期落库）
  ipcMain.handle('stock:getWatchlist', async () => {
    try {
      return { success: true, data: await getWatchlist() }
    } catch (e) {
      return { success: false, error: (e as { message?: string })?.message || '读取自选股失败' }
    }
  })
  ipcMain.handle(
    'stock:addToWatchlist',
    async (_e, p: { items?: Array<{ symbol: string; name?: string; exchange?: string; region?: string; type?: string }> }) => {
      try {
        const data = await addToWatchlist(p?.items || [])
        return { success: true, data }
      } catch (e) {
        return { success: false, error: (e as { message?: string })?.message || '加入自选股失败' }
      }
    },
  )
  ipcMain.handle('stock:removeFromWatchlist', async (_e, p: { symbols?: string[] }) => {
    try {
      return { success: true, data: await removeFromWatchlist(p?.symbols || []) }
    } catch (e) {
      return { success: false, error: (e as { message?: string })?.message || '移出自选股失败' }
    }
  })

  // 读取缓存 TTL 配置（默认 + 当前覆盖），供设置面板渲染
  ipcMain.handle('stock:getCacheTtl', () => {
    try {
      return { success: true, data: getCacheTtlConfig() }
    } catch (e) {
      return { success: false, error: (e as { message?: string })?.message || '读取缓存配置失败' }
    }
  })

  // 保存缓存 TTL 覆盖配置（仅影响后续写入的缓存条目）
  ipcMain.handle('stock:setCacheTtl', async (_event, overrides: Record<string, number>) => {
    try {
      await saveTtlOverrides(overrides)
      return { success: true, data: getCacheTtlConfig() }
    } catch (e) {
      return { success: false, error: (e as { message?: string })?.message || '保存缓存配置失败' }
    }
  })
}

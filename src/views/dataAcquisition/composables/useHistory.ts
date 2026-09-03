/**
 * 数据获取模块 - 采集历史 composable
 * ------------------------------------------------------------------
 * 职责：历史列表查询/删除/清空（scraper_history 表），
 * 结果写入（任务完成后落库）、CSV / JSON 导出。
 */
import { ref } from 'vue'
import type { HistoryItem, ScrapeConfig, ScrapeTaskResult } from '../types'
import { addHistory, listHistory, deleteHistory, clearHistory } from '../db'
import { exportTextToCache } from '@/utils/exportToFile'

/**
 * 采集历史状态与操作
 * @returns 历史列表、查询/删除/清空/落库/导出方法
 */
export function useHistory() {
  /** 历史列表 */
  const history = ref<HistoryItem[]>([])
  /** 关键字过滤 */
  const keyword = ref('')

  /**
   * 刷新历史列表（按创建时间倒序）
   * @throws 写库失败时抛出（调用方提示）
   */
  async function refreshHistory(): Promise<void> {
    history.value = await listHistory(keyword.value || '')
  }

  /**
   * 任务结果落库（自动截断超大数据）并刷新列表
   * @param config 任务配置
   * @param result 任务结果
   * @throws 写库失败时抛出
   */
  async function recordResult(config: ScrapeConfig, result: ScrapeTaskResult): Promise<void> {
    await addHistory(config, result)
    await refreshHistory()
  }

  /**
   * 删除单条历史并刷新
   * @param id 历史 id
   * @throws 写库失败时抛出
   */
  async function removeHistory(id: number): Promise<void> {
    await deleteHistory(id)
    await refreshHistory()
  }

  /**
   * 清空全部历史并刷新
   * @throws 写库失败时抛出
   */
  async function removeAllHistory(): Promise<void> {
    await clearHistory()
    await refreshHistory()
  }

  return {
    history,
    keyword,
    refreshHistory,
    recordResult,
    removeHistory,
    removeAllHistory,
  }
}

/**
 * 生成导出用时间戳（本地时间 YYYYMMDD-HHmmss，与调试快照命名风格一致）
 * @returns 时间戳字符串
 */
function timestamp(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/**
 * 导出记录为 JSON 文件（文件名：任务名称-时间.json）
 * 保留记录原始结构（含提取项容器数组），CSV 会丢失层级不适合本模块。
 * 走统一导出工具 exportTextToCache：直写缓存目录、不弹保存框，
 * 成功提示由工具内部用 fileNotify 展示（蓝色可点击路径）。
 * @param records 采集记录数组
 * @param name 任务名称（作为文件名前缀）
 * @returns 保存后的文件路径（失败返回 null）
 */
export async function exportRecords(records: any[], name: string): Promise<string | null> {
  if (!records || !records.length) return null
  const text = JSON.stringify(records, null, 2)
  const res = exportTextToCache(text, `${name || '采集结果'}-${timestamp()}.json`, {
    title: '采集结果已导出',
  })
  return res.success ? res.path || null : null
}

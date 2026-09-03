<!--
 * 记账 - 收支趋势面板（挂在统计 Tab 底部，完整页与小窗口共用）
 *
 * 功能：
 * - 近 12 个月收支趋势图：收入/支出柱状 + 结余折线（ECharts，配色随主题）
 * - 「导出报表」按钮：生成 CSV（带 BOM，Excel 直接打开不乱码），内容含
 *   ① 月度汇总区块（月份/收入/支出/结余） ② 分类明细区块（月份/类型/分类/金额）
 *   通过既有 net-request:save-file IPC 弹保存对话框写文件，不经主进程新代码。
-->
<template>
  <div class="trend-panel" :class="{ compact }">
    <div class="chart-block">
      <div class="block-head">
        <div class="chart-block-title">收支趋势（近 12 个月）</div>
        <el-button size="small" :loading="exporting" @click="exportReport">
          <LucideIcon name="Download" :size="13" />
          导出报表
        </el-button>
      </div>
      <div ref="chartRef" class="chart-box"></div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, nextTick, watch } from 'vue'
import * as echarts from 'echarts'
import { storeToRefs } from 'pinia'
import { ElMessage } from 'element-plus'
import LucideIcon from '@/components/LucideIcon.vue'
import { exportTextToCache } from '@/utils/exportToFile'
import useAccounting from '@/store/useAccounting'
import useThemeStore from '@/store/useTheme'
import { THEME_COLORS } from '@/utils/chartTheme'
import { currentMonth } from '../../utils/rangeUtils'

withDefaults(defineProps<{ compact?: boolean }>(), { compact: false })

const store = useAccounting()
const { records } = storeToRefs(store)
const { currentTheme } = storeToRefs(useThemeStore())

/** 当前主题配色（图表用，随系统主题切换） */
const themeColors = computed(() => THEME_COLORS[currentTheme.value] || THEME_COLORS.light)

function money(n: number) {
  return '¥' + (Number(n) || 0).toFixed(2)
}

// ============ 近 12 个月趋势数据 ============
/** 趋势月份列表（旧 → 新，含当前月） */
const trendMonths = computed<string[]>(() => {
  const cur = currentMonth()
  const [y, m] = cur.split('-').map(Number)
  const list: string[] = []
  for (let i = 11; i >= 0; i--) {
    const dt = new Date(y, m - 1 - i, 1)
    list.push(`${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`)
  }
  return list
})

/** 每月收入 / 支出 / 结余汇总 */
const trendData = computed(() => {
  const map = new Map<string, { income: number; expense: number }>()
  for (const m of trendMonths.value) map.set(m, { income: 0, expense: 0 })
  for (const r of records.value) {
    const m = (r.record_date || '').slice(0, 7)
    const bucket = map.get(m)
    if (!bucket) continue
    if (r.type === 'income') bucket.income += Number(r.amount) || 0
    else bucket.expense += Number(r.amount) || 0
  }
  return trendMonths.value.map((m) => {
    const b = map.get(m)!
    return { month: m, income: Number(b.income.toFixed(2)), expense: Number(b.expense.toFixed(2)), balance: Number((b.income - b.expense).toFixed(2)) }
  })
})

/** 分类明细聚合（导出用）：月 → 类型 → 分类 → 金额 */
const categoryDetail = computed(() => {
  const months = new Set(trendMonths.value)
  const map = new Map<string, number>()
  for (const r of records.value) {
    const m = (r.record_date || '').slice(0, 7)
    if (!months.has(m)) continue
    const key = `${m}|${r.type}|${r.category || '未分类'}`
    map.set(key, (map.get(key) || 0) + (Number(r.amount) || 0))
  }
  return Array.from(map.entries())
    .map(([key, value]) => {
      const [month, type, category] = key.split('|')
      return { month, type, category, value: Number(value.toFixed(2)) }
    })
    .sort((a, b) => (a.month === b.month ? b.value - a.value : a.month.localeCompare(b.month)))
})

// ============ ECharts ============
const chartRef = ref<HTMLElement>()
let chart: echarts.ECharts | null = null
let observer: ResizeObserver | null = null

/** 渲染趋势图：收入/支出柱状 + 结余折线 */
function render() {
  if (!chartRef.value) return
  if (!chart) chart = echarts.init(chartRef.value)
  const data = trendData.value
  const tc = themeColors.value
  chart.setOption({
    tooltip: {
      trigger: 'axis',
      backgroundColor: tc.tooltipBg,
      borderColor: tc.tooltipBorder,
      textStyle: { color: tc.tooltipText },
      formatter: (ps: any[]) => {
        const month = data[ps[0].dataIndex]?.month || ''
        return ps
          .map((p) => `${p.marker}${p.seriesName} ${money(p.value)}`)
          .join('<br/>')
          .replace(/^/, `${month}<br/>`)
      },
    },
    legend: {
      data: ['收入', '支出', '结余'],
      top: 0,
      textStyle: { color: tc.axisLabel, fontSize: 11 },
      itemWidth: 14,
      itemHeight: 8,
    },
    grid: { left: 56, right: 16, top: 34, bottom: 26 },
    xAxis: {
      type: 'category',
      data: data.map((d) => `${Number(d.month.slice(5, 7))}月`),
      axisLabel: { color: tc.axisLabel, fontSize: 10 },
      axisLine: { lineStyle: { color: tc.axisLabel } },
      axisTick: { show: false },
    },
    yAxis: {
      type: 'value',
      axisLabel: { color: tc.axisLabel, fontSize: 10 },
      splitLine: { lineStyle: { color: tc.gridLine } },
    },
    series: [
      {
        name: '收入',
        type: 'bar',
        barMaxWidth: 16,
        // 最小柱高（px）：某月金额相对其它月份极小时仍保留 2px 可见可交互
        barMinHeight: 2,
        itemStyle: { color: '#67c23a', borderRadius: [3, 3, 0, 0] },
        data: data.map((d) => d.income),
      },
      {
        name: '支出',
        type: 'bar',
        barMaxWidth: 16,
        barMinHeight: 2,
        itemStyle: { color: '#f56c6c', borderRadius: [3, 3, 0, 0] },
        data: data.map((d) => d.expense),
      },
      {
        name: '结余',
        type: 'line',
        smooth: true,
        symbolSize: 5,
        lineStyle: { width: 2, color: '#409eff' },
        itemStyle: { color: '#409eff' },
        data: data.map((d) => d.balance),
      },
    ],
  })
}

// ============ 报表导出 ============
const exporting = ref(false)

/** CSV 单元格转义：含逗号/引号/换行时加引号 */
function csvCell(v: any): string {
  const s = v === null || v === undefined ? '' : String(v)
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}

/**
 * 组装趋势报表 CSV 文本（带 BOM，Excel 打开不乱码）
 *
 * @returns CSV 全文
 */
function buildReportCsv(): string {
  const now = new Date()
  const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`
  const lines: string[] = []
  lines.push('收支趋势报表（近 12 个月）')
  lines.push(`导出时间,${stamp}`)
  lines.push('')
  lines.push('月份,收入,支出,结余')
  for (const d of trendData.value) {
    lines.push([d.month, d.income, d.expense, d.balance].map(csvCell).join(','))
  }
  lines.push('')
  lines.push('分类明细')
  lines.push('月份,类型,分类,金额')
  for (const d of categoryDetail.value) {
    lines.push([d.month, d.type === 'income' ? '收入' : '支出', d.category, d.value].map(csvCell).join(','))
  }
  return '\uFEFF' + lines.join('\r\n')
}

/**
 * 导出报表：走统一导出工具 exportTextToCache 直写缓存目录（不弹保存对话框）。
 * 成功提示由工具内部用 fileNotify 展示（蓝色可点击路径）；失败在此兜底提示。
 */
async function exportReport() {
  exporting.value = true
  try {
    const csv = buildReportCsv()
    const now = new Date()
    const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`
    const res = exportTextToCache(csv, `记账收支趋势报表_${stamp}.csv`, { title: '报表已导出' })
    if (!res.success) ElMessage.error('报表导出失败')
  } catch {
    ElMessage.error('报表导出失败')
  } finally {
    exporting.value = false
  }
}

// 主题 / 数据变化时重绘
watch([records, currentTheme], async () => {
  await nextTick()
  render()
})

onMounted(() => {
  if (chartRef.value) {
    observer = new ResizeObserver(() => chart?.resize())
    observer.observe(chartRef.value)
  }
  nextTick(() => render())
})

onBeforeUnmount(() => {
  observer?.disconnect()
  chart?.dispose()
  chart = null
})
</script>

<style scoped lang="scss">
.trend-panel {
  .chart-block {
    background: var(--el-bg-color-overlay, #fff);
    border: 1px solid var(--el-border-color-lighter, #e4e7ed);
    border-radius: 10px;
    padding: 10px 12px;

    .block-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 6px;
    }

    .chart-block-title {
      font-size: 13px;
      font-weight: 600;
      color: var(--el-text-color-primary, #303133);
    }

    .chart-box {
      width: 100%;
      height: 260px;
    }
  }

  // ============ compact（小窗口） ============
  &.compact {
    .chart-block {
      padding: 8px 10px;

      .chart-block-title {
        font-size: 12px;
      }
      .chart-box {
        height: 180px;
      }
    }
  }
}
</style>

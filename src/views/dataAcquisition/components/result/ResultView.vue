<template>
  <div class="result-view">
    <div class="result-header">
      <el-radio-group v-model="viewMode" size="small">
        <el-radio-button value="table">表格</el-radio-button>
        <el-radio-button value="json">JSON</el-radio-button>
      </el-radio-group>
      <span v-if="records.length" class="result-count">共 {{ records.length }} 条</span>
      <el-button size="small" :disabled="!records.length" @click="onExport">导出 CSV</el-button>
    </div>

    <div v-if="!records.length" class="result-empty">暂无数据（先试运行采集）</div>

    <template v-else>
      <!-- 表格视图：按容器归类分节展示（记录容器一节、每个提取项容器一节，空节不展示） -->
      <template v-if="viewMode === 'table'">
        <!-- 记录容器节：记录级字段（无记录级字段列时不展示） -->
        <div v-if="mainColumns.length" class="result-section">
          <div class="section-title">记录容器（{{ records.length }} 条）</div>
          <el-table
            :data="pagedRecords"
            size="small"
            border
            stripe
            class="result-table"
            :max-height="tableMaxHeight"
          >
            <el-table-column type="index" label="#" width="52" fixed />
            <el-table-column
              v-for="col in mainColumns"
              :key="col"
              :prop="col"
              :label="col"
              :min-width="140"
              show-overflow-tooltip
            >
              <template #default="{ row }">
                {{ formatCell(row[col]) }}
              </template>
            </el-table-column>
          </el-table>
        </div>
        <!-- 项容器节：组名 + 该容器全部记录的子项汇总表（无子项不展示） -->
        <div v-for="gk in groupKeys" :key="gk" class="result-section">
          <div class="section-title">{{ gk }}（{{ flattened(gk).length }} 项）</div>
          <el-table
            :data="flattened(gk)"
            size="small"
            border
            stripe
            class="result-table"
            :max-height="tableMaxHeight"
          >
            <el-table-column type="index" label="#" width="52" fixed />
            <el-table-column
              v-for="col in groupItemKeys(gk)"
              :key="col"
              :prop="col"
              :label="col"
              :min-width="120"
              show-overflow-tooltip
            >
              <template #default="{ row: item }">
                {{ formatCell(item[col]) }}
              </template>
            </el-table-column>
          </el-table>
        </div>
      </template>
      <el-input
        v-else
        :model-value="jsonText"
        type="textarea"
        :rows="20"
        readonly
        class="result-json"
        spellcheck="false"
      />
      <el-pagination
        v-if="viewMode === 'table' && mainColumns.length && records.length > pageSize"
        v-model:current-page="page"
        :page-size="pageSize"
        :total="records.length"
        layout="prev, pager, next, total"
        size="small"
      />
    </template>
  </div>
</template>

<script setup lang="ts">
/**
 * 采集结果视图
 * ------------------------------------------------------------------
 * 动态列表格（列取自记录键并集）与 JSON 双视图，分页展示，
 * 支持 JSON 导出（成功提示含文件链接，点击定位文件位置）。
 */
import { ref, computed, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { exportRecords } from '../../composables/useHistory'

/** 组件属性 */
const props = defineProps<{
  /** 采集记录数组 */
  records: any[];
  /** 导出文件名基础 */
  exportName?: string;
}>()

/** 视图模式 */
const viewMode = ref<'table' | 'json'>('table')
/** 表格当前页 */
const page = ref(1)
/** 每页条数 */
const pageSize = 50
/** 表格最大高度（px，自适应视口） */
const tableMaxHeight = Math.max(240, Math.floor(window.innerHeight * 0.5))

/** 记录的列集合（首条记录键 + 其余记录新增键的并集） */
const columns = computed(() => {
  const set = new Set<string>()
  for (const row of props.records.slice(0, 200)) {
    Object.keys(row || {}).forEach((k) => set.add(k))
  }
  return Array.from(set)
})

/**
 * 判断值是否为「项容器子项数组」（非空数组且元素为对象）
 * @param value 待判断的值
 * @returns 是子项数组时返回 true
 */
function isItemArray(value: any): boolean {
  return Array.isArray(value) && value.length > 0 && typeof value[0] === 'object' && value[0] !== null
}

/** 提取项容器字段名（值在样本记录中为对象数组的键） */
const groupKeys = computed(() => columns.value.filter((k) => props.records.slice(0, 200).some((r) => isItemArray(r?.[k]))))

/** 记录级主表列（排除提取项容器字段） */
const mainColumns = computed(() => columns.value.filter((k) => !groupKeys.value.includes(k)))

/** 子项字段的列缓存（键 → 子项列数组，避免模板中反复求并集） */
const groupItemKeysCache = new Map<string, string[]>()
/** 子项拍平汇总缓存（键 → 全部记录子项合并数组） */
const flattenCache = new Map<string, any[]>()

// 记录变化（重新运行）时清空缓存，避免展示旧字段/旧数据
watch(
  () => props.records,
  () => {
    groupItemKeysCache.clear()
    flattenCache.clear()
  }
)

/**
 * 求某提取项容器下全部子项的字段列并集
 * @param key 容器字段名
 * @returns 子项字段名数组
 */
function groupItemKeys(key: string): string[] {
  const cached = groupItemKeysCache.get(key)
  if (cached) return cached
  const set = new Set<string>()
  for (const row of props.records.slice(0, 200)) {
    const items = row?.[key]
    if (isItemArray(items)) {
      for (const item of items.slice(0, 50)) Object.keys(item || {}).forEach((k) => set.add(k))
    }
  }
  const keys = Array.from(set)
  groupItemKeysCache.set(key, keys)
  return keys
}

/**
 * 拍平某提取项容器：全部记录的子项合并为一张表的数据源
 * @param key 容器字段名
 * @returns 子项对象数组
 */
function flattened(key: string): any[] {
  const cached = flattenCache.get(key)
  if (cached) return cached
  const out: any[] = []
  for (const row of props.records) {
    const items = row?.[key]
    if (isItemArray(items)) out.push(...items)
  }
  flattenCache.set(key, out)
  return out
}

/** 当前页记录切片 */
const pagedRecords = computed(() => {
  const start = (page.value - 1) * pageSize
  return props.records.slice(start, start + pageSize)
})

/** 记录 JSON 文本（超长截断防卡顿） */
const jsonText = computed(() => {
  try {
    const text = JSON.stringify(props.records, null, 2)
    return text.length > 200000 ? text.slice(0, 200000) + '\n...（超长截断）' : text
  } catch {
    return ''
  }
})

/**
 * 单元格值格式化（数组分号连接，对象 JSON 化，其余 String 化）
 * @param value 单元格原始值
 * @returns 展示文本
 */
function formatCell(value: any): string {
  if (value === null || value === undefined) return ''
  if (Array.isArray(value)) return value.map((v) => (typeof v === 'object' ? JSON.stringify(v) : String(v))).join('; ')
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/**
 * 导出当前结果为 JSON 文件。
 * 统一导出工具 exportTextToCache 已内部分步：直写缓存目录、不弹保存框，
 * 成功时通过 fileNotify 展示蓝色可点击路径（点击定位文件）。这里仅处理失败提示。
 */
async function onExport(): Promise<void> {
  const saved = await exportRecords(props.records, props.exportName || '采集结果')
  if (!saved) {
    ElMessage.error('导出失败')
  }
}
</script>

<style scoped>
.result-view {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.result-header {
  display: flex;
  align-items: center;
  gap: 12px;
}
.result-count {
  flex: 1;
  font-size: 12px;
  color: var(--text-muted);
}
.result-empty {
  font-size: 12px;
  color: var(--text-muted);
  padding: 20px 0;
  text-align: center;
}
.result-table {
  width: 100%;
}
.result-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.section-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  padding-left: 2px;
}
.result-json {
  font-family: Consolas, Monaco, monospace;
  font-size: 12px;
}
</style>

<style>
/* 导出提示中的文件链接（ElMessage 挂载于 body，需全局样式） */
.export-tip .export-link {
  color: var(--color-primary);
  cursor: pointer;
  text-decoration: underline;
  margin-left: 4px;
  word-break: break-all;
}
</style>

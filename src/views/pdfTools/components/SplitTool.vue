<template>
  <div class="tool-panel">
    <FileDropZone @select="onSelect" />

    <div v-if="file" class="cfg">
      <div class="sel-file">
        <LucideIcon name="FileText" :size="15" class="ficon" />
        <span class="fname" :title="file.path">{{ file.name }}</span>
      </div>

      <div class="mode-row">
        <span class="lbl">拆分方式</span>
        <el-radio-group v-model="modeType">
          <el-radio value="range">按范围</el-radio>
          <el-radio value="everyN">每 N 页</el-radio>
          <el-radio value="oddEven">奇偶页</el-radio>
        </el-radio-group>
      </div>

      <div v-if="modeType === 'range'" class="opt-row range-row">
        <span class="lbl">页码范围</span>
        <RangeInput v-model="rangeTags" hint="支持多个范围与单页；回车即在下方生成 tag，可点 × 删除" />
      </div>
      <div v-else-if="modeType === 'everyN'" class="opt-row">
        <span class="lbl">每页</span>
        <el-input-number v-model="everyN" :min="1" :max="999" />
        <span class="unit">页一份</span>
      </div>
      <div v-else class="opt-row">
        <span class="lbl">输出</span>
        <span class="hint">将生成 2 份：奇数页 / 偶数页</span>
      </div>

      <div class="opt-row">
        <span class="lbl">输出目录</span>
        <el-input :model-value="outDir" readonly placeholder="点击选择输出目录" @click="pickDir">
          <template #suffix>
            <LucideIcon name="FolderOpen" :size="15" class="ficon" />
          </template>
        </el-input>
      </div>

      <p class="subdir-hint">将自动生成「{{ file ? file.name.replace(/\.pdf$/i, '') : '文件名' }}-拆分-时间」子目录存放拆分结果</p>

      <div class="actions">
        <el-button type="primary" :loading="loading" :disabled="!canRun" @click="doSplit">开始拆分</el-button>
      </div>
    </div>

    <PdfResultBar :result="result" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { ElMessage } from 'element-plus';
import LucideIcon from '@/components/LucideIcon.vue';
import FileDropZone from './FileDropZone.vue';
import PdfResultBar from './PdfResultBar.vue';
import RangeInput from './RangeInput.vue';
import { pdfApi } from '../api/pdfApi';
import { makeExportSubDir } from '../utils/exportPath';
import { rangeTagsToRanges } from '../utils/pageRange';
import { usePdfTools } from '../store/usePdfTools';
import type { PdfFileItem, PdfActionResult, SplitConfig } from '../types';

const store = usePdfTools();
const file = ref<PdfFileItem | null>(null);
// 右键「PDF 拆分」外部打开：挂载时预载传入的 PDF
onMounted(() => {
  const f = store.consumePendingFiles();
  if (f.length) file.value = { path: f[0], name: f[0].replace(/^.*[\\/]/, '') };
});
const modeType = ref<'range' | 'everyN' | 'oddEven'>('range');
/** 拆分范围（tag 式）：每个元素是一个已校验的范围文本，如「1-3」「5」 */
const rangeTags = ref<string[]>([]);
const everyN = ref(2);
const outDir = ref('');
const result = ref<PdfActionResult | null>(null);
const loading = ref(false);

const canRun = computed(() => !!file.value && !!outDir.value && (modeType.value !== 'range' || rangeTags.value.length > 0));

function onSelect(paths: string[]): void {
  if (paths.length) {
    file.value = { path: paths[0], name: paths[0].replace(/^.*[\\/]/, '') };
    result.value = null;
    rangeTags.value = [];
  }
}

/** 聚合所有 tag → 0 基 [[s,e]]（闭区间） */
const parsedRanges = computed<Array<[number, number]>>(() =>
  modeType.value === 'range' ? rangeTagsToRanges(rangeTags.value) : [],
);

async function pickDir(): Promise<void> {
  const res = await pdfApi.pickDir();
  if (res.success && res.dir) outDir.value = res.dir;
}

function buildMode(): SplitConfig {
  if (modeType.value === 'range') return { type: 'range', ranges: parsedRanges.value };
  if (modeType.value === 'everyN') return { type: 'everyN', n: everyN.value };
  return { type: 'oddEven' };
}

async function doSplit(): Promise<void> {
  result.value = null;
  if (!file.value || !outDir.value) return;
  if (modeType.value === 'range' && rangeTags.value.length === 0) {
    ElMessage.warning('请添加至少一个有效的页码范围');
    return;
  }
  const base = file.value.name.replace(/\.pdf$/i, '');
  // 自动导出到「<源文件名>-拆分-<datetime>」子目录，避免多次拆分文件散落混在一起
  const subDir = makeExportSubDir(outDir.value, base, '拆分');
  loading.value = true;
  try {
    const res = await pdfApi.split(file.value.path, subDir, base, buildMode());
    result.value = res;
    // 记录子目录（真实导出地址），PdfResultBar 会按文件定位并可直接打开该目录
    if (res.success) store.pushOutput(subDir);
  } finally {
    loading.value = false;
  }
}
</script>

<style scoped>
.tool-panel {
  display: flex;
  flex-direction: column;
}
.cfg {
  margin-top: 14px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.sel-file {
  display: flex;
  align-items: center;
  gap: 8px;
}
.ficon {
  color: var(--color-primary);
  flex: none;
}
.fname {
  color: var(--text-primary);
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mode-row,
.opt-row {
  display: flex;
  align-items: center;
  gap: 12px;
}
.range-row {
  align-items: flex-start;
}
.lbl {
  width: 64px;
  flex: none;
  color: var(--text-secondary);
  font-size: 13px;
}
.unit,
.hint {
  color: var(--text-muted);
  font-size: 12px;
}
.subdir-hint {
  margin: -4px 0 0;
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.5;
}
.actions {
  margin-top: 4px;
}
</style>

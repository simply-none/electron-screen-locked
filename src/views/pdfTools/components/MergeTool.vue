<template>
  <div class="tool-panel">
    <FileDropZone multiple @select="onSelect" />

    <div v-if="files.length" class="file-list">
      <div v-for="(f, i) in files" :key="f.path" class="file-row" :draggable="true"
           @dragstart="dragIndex = i" @dragover.prevent @drop.prevent="onDrop(i)">
        <span class="idx">{{ i + 1 }}</span>
        <LucideIcon name="FileText" :size="15" class="ficon" />
        <span class="fname" :title="f.path">{{ f.name }}</span>
        <div class="row-ops">
          <LucideIcon name="ChevronUp" :size="15" class="op" @click="move(i, -1)" />
          <LucideIcon name="ChevronDown" :size="15" class="op" @click="move(i, 1)" />
          <LucideIcon name="Trash2" :size="15" class="op danger" @click="remove(i)" />
        </div>
      </div>
    </div>

    <div class="actions">
      <el-button type="primary" :loading="loading" :disabled="files.length < 2" @click="doMerge">
        合并为单个 PDF
      </el-button>
      <span v-if="files.length < 2" class="tip">至少选择 2 个文件</span>
    </div>

    <PdfResultBar :result="result" />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { ElMessage } from 'element-plus';
import LucideIcon from '@/components/LucideIcon.vue';
import FileDropZone from './FileDropZone.vue';
import PdfResultBar from './PdfResultBar.vue';
import { pdfApi } from '../api/pdfApi';
import { usePdfTools } from '../store/usePdfTools';
import type { PdfFileItem, PdfActionResult } from '../types';

const store = usePdfTools();
const files = ref<PdfFileItem[]>([]);

// 右键「PDF 合并」外部打开：挂载时预载传入的多个 PDF
onMounted(() => {
  const f = store.consumePendingFiles();
  if (f.length) onSelect(f);
});
const result = ref<PdfActionResult | null>(null);
const loading = ref(false);
const dragIndex = ref<number>(-1);

function onSelect(paths: string[]): void {
  const set = new Set(files.value.map((f) => f.path));
  for (const p of paths) {
    if (!p || set.has(p)) continue;
    files.value.push({ path: p, name: p.replace(/^.*[\\/]/, '') });
    set.add(p);
  }
}

function move(i: number, dir: number): void {
  const j = i + dir;
  if (j < 0 || j >= files.value.length) return;
  const arr = files.value;
  [arr[i], arr[j]] = [arr[j], arr[i]];
}
function remove(i: number): void {
  files.value.splice(i, 1);
}
function onDrop(target: number): void {
  const from = dragIndex.value;
  dragIndex.value = -1;
  if (from < 0 || from === target) return;
  const arr = files.value;
  const [item] = arr.splice(from, 1);
  arr.splice(target, 0, item);
}

async function doMerge(): Promise<void> {
  result.value = null;
  if (files.value.length < 2) {
    ElMessage.warning('请至少选择 2 个文件');
    return;
  }
  const base = files.value[0].name.replace(/\.pdf$/i, '');
  const save = await pdfApi.pickSave(`${base}_合并.pdf`);
  if (!save.success || !save.filePath) return;
  loading.value = true;
  try {
    const res = await pdfApi.merge(
      files.value.map((f) => f.path),
      save.filePath,
    );
    result.value = res;
    if (res.success && res.outputPath) store.pushOutput(res.outputPath);
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
.file-list {
  margin-top: 14px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 320px;
  overflow: auto;
}
.file-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  background: var(--bg-card);
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
}
.idx {
  width: 20px;
  text-align: center;
  color: var(--text-muted);
  font-size: 12px;
}
.ficon {
  color: var(--color-primary);
  flex: none;
}
.fname {
  flex: 1;
  min-width: 0;
  color: var(--text-primary);
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.row-ops {
  display: flex;
  gap: 4px;
  flex: none;
}
.op {
  cursor: pointer;
  color: var(--text-secondary);
  padding: 2px;
  border-radius: 4px;
}
.op:hover {
  background: var(--bg-hover);
  color: var(--color-primary);
}
.op.danger:hover {
  color: var(--color-error);
}
.actions {
  margin-top: 14px;
  display: flex;
  align-items: center;
  gap: 12px;
}
.tip {
  color: var(--text-muted);
  font-size: 12px;
}
</style>

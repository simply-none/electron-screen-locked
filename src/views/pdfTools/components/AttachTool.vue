<template>
  <div class="tool-panel">
    <p class="hint">向 PDF 嵌入一个附件文件（如原始素材、说明文档）。嵌入后可在 PDF 阅读器工具栏的「附件」面板查看并另存（Adobe、Foxit 等外部阅读器同样支持）。</p>

    <div class="field">
      <label>源 PDF</label>
      <PdfSourcePicker v-model:path="src" />
    </div>

    <div class="field">
      <label>附件文件</label>
      <div class="att-pick">
        <el-button @click="pickAtt">选择文件</el-button>
        <span v-if="attName" class="att-name" :title="attName">{{ attName }}</span>
        <el-button v-if="attName" text type="danger" @click="clearAtt">清除</el-button>
        <input ref="attInput" type="file" hidden @change="onAtt" />
      </div>
    </div>

    <div class="actions">
      <el-button type="primary" :loading="loading" :disabled="!src || !attFile" @click="run">嵌入附件</el-button>
      <span v-if="(!src || !attFile)" class="tip">需选择 PDF 与附件</span>
    </div>

    <PdfResultBar :result="result" />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { ElMessage } from 'element-plus';
import PdfSourcePicker from './PdfSourcePicker.vue';
import PdfResultBar from './PdfResultBar.vue';
import { pdfApi } from '../api/pdfApi';
import { fileToBase64 } from '../composables/usePdfjs';
import { usePdfTools } from '../store/usePdfTools';
import type { PdfActionResult } from '../types';

const store = usePdfTools();
const src = ref<string | null>(null);

// 右键「PDF 提取附件」外部打开：挂载时预载传入的 PDF（附件提取在「附件」工具内操作）
onMounted(() => {
  const f = store.consumePendingFiles();
  if (f.length) src.value = f[0];
});
const attInput = ref<HTMLInputElement | null>(null);
const attFile = ref<File | null>(null);
const attName = ref('');
const result = ref<PdfActionResult | null>(null);
const loading = ref(false);

function pickAtt(): void {
  attInput.value?.click();
}
function onAtt(e: Event): void {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (f) {
    attFile.value = f;
    attName.value = f.name;
  }
  (e.target as HTMLInputElement).value = '';
}
function clearAtt(): void {
  attFile.value = null;
  attName.value = '';
}

async function run(): Promise<void> {
  result.value = null;
  if (!src.value || !attFile.value) {
    ElMessage.warning('请选择 PDF 与附件');
    return;
  }
  const base = (src.value || '').replace(/^.*[\\/]/, '').replace(/\.pdf$/i, '');
  const save = await pdfApi.pickSave(`${base}_附件.pdf`);
  if (!save.success || !save.filePath) return;
  loading.value = true;
  try {
    const data = await fileToBase64(attFile.value);
    const res = await pdfApi.attach(src.value!, save.filePath, data, attFile.value.name, attFile.value.type || 'application/octet-stream');
    result.value = res;
    if (res.success && res.outputPath) store.pushOutput(res.outputPath);
  } catch (err) {
    result.value = { success: false, error: String(err) };
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
.hint {
  color: var(--text-muted);
  font-size: 13px;
  margin: 0 0 12px;
}
.field {
  margin-bottom: 12px;
}
.field label {
  display: block;
  color: var(--text-secondary);
  font-size: 13px;
  margin-bottom: 6px;
}
.att-pick {
  display: flex;
  align-items: center;
  gap: 10px;
}
.att-name {
  color: var(--text-secondary);
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 260px;
}
.actions {
  margin-top: 8px;
  display: flex;
  align-items: center;
  gap: 12px;
}
.tip {
  color: var(--text-muted);
  font-size: 12px;
}
</style>

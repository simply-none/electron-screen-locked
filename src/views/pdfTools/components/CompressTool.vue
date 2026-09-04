<template>
  <div class="tool-panel">
    <p class="hint">重新生成 PDF 并启用对象流压缩以减小体积。深度图片重编码（如 JPEG 再压缩）需额外引擎，本工具为轻量压缩。</p>

    <div class="field">
      <label>源 PDF</label>
      <PdfSourcePicker v-model:path="src" />
    </div>

    <div class="actions">
      <el-button type="primary" :loading="loading" :disabled="!src" @click="run">压缩并另存</el-button>
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
import { usePdfTools } from '../store/usePdfTools';
import type { PdfActionResult } from '../types';

const store = usePdfTools();
const src = ref<string | null>(null);

// 右键「PDF 压缩」外部打开：挂载时预载传入的 PDF
onMounted(() => {
  const f = store.consumePendingFiles();
  if (f.length) src.value = f[0];
});
const result = ref<PdfActionResult | null>(null);
const loading = ref(false);

async function run(): Promise<void> {
  result.value = null;
  if (!src.value) {
    ElMessage.warning('请先选择 PDF');
    return;
  }
  const base = (src.value || '').replace(/^.*[\\/]/, '').replace(/\.pdf$/i, '');
  const save = await pdfApi.pickSave(`${base}_压缩.pdf`);
  if (!save.success || !save.filePath) return;
  loading.value = true;
  try {
    const res = await pdfApi.compress(src.value!, save.filePath);
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
</style>

<template>
  <div class="tool-panel">
    <FileDropZone @select="onSelect" />

    <div v-if="file" class="cfg">
      <div class="sel-file">
        <LucideIcon name="FileText" :size="15" class="ficon" />
        <span class="fname" :title="file.path">{{ file.name }}</span>
        <span class="pc">共 {{ pageCount }} 页</span>
      </div>

      <div class="opt-row">
        <span class="lbl">图片格式</span>
        <el-radio-group v-model="format">
          <el-radio value="png">PNG</el-radio>
          <el-radio value="jpg">JPG</el-radio>
        </el-radio-group>
      </div>

      <div class="opt-row">
        <span class="lbl">清晰度</span>
        <el-radio-group v-model="scale">
          <el-radio :value="1">标准</el-radio>
          <el-radio :value="1.5">高清</el-radio>
          <el-radio :value="2">超清</el-radio>
        </el-radio-group>
      </div>

      <div class="opt-row range-row">
        <span class="lbl">页码范围</span>
        <RangeInput v-model="rangeTags" hint="留空=全部页；支持多个范围，回车生成 tag" />
      </div>

      <div class="opt-row">
        <span class="lbl">输出目录</span>
        <el-input :model-value="outDir" readonly placeholder="缓存目录（导出后可在提示中打开）">
          <template #suffix>
            <LucideIcon name="FolderOpen" :size="15" class="ficon" />
          </template>
        </el-input>
      </div>

      <p class="subdir-hint">将自动生成「{{ file ? file.name.replace(/\.pdf$/i, '') : '文件名' }}-导出图片-时间」子目录存放图片（位于缓存目录）</p>

      <div class="actions">
        <el-button type="primary" :loading="loading" :disabled="!file" @click="doExport">
          导出图片
        </el-button>
        <span v-if="progress" class="tip">{{ progress }}</span>
      </div>
    </div>

    <PdfResultBar :result="result" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onBeforeUnmount } from 'vue';
import { ElMessage } from 'element-plus';
import LucideIcon from '@/components/LucideIcon.vue';
import FileDropZone from './FileDropZone.vue';
import PdfResultBar from './PdfResultBar.vue';
import RangeInput from './RangeInput.vue';
import { pdfApi } from '../api/pdfApi';
import { makeExportSubDir } from '../utils/exportPath';
import { rangeTagsToIndices } from '../utils/pageRange';
import { loadPdf, renderPageToImage } from '../composables/usePdfjs';
import { usePdfTools } from '../store/usePdfTools';
import type { PdfFileItem, PdfActionResult } from '../types';
import { fileNotify } from '@/utils/fileNotify';
import useCacheSet from '@/store/useCacheSet';

const store = usePdfTools();
const cacheSet = useCacheSet();
const file = ref<PdfFileItem | null>(null);
const pageCount = ref(0);
const format = ref<'png' | 'jpg'>('png');
const scale = ref<number>(1.5);
const rangeTags = ref<string[]>([]);
// 统一导出规范：默认直写缓存目录，不弹目录选择框
const outDir = computed(() => cacheSet.fileCachePathC.value || '');
const result = ref<PdfActionResult | null>(null);
const progress = ref('');
const loading = ref(false);

/** 已加载的 PDF 文档（非响应式变量：pdf.js 文档含私有字段，绝不能被 Vue 代理） */
let pdfDoc: any = null;
/** 安全释放文档：destroy 为尽力清理，异常忽略（与阅读器一致） */
function disposeDoc(): void {
  if (pdfDoc && typeof pdfDoc.destroy === 'function') {
    try {
      pdfDoc.destroy();
    } catch {
      /* ignore */
    }
  }
  pdfDoc = null;
}

// 组件卸载（返回工具列表/切换页面）时释放缓存的 PDF 文档，避免 pdf.js worker 泄漏
onBeforeUnmount(() => {
  if (pdfDoc) disposeDoc();
});

function parsePages(total: number): number[] {
  const idxs = rangeTagsToIndices(rangeTags.value);
  if (!idxs.length) return Array.from({ length: total }, (_, i) => i);
  // 仅保留在文档范围内的页码（0 基）
  return idxs.filter((i) => i >= 0 && i < total).sort((a, b) => a - b);
}

async function onSelect(paths: string[]): Promise<void> {
  if (!paths.length) return;
  result.value = null;
  rangeTags.value = [];
  try {
    // 切换文件时先释放上一次加载的文档
    if (pdfDoc) disposeDoc();
    const res = await (window as any).ipcRenderer.ebook.readFileBytes(paths[0]);
    if (!res || !res.base64) {
      ElMessage.error('读取文件失败');
      return;
    }
    const pdf: any = await loadPdf(res.base64);
    // 暂存文档供 doExport 复用（非响应式变量，避免 pdf.js 文档被 Vue 代理导致方法失效）
    pdfDoc = pdf;
    file.value = { path: paths[0], name: paths[0].replace(/^.*[\\/]/, ''), pages: pdf.numPages };
    pageCount.value = pdf.numPages;
  } catch (e) {
    ElMessage.error('PDF 解析失败：' + String(e));
  }
}

async function doExport(): Promise<void> {
  result.value = null;
  if (!file.value || !outDir.value) return;
  const idxs = parsePages(pageCount.value);
  if (!idxs.length) {
    ElMessage.warning('没有匹配的页码');
    return;
  }
  loading.value = true;
  try {
    // 复用 onSelect 已加载的文档（非响应式暂存），未加载则重新读取
    let pdf = pdfDoc;
    if (!pdf) {
      const res = await (window as any).ipcRenderer.ebook.readFileBytes(file.value.path);
      pdf = await loadPdf(res.base64);
      pdfDoc = pdf;
    }
    const ext = format.value === 'jpg' ? 'jpg' : 'png';
    const fmt = format.value === 'jpg' ? 'image/jpeg' : 'image/png';
    const files: { name: string; base64: string }[] = [];
    const baseW = 900 * scale.value;
    for (let i = 0; i < idxs.length; i++) {
      const page = await pdf.getPage(idxs[i] + 1);
      const url = await renderPageToImage(page, baseW, fmt);
      files.push({ name: `page_${String(idxs[i] + 1).padStart(4, '0')}.${ext}`, base64: url });
      progress.value = `已导出 ${i + 1}/${idxs.length}`;
    }
    disposeDoc();
    // 自动导出到「<源文件名>-导出图片-<datetime>」子目录，避免多页图片散落混在一起
    const base = file.value.name.replace(/\.pdf$/i, '');
    const subDir = makeExportSubDir(outDir.value, base, '导出图片');
    const w = await pdfApi.writeFiles(subDir, files);
    // 写入 outputPath（子目录）以便结果条可直接点击打开目录
    result.value = { success: w.success, count: w.count, outputPath: w.success ? subDir : undefined };
    if (w.success) {
      store.pushOutput(subDir);
      // 统一导出规范：成功提示用 fileNotify（蓝色可点击路径，点击在资源管理器打开）
      fileNotify({ title: 'PDF 图片已导出', filePath: subDir });
    }
  } catch (e) {
    result.value = { success: false, error: String(e) };
  } finally {
    loading.value = false;
    progress.value = '';
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
  max-width: 280px;
}
.pc {
  color: var(--text-muted);
  font-size: 12px;
}
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
.actions {
  margin-top: 4px;
  display: flex;
  align-items: center;
  gap: 12px;
}
.tip {
  color: var(--text-muted);
  font-size: 12px;
}
.subdir-hint {
  margin: -4px 0 0;
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.5;
}
</style>

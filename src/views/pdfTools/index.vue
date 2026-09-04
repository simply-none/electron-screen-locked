<template>
  <div class="pdf-tools-view">
    <div class="head">
      <div>
        <h2 class="page-title">PDF 工具箱</h2>
        <p class="sub">本地离线处理，文件不出本机</p>
      </div>
      <el-button v-if="store.activeTool" @click="store.backToDashboard()">
        <LucideIcon name="ChevronLeft" :size="15" /> 返回工具列表
      </el-button>
    </div>

    <!-- 仪表盘：工具卡片网格 -->
    <template v-if="!store.activeTool">
      <div class="cards">
        <PdfToolCard
          v-for="t in store.tools"
          :key="t.key"
          :meta="t"
          @click="store.openTool(t.key)"
        />
      </div>

      <div v-if="store.recentOutputs.length" class="recent">
        <div class="recent-title">最近输出</div>
        <div
          v-for="p in store.recentOutputs"
          :key="p"
          class="recent-item"
          :title="p"
          @click="openFolder(p)"
        >
          <LucideIcon name="FileText" :size="14" />
          <span>{{ short(p) }}</span>
        </div>
      </div>
    </template>

    <!-- 具体工具 -->
    <template v-else>
      <!-- 二级标题：当前工具名称与描述 -->
      <div class="tool-head">
        <h3 class="tool-title">{{ activeMeta?.title }}</h3>
        <p v-if="activeMeta?.desc" class="tool-desc">{{ activeMeta.desc }}</p>
      </div>
      <component :is="currentComponent" :key="remountKey" />
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import LucideIcon from '@/components/LucideIcon.vue';
import PdfToolCard from './components/PdfToolCard.vue';
import MergeTool from './components/MergeTool.vue';
import SplitTool from './components/SplitTool.vue';
import OrganizeTool from './components/OrganizeTool.vue';
import ExportImagesTool from './components/ExportImagesTool.vue';
import InsertTool from './components/InsertTool.vue';
import ReplaceTool from './components/ReplaceTool.vue';
import DuplicateTool from './components/DuplicateTool.vue';
import CropTool from './components/CropTool.vue';
import DecorateTool from './components/DecorateTool.vue';
import WatermarkTool from './components/WatermarkTool.vue';
import CoverTool from './components/CoverTool.vue';
import ResizeTool from './components/ResizeTool.vue';
import DetectBlankTool from './components/DetectBlankTool.vue';
import FlattenTool from './components/FlattenTool.vue';
import CompressTool from './components/CompressTool.vue';
import RedactTool from './components/RedactTool.vue';
import SecurityTool from './components/SecurityTool.vue';
import PageLabelsTool from './components/PageLabelsTool.vue';
import AttachTool from './components/AttachTool.vue';
import CompareTool from './components/CompareTool.vue';
import { usePdfTools } from './store/usePdfTools';
import type { PdfToolKey } from './types';

const store = usePdfTools();

// 右键外部打开时，force 重挂载当前工具组件以触发其 onMounted 消费 pendingFiles
const remountKey = ref(0);
watch(
  () => store.pendingFiles.length,
  (n) => {
    if (n > 0) remountKey.value++;
  }
);

const compMap: Record<PdfToolKey, any> = {
  merge: MergeTool,
  split: SplitTool,
  organize: OrganizeTool,
  exportImages: ExportImagesTool,
  // 二期
  insert: InsertTool,
  replace: ReplaceTool,
  duplicate: DuplicateTool,
  crop: CropTool,
  decorate: DecorateTool,
  watermark: WatermarkTool,
  cover: CoverTool,
  resize: ResizeTool,
  detectBlank: DetectBlankTool,
  flatten: FlattenTool,
  // 三期
  compress: CompressTool,
  redact: RedactTool,
  security: SecurityTool,
  pageLabels: PageLabelsTool,
  attach: AttachTool,
  compare: CompareTool,
};
const currentComponent = computed(() => (store.activeTool ? compMap[store.activeTool] : null));
/** 当前工具的元信息（标题/描述），用于二级标题展示 */
const activeMeta = computed(() => store.tools.find((t) => t.key === store.activeTool));

function short(p: string): string {
  return p.length > 52 ? '…' + p.slice(p.length - 50) : p;
}
function openFolder(p: string): void {
  const dir = p.replace(/[^\\/]+$/, '');
  (window as any).ipcRenderer.send('open-folder', dir);
}
</script>

<style scoped>
.pdf-tools-view {
  padding: 20px 24px;
}
.head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  margin-bottom: 18px;
}
/* 区块标题：柔和渐变淡出下划线（用户偏好） */
.page-title {
  margin: 0;
  font-size: 20px;
  color: var(--text-primary);
  position: relative;
  display: inline-block;
  padding-bottom: 8px;
}
.page-title::after {
  content: '';
  position: absolute;
  left: 0;
  bottom: 0;
  width: 120px;
  height: 2px;
  border-radius: 2px;
  background: linear-gradient(90deg, var(--color-primary), color-mix(in srgb, var(--color-primary) 0%, transparent));
}
.sub {
  margin: 6px 0 0;
  color: var(--text-muted);
  font-size: 13px;
}
/* 二级标题：当前打开工具的名称与描述 */
.tool-head {
  margin-bottom: 14px;
}
.tool-title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  display: flex;
  align-items: center;
  gap: 6px;
}
/* 标题左侧的竖向强调条，标识当前工具 */
.tool-title::before {
  content: '';
  width: 3px;
  height: 14px;
  border-radius: 2px;
  background: var(--color-primary);
}
.tool-desc {
  margin: 4px 0 0 9px;
  color: var(--text-muted);
  font-size: 12px;
}
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 14px;
}
.recent {
  margin-top: 26px;
}
.recent-title {
  color: var(--text-secondary);
  font-size: 13px;
  margin-bottom: 8px;
  position: relative;
  display: inline-block;
  padding-bottom: 6px;
}
.recent-title::after {
  content: '';
  position: absolute;
  left: 0;
  bottom: 0;
  width: 80px;
  height: 2px;
  border-radius: 2px;
  background: linear-gradient(90deg, var(--text-muted), transparent);
}
.recent-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-radius: 6px;
  color: var(--text-secondary);
  font-size: 13px;
  cursor: pointer;
  max-width: 520px;
}
.recent-item:hover {
  background: var(--bg-hover);
  color: var(--color-primary);
}
</style>

<template>
  <div class="diff-viewer">
    <ToolHint text="左右两栏分别粘贴文本即自动对比；可切换视图（并排/合并/内联）与算法（行/词/字符/JSON/CSS），差异块支持逐个或全部应用" />
    <!-- ========== 工具栏 ========== -->
    <div class="toolbar">
      <!-- 第一行：视图 + 算法 -->
      <div class="tool-row">
        <span class="lbl">视图:</span>
        <el-radio-group v-model="viewMode" size="small">
          <el-radio-button :value="'split'">并排</el-radio-button>
          <el-radio-button :value="'unified'">合并</el-radio-button>
          <el-radio-button :value="'inline'">内联</el-radio-button>
        </el-radio-group>
        <el-divider direction="vertical" />
        <span class="lbl">算法:</span>
        <el-radio-group v-model="algo" size="small">
          <el-radio-button :value="'line'">行级</el-radio-button>
          <el-radio-button :value="'word'">词级</el-radio-button>
          <el-radio-button :value="'char'">字符级</el-radio-button>
          <el-radio-button :value="'json'">JSON</el-radio-button>
          <el-radio-button :value="'css'">CSS</el-radio-button>
        </el-radio-group>
      </div>

      <!-- 第二行：预处理选项 -->
      <div class="tool-row">
        <span class="lbl">空白:</span>
        <el-select v-model="whitespaceMode" size="small" style="width: 120px">
          <el-option label="不忽略" value="none" />
          <el-option label="仅裁剪行尾" value="trailing" />
          <el-option label="裁剪首尾" value="trim" />
          <el-option label="忽略全部" value="all" />
        </el-select>
        <el-checkbox v-model="ignoreCase" label="忽略大小写" size="small" />
        <el-checkbox v-model="ignoreLineEnding" label="忽略 CRLF" size="small" />
      </div>

      <!-- 第三行：操作按钮 -->
      <div class="tool-row btn-row">
        <el-button size="small" :icon="ArrowLeftRight" @click="swap">交换</el-button>
        <el-button size="small" :icon="Eraser" @click="clearAll">清空</el-button>
        <el-button size="small" @click="formatJsonSide('left')">A→JSON</el-button>
        <el-button size="small" @click="formatJsonSide('right')">B→JSON</el-button>
        <el-divider direction="vertical" />
        <el-tooltip content="把所有差异块从 A 同步到 B（B 全部改为 A 的内容）" placement="bottom">
          <el-button size="small" @click="applyAll('left-to-right')" :disabled="hunks.length === 0">全部 A→B →</el-button>
        </el-tooltip>
        <el-tooltip content="把所有差异块从 B 同步到 A（A 全部改为 B 的内容）" placement="bottom">
          <el-button size="small" @click="applyAll('right-to-left')" :disabled="hunks.length === 0">← 全部 B→A</el-button>
        </el-tooltip>
        <el-divider direction="vertical" />
        <el-button size="small" :icon="Download" @click="exportPatch" :disabled="hunks.length === 0">导出 Patch</el-button>
        <el-button size="small" :icon="Terminal" @click="patchPanelOpen = true">Patch 面板</el-button>
        <el-divider direction="vertical" />
        <el-button size="small" :icon="Upload" @click="pickFile('left')">📁 A</el-button>
        <el-button size="small" :icon="Upload" @click="pickFile('right')">📁 B</el-button>
      </div>
    </div>

    <!-- ========== 统计条 ========== -->
    <div class="stats-row">
      <el-tag type="success" size="small" effect="dark">+ {{ stats.added }} 行</el-tag>
      <el-tag type="danger" size="small" effect="dark">- {{ stats.removed }} 行</el-tag>
      <el-tag type="warning" size="small" effect="dark">~ {{ stats.modified }} 行</el-tag>
      <el-tag size="small" effect="plain">未变 {{ stats.unchanged }} 行</el-tag>
      <el-tag size="small" effect="plain">A {{ stats.leftLines }} 行 / B {{ stats.rightLines }} 行</el-tag>
      <el-tag v-if="stats.changeRate > 0" size="small" effect="plain" :type="stats.changeRate > 50 ? 'danger' : 'warning'">
        变化率 {{ stats.changeRate }}%
      </el-tag>
      <el-tag v-if="leftText === rightText && leftText.length > 0" type="success" effect="light" size="small">两边完全一致 ✅</el-tag>
      <span v-if="hunks.length > 0" class="hunk-count">
        共 {{ hunks.length }} 处差异块
      </span>
    </div>

    <!-- ========== 视图切换 ========== -->
    <SplitView
      v-if="viewMode === 'split'"
      :left-text="leftText"
      :right-text="rightText"
      :items="diffResult"
      :hunks="hunks"
      :algo="algo"
      @update:leftText="leftText = $event"
      @update:rightText="rightText = $event"
      @apply-hunk="applyHunk"
      @pick-file="pickFile"
    />
    <UnifiedView
      v-else-if="viewMode === 'unified'"
      :left-text="leftText"
      :right-text="rightText"
      :items="diffResult"
      :hunks="hunks"
      :algo="algo"
      @apply-hunk="applyHunk"
    />
    <InlineView
      v-else
      :left-text="leftText"
      :right-text="rightText"
      :items="diffResult"
      :hunks="hunks"
      :algo="algo"
      @apply-hunk="applyHunk"
    />

    <!-- ========== Patch 面板 Drawer ========== -->
    <PatchPanel
      v-model:visible="patchPanelOpen"
      :left-text="leftText"
      :right-text="rightText"
      @apply-result="onPatchApplyResult"
    />
  </div>
</template>

<script setup lang="ts">
/**
 * Diff 主容器 —— 管理核心状态 + 下发给子视图组件
 */
import { ref, computed, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { ArrowLeftRight, Eraser, Download, Upload, Terminal } from '@lucide/vue';
import ToolHint from '@/components/ToolHint.vue';
import SplitView from './SplitView.vue';
import UnifiedView from './UnifiedView.vue';
import InlineView from './InlineView.vue';
import PatchPanel from './PatchPanel.vue';
import { computeDiff, buildHunks, createStandardPatch, applyStandardPatch } from './patcher';
import { calculateStats, isJson, formatJson as fmtJson, debounce } from './utils';
import type { DiffAlgorithm, WhitespaceMode, NormalizeOptions } from './utils';
import type { DiffItem, DiffHunk } from './patcher';
import { exportTextToCache } from '@/utils/exportToFile';

// ============== 响应式状态 ==============
const leftText = ref('');
const rightText = ref('');
const viewMode = ref<'split' | 'unified' | 'inline'>('split');
const algo = ref<DiffAlgorithm>('line');
const whitespaceMode = ref<WhitespaceMode>('none');
const ignoreCase = ref(false);
const ignoreLineEnding = ref(true);
/** Patch 面板抽屉状态 */
const patchPanelOpen = ref(false);

// ============== 派生计算 ==============
const opts = computed<NormalizeOptions>(() => ({
  whitespace: whitespaceMode.value,
  ignoreCase: ignoreCase.value,
  ignoreLineEnding: ignoreLineEnding.value
}));

// 防抖计算 diff（300ms）
const diffResult = ref<DiffItem[]>([]);
const hunks = ref<DiffHunk[]>([]);

const debouncedRecompute = debounce(() => {
  diffResult.value = computeDiff(leftText.value, rightText.value, opts.value, algo.value);
  hunks.value = buildHunks(diffResult.value);
}, 200);

// 任一输入/选项变化都触发重算
watch(
  [leftText, rightText, algo, whitespaceMode, ignoreCase, ignoreLineEnding],
  debouncedRecompute,
  { immediate: true }
);

// 统计
const stats = computed(() =>
  calculateStats(diffResult.value, leftText.value, rightText.value)
);

// ============== 操作 ==============
/** 交换左右 */
function swap() {
  [leftText.value, rightText.value] = [rightText.value, leftText.value];
}

/** 清空 */
function clearAll() {
  leftText.value = '';
  rightText.value = '';
}

/**
 * 把一侧格式化为 JSON
 * @param side 目标侧
 */
function formatJsonSide(side: 'left' | 'right') {
  const src = side === 'left' ? leftText.value : rightText.value;
  if (!isJson(src)) {
    ElMessage.warning('文本不是合法 JSON，无法格式化');
    return;
  }
  try {
    const out = fmtJson(src);
    if (side === 'left') leftText.value = out;
    else rightText.value = out;
    ElMessage.success('JSON 格式化完成');
  } catch {
    ElMessage.error('JSON 格式化失败');
  }
}

/**
 * 应用某个 hunk —— 单块级应用（用户选了"每个差异块旁边单块应用"）
 * 用整体字符串 replace：找到目标侧要被替换的原文 → 替换为另一侧的内容
 * @param hunk 目标 hunk
 * @param direction 'right-to-left' 把 B 的该块应用到 A；'left-to-right' 反之
 */
function applyHunk(hunk: DiffHunk, direction: 'right-to-left' | 'left-to-right') {
  const removedParts = hunk.items.filter(i => i.removed).map(i => i.value);
  const addedParts = hunk.items.filter(i => i.added).map(i => i.value);

  const oldText = direction === 'right-to-left'
    ? removedParts.join('')   // A 侧要被替换掉的原文
    : addedParts.join('');    // B 侧要被替换掉的原文
  const newText = direction === 'right-to-left'
    ? addedParts.join('')     // 用 B 的内容替换 A
    : removedParts.join('');  // 用 A 的内容替换 B

  const targetSide = direction === 'right-to-left' ? 'left' : 'right';
  const targetRef = targetSide === 'left' ? leftText : rightText;
  const idx = targetRef.value.indexOf(oldText);
  if (idx === -1) {
    // 找不到原文 → fallback：用 patch apply 精准定位
    try {
      const patch = createStandardPatch('A.txt', 'B.txt', leftText.value, rightText.value, 0);
      // 构造只包含这个 hunk 的 patch（简化：用完整 patch 不行，回退方案）
      ElMessage.warning('块替换失败：原文未找到（可能已被其他块修改）');
      return;
    } catch {
      ElMessage.warning('块替换失败：原文未找到');
      return;
    }
  }
  targetRef.value = targetRef.value.slice(0, idx) + newText + targetRef.value.slice(idx + oldText.length);
  ElMessage.success(`已将此块从 ${direction === 'right-to-left' ? 'B' : 'A'} 应用到 ${direction === 'right-to-left' ? 'A' : 'B'}`);
}

/**
 * 全局接受/拒绝 —— 把所有差异一次性同步到一侧
 * 通过 applyStandardPatch 对目标侧应用完整 patch，精准、可靠、一次到位
 * @param direction 'right-to-left' 全部 B→A；'left-to-right' 全部 A→B
 */
async function applyAll(direction: 'right-to-left' | 'left-to-right') {
  const total = hunks.value.length;
  const dirLabel = direction === 'right-to-left' ? 'B → A' : 'A → B';
  try {
    await ElMessageBox.confirm(
      `确定把所有 ${total} 处差异从 ${dirLabel} 方向同步？此操作不可撤销。`,
      '全局同步确认',
      { confirmButtonText: '确定同步', cancelButtonText: '取消', type: 'warning' }
    );
  } catch { return; }

  // 用 patch 方式：先生成完整 patch，再应用到目标侧
  const targetSide = direction === 'right-to-left' ? 'left' : 'right';
  const base = targetSide === 'left' ? leftText.value : rightText.value;
  const patch = createStandardPatch('A.txt', 'B.txt', leftText.value, rightText.value, 3);

  if (direction === 'right-to-left') {
    // 要把 B 的内容应用到 A → 直接用 patch（A 是 old，B 是 new）
    const result = applyStandardPatch(base, patch);
    if (typeof result === 'string') {
      leftText.value = result;
      ElMessage.success(`全部 ${total} 处差异已从 B 同步到 A ✅`);
    } else {
      ElMessage.error('同步失败: ' + (result as any).error);
    }
  } else {
    // 要把 A 的内容应用到 B → 用反向 patch
    const reversed = applyStandardPatch('', ''); // noop，下面自己做
    // 更简单的方式：直接用 applyPatch 的反向
    try {
      const DiffLib = await import('diff');
      const patches = DiffLib.parsePatch(patch);
      // @ts-ignore - 反向每个 patch
      const reversedPatches = patches.map((p: any) => DiffLib.reversePatch(p));
      // @ts-ignore - 转成文本
      const reversedPatchText = reversedPatches.map((p: any) => DiffLib.formatPatch(p)).join('\n\n');
      const result = DiffLib.applyPatch(base, reversedPatchText);
      if (typeof result === 'string') {
        rightText.value = result;
        ElMessage.success(`全部 ${total} 处差异已从 A 同步到 B ✅`);
      } else {
        ElMessage.error('同步失败: patch 无法应用（上下文不匹配）');
      }
    } catch (e: any) {
      ElMessage.error('同步失败: ' + (e?.message ?? e));
    }
  }
}

/**
 * Patch 面板应用结果回传
 */
function onPatchApplyResult(side: 'left' | 'right', text: string) {
  if (side === 'left') leftText.value = text;
  else rightText.value = text;
}

/** 导出标准 patch：统一导出工具直写缓存目录（不弹保存框，成功用 fileNotify 提示） */
function exportPatch() {
  const patch = createStandardPatch('A.txt', 'B.txt', leftText.value, rightText.value, 3);
  if (!patch.trim() || hunks.value.length === 0) {
    ElMessage.info('两边文本完全一致，没有可导出的 patch');
    return;
  }
  const res = exportTextToCache(patch, `diff-${Date.now()}.patch`, { title: 'Patch 已导出' });
  if (!res.success) ElMessage.error('Patch 导出失败');
}

/** 读取文件 */
function pickFile(side: 'left' | 'right') {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.txt,.md,.json,.js,.ts,.vue,.html,.css,.log,.csv,.py,.yml,.yaml,.xml,.ini';
  input.onchange = () => {
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (side === 'left') leftText.value = reader.result as string;
      else rightText.value = reader.result as string;
      ElMessage.success(`已导入 ${file.name} 到 ${side === 'left' ? 'A' : 'B'} 侧`);
    };
    reader.readAsText(file);
  };
  input.click();
}
</script>

<style lang="scss" scoped>
.diff-viewer { display: flex; flex-direction: column; gap: 12px; height: 100%; }

/* 工具栏：统一主操作卡片（卡片内纵向分三行） */
.toolbar {
  display: flex; flex-direction: column; gap: 8px; flex-shrink: 0;
  padding: 12px 14px;
  background: var(--bg-card, var(--el-bg-color));
  border: 1px solid var(--border-subtle, var(--el-border-color-lighter));
  border-radius: var(--radius-btn, 10px);
  box-shadow: var(--shadow-card, none);
}
.tool-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.lbl { font-size: 13px; color: var(--text-secondary, var(--el-text-color-secondary)); }
.btn-row { margin-left: auto; }

/* 统计条：浅底圆角条 */
.stats-row {
  display: flex; flex-wrap: wrap; gap: 8px; align-items: center;
  padding: 6px 12px;
  background: var(--bg-base, var(--el-fill-color-lighter));
  border-radius: 6px;
  font-size: 12px;
  flex-shrink: 0;
}
.hunk-count {
  margin-left: auto; color: var(--text-secondary, var(--el-text-color-secondary));
  font-family: Consolas, monospace;
}
</style>

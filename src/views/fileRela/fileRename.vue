<template>
  <div class="file-card">
    <div class="card-header rename-header">
      <h3 class="card-title">
        <el-icon><LucideIcon name="FileType" /></el-icon>
        文件批量重命名
      </h3>
      <div class="header-right">
        <span class="header-hint">选择文件夹后实时预览，确认无误再应用</span>
        <el-checkbox v-model="showProgress" class="progress-toggle">进度检测</el-checkbox>
      </div>
    </div>
    <div class="card-body">
      <div class="rename-section">
        <!-- 选择目标文件夹 -->
        <div class="path-item">
          <div class="path-head">
            <span class="path-label">目标文件夹</span>
          </div>
          <el-input v-model="folder" placeholder="请选择要批量重命名的文件夹" disabled :title="folder">
            <template #append>
              <el-button @click="selectFolder" class="path-btn">
                <el-icon><LucideIcon name="Folder" /></el-icon>
                选择目录
              </el-button>
            </template>
          </el-input>
        </div>

        <!-- 范围与排序 + 类型过滤 + 冲突策略 -->
        <div class="range-row" v-if="folder || externalActive">
          <el-checkbox v-model="recursive">包含子目录</el-checkbox>
          <el-checkbox v-model="renameDirs">同时重命名文件夹（否则仅文件）</el-checkbox>
          <span class="range-label">序号排序</span>
          <el-select v-model="sortBy" class="sort-select" size="default">
            <el-option label="按名称" value="name" />
            <el-option label="按修改时间" value="mtime" />
            <el-option label="按大小" value="size" />
            <el-option label="原顺序" value="none" />
          </el-select>
          <span class="range-label">冲突处理策略</span>
          <el-select v-model="conflictStrategy" class="strategy-select" size="default">
            <el-option label="拦截并报错" value="block" />
            <el-option label="自动加序号" value="auto" />
            <el-option label="跳过" value="skip" />
          </el-select>
          <el-input v-model="extFilter" class="ext-filter" size="small" placeholder="类型过滤，如 jpg,png" clearable />
          <el-button size="small" @click="refreshList" plain>
            <el-icon><LucideIcon name="RefreshCw" :size="14" /></el-icon>
            刷新列表
          </el-button>
        </div>

        <!-- 重命名规则面板（共享引擎组件，与文件转移复用） -->
        <RenameRulesPanel v-model="rules" v-if="folder || externalActive" />

        <!-- 实时预览 -->
        <div class="preview-block" v-if="folder || externalActive">
          <div class="preview-head">
            <span>
              预览（共 {{ fileList.length }} 项，
              <b class="sel-text">已选 {{ selectedCount }}</b> 项，将重命名
              <b :class="{ warn: renameTargets.length === 0 }">{{ renameTargets.length }}</b> 项
              <template v-if="selectedConflictCount">
                <b class="conflict-text">，已选中 {{ selectedConflictCount }} 处重名冲突</b>
              </template>
              <template v-if="skippedCount">
                <b class="skip-text">，{{ skippedCount }} 项因重名跳过</b>
              </template>
              ）
            </span>
            <span class="preview-tools">
              <el-button link size="small" type="primary" @click="toggleAll(true)">全选</el-button>
              <el-button link size="small" @click="toggleAll(false)">全不选</el-button>
            </span>
          </div>
          <el-table :data="pagedPreview" class="preview-table" max-height="320" size="small" :row-class-name="rowClassName">
            <el-table-column width="48" align="center" class-name="col-check">
              <template #header>
                <el-checkbox :model-value="allSelected" @change="onHeaderCheck" />
              </template>
              <template #default="{ row }">
                <el-checkbox :model-value="row.selected" @change="(v: any) => onRowCheck(row.oldPath, v)" />
              </template>
            </el-table-column>
            <el-table-column label="原文件名" min-width="200">
              <template #default="{ row }">
                <span class="cell-name" :title="row.oldPath">{{ row.oldName }}</span>
              </template>
            </el-table-column>
            <el-table-column label="→" width="40" align="center">
              <template #default><el-icon><LucideIcon name="ArrowRight" :size="14" /></el-icon></template>
            </el-table-column>
            <el-table-column label="新文件名" min-width="200">
              <template #default="{ row }">
                <span class="cell-name" :class="{ unchanged: row.unchanged, willRename: row.selected && !row.unchanged && !row.skipped }">{{ row.newName }}</span>
              </template>
            </el-table-column>
            <el-table-column label="状态" width="110" align="center">
              <template #default="{ row }">
                <el-tag v-if="!row.selected" type="info" size="small" effect="plain">未选中</el-tag>
                <el-tag v-else-if="row.conflict" type="danger" size="small">重名冲突</el-tag>
                <el-tag v-else-if="row.skipped" type="warning" size="small">已跳过</el-tag>
                <el-tag v-else-if="row.unchanged" type="info" size="small">无变化</el-tag>
                <el-tag v-else type="success" size="small">将重命名</el-tag>
              </template>
            </el-table-column>
          </el-table>
          <div class="preview-pager" v-if="totalFiltered > pageSize">
            <el-pagination
              layout="total, sizes, prev, pager, next, jumper"
              :total="totalFiltered"
              :page-size="pageSize"
              :current-page="currentPage"
              :page-sizes="[50, 100, 200, 500]"
              @current-change="(p: number) => { currentPage = p; }"
              @size-change="(s: number) => { pageSize = s; currentPage = 1; }"
              small
              background
            />
          </div>
        </div>

        <div class="copy-btn-wrap" v-if="folder || externalActive">
          <el-button
            v-if="lastRenameMap.length"
            @click="onUndo"
            :disabled="applying"
            plain
          >
            <el-icon><LucideIcon name="Undo2" :size="14" /></el-icon>
            撤销上一次重命名（{{ lastRenameMap.length }}）
          </el-button>
          <el-button
            type="primary"
            @click="onApply"
            class="apply-btn"
            :disabled="(!folder && !externalActive) || hasBlockingConflict || renameTargets.length === 0"
          >
            <el-icon><LucideIcon name="CircleCheck" /></el-icon>
            应用重命名（{{ renameTargets.length }}）
          </el-button>
        </div>
      </div>
    </div>

    <app-dialog
      v-model="progressVisible"
      :title="isUndoing ? '撤销重命名进度' : '文件重命名进度'"
      width="440px"
      :close-on-click-modal="false"
      :close-on-press-escape="false"
      append-to-body
    >
      <div class="progress-body">
        <el-progress :percentage="progressPercent" :stroke-width="14" />
        <div class="progress-meta">已重命名 {{ progressCurrent }} / {{ progressTotal }} 项</div>
        <div class="progress-current" :title="progressCurrentPath">{{ progressCurrentPath || '准备中…' }}</div>
      </div>
    </app-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, watch, onMounted, onUnmounted } from 'vue';
import LucideIcon from '@/components/LucideIcon.vue';
import { send, sendSync } from '@/utils/common';
import { ElMessage } from 'element-plus';
import RenameRulesPanel from './rename/RenameRulesPanel.vue';
import { computeNewName, createDefaultRules, getExt, getBase, type RenameRules, type ListFolderItem } from './rename/engine';
import type { ConflictStrategy } from './rename/types';
import { useFileRela } from './store/useFileRela';

// 目标文件夹
const folder = ref('');
// 右键「批量重命名」外部打开：直接以传入的文件列表构建预览（跳过文件夹选择）
const externalActive = ref(false);
const relaStore = useFileRela();

/** 从外部路径列表构建预览项（渲染端无 node fs，仅需路径/名称/扩展名） */
function loadExternalFiles(paths: string[]): void {
  externalActive.value = true;
  fileList.value = paths.map((p) => {
    const name = p.replace(/^.*[\\/]/, '');
    const ext = (name.match(/\.[^.]+$/) || [''])[0];
    return { path: p, name, ext, isDir: false, mtime: 0, size: 0 } as ListFolderItem;
  });
}

function selectFolder() {
  const res = sendSync('get-file-list', 'select-dir');
  if (res && res.length) {
    externalActive.value = false;
    folder.value = res[0];
    refreshList();
  }
}

// 文件夹内容（来自主进程 list-folder，返回 { items, total }）
const fileList = ref<ListFolderItem[]>([]);
function refreshList() {
  if (!folder.value) return;
  try {
    const res = sendSync('list-folder', {
      dir: folder.value,
      recursive: recursive.value,
      includeDirs: true,
    }) as { items: ListFolderItem[]; total: number };
    fileList.value = res?.items || [];
  } catch (e) {
    console.error('list-folder 失败:', e);
    fileList.value = [];
  }
}

// 范围与排序
const recursive = ref(false); // 是否遍历子目录
const renameDirs = ref(false); // 是否重命名文件夹（false=仅文件）
const sortBy = ref<'name' | 'mtime' | 'size' | 'none'>('name');
const conflictStrategy = ref<ConflictStrategy>('block'); // 重名处理策略
const extFilter = ref(''); // 类型过滤（逗号分隔，如 jpg,png）

// 切换「包含子目录」时自动重新拉取列表
watch(recursive, () => {
  if (folder.value) refreshList();
});

// 所有重命名规则（共享引擎提供默认值，集中管理）
const rules = reactive(createDefaultRules()) as RenameRules;

// 路径工具（渲染进程无 node path）：用于拼接目标路径
function dirOf(p: string): string {
  return p.replace(/[\\/][^\\/]*$/, '');
}
function sepOf(p: string): string {
  return p.includes('\\') ? '\\' : '/';
}

// 实时预览：范围/类型过滤/排序/规则计算新名，并按冲突策略处理重名
const previewList = computed(() => {
  let list = fileList.value.filter((f) => (renameDirs.value ? true : !f.isDir));
  // 类型过滤
  const ef = extFilter.value.trim();
  if (ef) {
    const exts = ef.split(',').map((s) => s.trim().toLowerCase().replace(/^\./, ''));
    list = list.filter((f) => exts.includes(f.ext.replace(/^\./, '').toLowerCase()));
  }
  const arr = [...list];
  if (sortBy.value === 'mtime') arr.sort((a, b) => a.mtime - b.mtime);
  else if (sortBy.value === 'size') arr.sort((a, b) => a.size - b.size);
  else if (sortBy.value === 'name') arr.sort((a, b) => a.name.localeCompare(b.name, 'zh'));

  const mapped = arr.map((f, i) => {
    const newName = computeNewName(f, i, rules);
    const newPath = dirOf(f.path) + sepOf(f.path) + newName;
    return {
      oldPath: f.path,
      oldName: f.name,
      newName,
      newPath,
      selected: selectedMap.value.has(f.path) ? (selectedMap.value.get(f.path) as boolean) : true,
      unchanged: newName === f.name,
      conflict: false,
      skipped: false,
    };
  });

  // 按冲突策略处理重名（同一目标路径被多个源命中）
  if (conflictStrategy.value === 'auto') {
    const used = new Set<string>();
    mapped.forEach((m) => {
      if (used.has(m.newPath)) {
        const e = getExt(m.newName);
        const b = getBase(m.newName);
        let k = 2;
        let cand = `${b} (${k})${e}`;
        let cnp = dirOf(m.newPath) + sepOf(m.newPath) + cand;
        while (used.has(cnp)) {
          k++;
          cand = `${b} (${k})${e}`;
          cnp = dirOf(m.newPath) + sepOf(m.newPath) + cand;
        }
        m.newName = cand;
        m.newPath = cnp;
      }
      used.add(m.newPath);
    });
  } else if (conflictStrategy.value === 'block') {
    const cnt = new Map<string, number>();
    mapped.forEach((m) => cnt.set(m.newPath, (cnt.get(m.newPath) || 0) + 1));
    mapped.forEach((m) => {
      if ((cnt.get(m.newPath) || 0) > 1) m.conflict = true;
    });
  } else if (conflictStrategy.value === 'skip') {
    const seen = new Set<string>();
    mapped.forEach((m) => {
      if (seen.has(m.newPath)) m.skipped = true;
      else seen.add(m.newPath);
    });
  }
  return mapped;
});

// 勾选态：默认全部选中，按 oldPath 记忆用户操作
const selectedMap = ref<Map<string, boolean>>(new Map());
function toggleAll(val: boolean) {
  previewList.value.forEach((m) => selectedMap.value.set(m.oldPath, val));
}
function onHeaderCheck(v: any) {
  toggleAll(!!v);
}
function onRowCheck(path: string, v: any) {
  selectedMap.value.set(path, !!v);
}

// 统计：已选 / 真正重命名（已选+有变化+无冲突+未跳过）/ 已选中冲突 / 已跳过
const selectedCount = computed(() => previewList.value.filter((m) => m.selected).length);
const renameTargets = computed(() =>
  previewList.value.filter((m) => m.selected && !m.unchanged && !m.conflict && !m.skipped)
);
const selectedConflictCount = computed(() =>
  previewList.value.filter((m) => m.selected && m.conflict).length
);
const skippedCount = computed(() =>
  previewList.value.filter((m) => m.selected && m.skipped).length
);
// 仅「拦截」策略下，存在已选中冲突才阻断应用
const hasBlockingConflict = computed(
  () => conflictStrategy.value === 'block' && selectedConflictCount.value > 0
);
const allSelected = computed(
  () => previewList.value.length > 0 && previewList.value.every((m) => m.selected)
);

// ===== 预览分页（显示分页，数据仍在内存；重命名需全局序号+冲突去重，不全量下沉后端）=====
const currentPage = ref(1);
const pageSize = ref(100);
// 重命名预览为全量计算（冲突去重依赖全集合），分页仅裁切展示
const totalFiltered = computed(() => previewList.value.length);
const pagedPreview = computed(() => {
  const start = (currentPage.value - 1) * pageSize.value;
  return previewList.value.slice(start, start + pageSize.value);
});
// 范围/类型/含子目录变化后回到第 1 页
watch([recursive, renameDirs, extFilter], () => {
  currentPage.value = 1;
});

function rowClassName({ row }: { row: { conflict: boolean; unchanged: boolean; selected: boolean; skipped: boolean } }) {
  if (row.conflict) return 'row-conflict';
  if (row.skipped) return 'row-skipped';
  if (!row.selected) return 'row-unselected';
  if (row.unchanged) return 'row-unchanged';
  return 'row-will-rename';
}

// 进度 / 撤销
const showProgress = ref(false);
const progressVisible = ref(false);
const progressCurrent = ref(0);
const progressTotal = ref(0);
const progressCurrentPath = ref('');
const progressPercent = computed(() => {
  if (!progressTotal.value) return 0;
  return Math.min(100, Math.round((progressCurrent.value / progressTotal.value) * 100));
});
const applying = ref(false);
const isUndoing = ref(false);
const lastRenameMap = ref<{ oldPath: string; newPath: string }[]>([]); // 上一次实际重命名映射，供撤销

function onApply() {
  if (!folder.value && !externalActive.value) {
    ElMessage.warning('请先选择文件夹或右键批量重命名');
    return;
  }
  if (hasBlockingConflict.value) {
    ElMessage.error('已选中的文件存在重名冲突，请调整规则或取消勾选后再应用');
    return;
  }
  // 仅重命名「已勾选 + 有变化 + 无冲突 + 未跳过」的项
  const items = renameTargets.value.map((m) => ({ oldPath: m.oldPath, newPath: m.newPath }));
  // 按路径深度降序：先重命名深层子项，再重命名父目录
  items.sort((a, b) => b.oldPath.split(/[\\/]/).length - a.oldPath.split(/[\\/]/).length);
  if (!items.length) {
    ElMessage.warning('没有选中需要重命名的文件');
    return;
  }
  applying.value = true;
  progressCurrent.value = 0;
  progressTotal.value = items.length;
  progressCurrentPath.value = '';
  isUndoing.value = false;
  if (showProgress.value) progressVisible.value = true;
  send('rename-files', { items, strategy: conflictStrategy.value });
}

function onUndo() {
  if (!lastRenameMap.value.length || applying.value) return;
  applying.value = true;
  progressCurrent.value = 0;
  progressTotal.value = lastRenameMap.value.length;
  progressCurrentPath.value = '';
  isUndoing.value = true;
  if (showProgress.value) progressVisible.value = true;
  send('reverse-rename', { items: lastRenameMap.value });
}

const onRenameProgress = (_event: any, data: { current: number; total: number; currentPath: string }) => {
  if (!progressVisible.value) return;
  progressCurrent.value = data.current;
  progressTotal.value = data.total;
  progressCurrentPath.value = data.currentPath;
};
// 正向重命名完成
const onRename = (_event: any, res: any) => {
  if (!applying.value || isUndoing.value) return;
  applying.value = false;
  progressVisible.value = false;
  if (res == null) {
    ElMessage.success('重命名成功');
    lastRenameMap.value = [];
  } else if (res.error) {
    ElMessage({ message: '重命名失败: ' + res.error, type: 'error', duration: 5000 });
    // 失败时：若部分成功，保留映射仅用于理论上可撤销（但 disk 状态可能不一致），保守清空
    lastRenameMap.value = [];
  } else {
    // 成功：res.renamed 为实际重命名映射
    const renamed = res.renamed || [];
    lastRenameMap.value = renamed;
    ElMessage.success(`重命名成功，共 ${renamed.length} 项`);
  }
  refreshList();
};
// 撤销完成
const onReversed = (_event: any, res: any) => {
  if (!applying.value || !isUndoing.value) return;
  applying.value = false;
  isUndoing.value = false;
  progressVisible.value = false;
  if (res == null) {
    ElMessage.success('已撤销上一次重命名');
    lastRenameMap.value = [];
  } else {
    ElMessage({ message: '撤销失败: ' + res, type: 'error', duration: 5000 });
  }
  refreshList();
};

onMounted(() => {
  window.ipcRenderer.on('rename-files', onRename);
  window.ipcRenderer.on('rename-files-progress', onRenameProgress);
  window.ipcRenderer.on('rename-files-reversed', onReversed);
  // 右键「批量重命名」外部打开：挂载时若有待处理文件则直接构建预览
  const ext = relaStore.consumePendingRenameFiles();
  if (ext.length) loadExternalFiles(ext);
});

// 已在页面内时，后续到达的右键文件也直接构建预览
watch(
  () => relaStore.pendingRenameFiles,
  (files) => {
    if (files && files.length) loadExternalFiles(files);
  }
);
onUnmounted(() => {
  window.ipcRenderer.removeAllListeners('rename-files');
  window.ipcRenderer.removeAllListeners('rename-files-progress');
  window.ipcRenderer.removeAllListeners('rename-files-reversed');
});
</script>

<style scoped lang="scss">
.file-card {
  background: var(--bg-card);
  border-radius: 12px;
  box-shadow: var(--shadow-card);
  overflow: hidden;
}

.card-header {
  padding: 16px 20px;
  border-bottom: 1px solid var(--border-subtle);
}

.card-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
}

.header-hint {
  margin-left: 0;
  font-size: 12px;
  color: var(--text-muted);
}

.header-right {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 14px;
}

.progress-toggle {
  margin-left: 0;
}

.card-body {
  padding: 20px;
}

.rename-section {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.path-item {
  width: 100%;
}

.path-label {
  display: block;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-secondary);
  margin-bottom: 8px;
}

.path-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.path-btn {
  padding: 0 12px;
}

.range-row {
  display: flex;
  align-items: center;
  gap: 18px;
  flex-wrap: wrap;
  padding: 12px 14px;
  background: var(--bg-base, #f7f8fa);
  border-radius: 8px;
}

.range-label {
  font-size: 13px;
  color: var(--text-secondary);
}

.sort-select {
  width: 120px;
}

.strategy-select {
  width: 130px;
}

.ext-filter {
  width: 180px;
}

.preview-block {
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  padding: 12px 14px;
}

.preview-head {
  font-size: 13px;
  color: var(--text-secondary);
  margin-bottom: 10px;

  b {
    color: var(--color-primary);
  }

  b.warn {
    color: var(--text-muted);
  }

  .conflict-text {
    color: #f56c6c;
  }

  .skip-text {
    color: #e6a23c;
  }
}

.preview-table {
  width: 100%;

  :deep(.row-conflict) {
    background: rgba(245, 108, 108, 0.10);
  }

  :deep(.row-skipped) {
    background: rgba(230, 162, 60, 0.10);
  }

  :deep(.row-unchanged) {
    opacity: 0.6;
  }

  :deep(.row-unselected) {
    opacity: 0.5;
  }

  :deep(.row-will-rename) {
    background: rgba(64, 158, 255, 0.12);

    .cell-name.willRename {
      color: var(--color-primary);
      font-weight: 700;
    }
  }

  :deep(.col-check .cell) {
    display: flex;
    justify-content: center;
  }
}

.preview-tools {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 4px;
}

.sel-text {
  color: var(--color-primary);
}

.cell-name {
  word-break: break-all;
  font-family: monospace;

  &.unchanged {
    color: var(--text-muted);
  }
}

.copy-btn-wrap {
  display: flex;
  justify-content: center;
  gap: 12px;
}

.apply-btn {
  padding: 10px 40px;
}

.progress-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 96px;
}

.progress-meta {
  font-size: 13px;
  color: var(--text-secondary);
}

.progress-current {
  font-size: 12px;
  color: var(--text-muted);
  word-break: break-all;
  max-height: 96px;
  overflow-y: auto;
  line-height: 1.6;
}
</style>

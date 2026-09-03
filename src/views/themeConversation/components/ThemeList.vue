<template>
  <aside class="theme-list">
    <!-- 头部 -->
    <div class="tl-header">
      <div class="tl-title">
        <LucideIcon name="MessagesSquare" :size="16" />
        <span>对话主题</span>
      </div>
      <div class="tl-header-actions">
        <button class="tl-clear" title="清空全部主题与对话数据" @click="onClearAll">
          <LucideIcon name="Trash" :size="16" />
        </button>
        <button class="tl-new" title="新建主题" @click="openCreate">
          <LucideIcon name="Plus" :size="16" />
        </button>
        <button class="tl-export" title="导出主题" @click="openExportDialog">
          <LucideIcon name="Download" :size="16" />
        </button>
      </div>
    </div>

    <!-- 主题列表（树形：父主题可折叠，子主题缩进） -->
    <div class="tl-body">
      <div
        v-for="row in flatThemeTree"
        :key="row.theme.id"
        class="tl-item"
        :class="{
          active: row.theme.id === currentThemeId,
          matched: isMatched(row.theme),
          child: row.depth > 0,
        }"
        :style="row.depth > 0 ? { marginLeft: row.depth * 16 + 'px' } : null"
        @click="selectTheme(row.theme.id)"
        @contextmenu.prevent="onContextMenu($event, row.theme)"
      >
        <!-- 上层：左=折叠箭头+主题名称，右=功能按钮 + 对话数量 -->
        <div class="tl-row-top">
          <div class="tl-name-wrap">
            <button
              v-if="row.hasChildren"
              class="tl-caret"
              :class="{ collapsed: row.collapsed }"
              title="展开 / 收起子主题"
              @click.stop="toggleCollapse(row.theme.id)"
            >
              <LucideIcon :name="row.collapsed ? 'ChevronRight' : 'ChevronDown'" :size="14" />
            </button>
            <span v-else class="tl-caret-ph"></span>
            <LucideIcon
              :name="row.depth > 0 ? 'CornerDownRight' : 'Hash'"
              :size="13"
              class="tl-hash"
              :class="{ child: row.depth > 0 }"
            />
            <span class="tl-name">{{ row.theme.title || '未命名主题' }}</span>
          </div>
          <div class="tl-right">
            <div class="tl-actions">
              <button
                class="tl-edit"
                title="修改主题"
                @click.stop="openEdit(row.theme)"
              >
                <LucideIcon name="Pencil" :size="14" />
              </button>
              <button
                class="tl-del"
                title="删除主题"
                @click.stop="removeTheme(row.theme)"
              >
                <LucideIcon name="Trash2" :size="14" />
              </button>
            </div>
            <span class="tl-count">{{ themeCounts[row.theme.id] || 0 }}</span>
          </div>
        </div>
        <!-- 下层：标签 -->
        <div class="tl-tags" v-if="parsedTags(row.theme).length">
          <TagChip
            v-for="tid in parsedTags(row.theme)"
            :key="tid"
            :id="tid"
          />
        </div>
      </div>

      <div class="tl-empty" v-if="!themes.length">还没有主题，点击右上角 + 创建</div>
    </div>

    <!-- 新建/编辑主题弹窗 -->
    <app-dialog
      v-model="dialogVisible"
      :title="editingId ? '编辑主题' : '新建主题'"
      width="420px"
      append-to-body
    >
      <div class="theme-form">
        <label class="form-label">主题标题</label>
        <el-input v-model="formTitle" placeholder="例如：关于产品方向的思考" maxlength="50" />

        <label class="form-label">主题标签</label>
        <TagSelector v-model="formTags" :scope="'theme'" />
      </div>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submit">确定</el-button>
      </template>
    </app-dialog>

    <!-- 主题右键上下文菜单：修改 / 删除 -->
    <Teleport to="body">
      <div
        v-if="ctxMenu.visible"
        class="tl-menu-backdrop"
        @click="closeCtxMenu"
        @contextmenu.prevent="closeCtxMenu"
      ></div>
      <div
        v-if="ctxMenu.visible"
        class="tl-context-menu"
        :style="{ left: ctxMenu.x + 'px', top: ctxMenu.y + 'px' }"
      >
        <button class="ctx-item" @click="ctxNewSub">
          <LucideIcon name="MessageSquarePlus" :size="14" />
          新增子主题
        </button>
        <button class="ctx-item" @click="ctxEdit">
          <LucideIcon name="Pencil" :size="14" />
          修改主题
        </button>
        <button class="ctx-item" @click="ctxExportAll">
          <LucideIcon name="Download" :size="14" />
          导出所有
        </button>
        <button class="ctx-item danger" @click="ctxDelete">
          <LucideIcon name="Trash2" :size="14" />
          删除主题
        </button>
      </div>
    </Teleport>

    <!-- 勾选导出主题弹窗 -->
    <ExportThemesDialog
      :visible="exportDialogVisible"
      @update:visible="exportDialogVisible = $event"
      @confirm="onExportConfirm"
    />
  </aside>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import LucideIcon from '@/components/LucideIcon.vue';
import TagChip from './TagChip.vue';
import TagSelector from './TagSelector.vue';
import ExportThemesDialog from './ExportThemesDialog.vue';
import { exportThemeToMarkdown, exportThemesToMarkdown } from '../utils/exportMarkdown';
import { fileNotify } from '@/utils/fileNotify';
import { storeToRefs } from 'pinia';
import useCacheSetStore from '@/store/useCacheSet';
import { useThemeConversation } from '../composables/useThemeConversation';

const {
  themes,
  themeCounts,
  currentThemeId,
  searchKeyword,
  selectTheme,
  createTheme,
  updateTheme,
  deleteTheme,
  clearAllData,
  parseArr,
  // 子主题：树形展示 + 折叠 + 创建
  flatThemeTree,
  toggleCollapse,
  openSubThemeDialog,
} = useThemeConversation();

// 文件缓存目录（设置项 fileCachePath，导出默认落盘到此）
const { fileCachePathC } = storeToRefs(useCacheSetStore());

const dialogVisible = ref(false);
const editingId = ref<number | null>(null);
const formTitle = ref('');
const formTags = ref<string[]>([]);

function parsedTags(theme: any): string[] {
  return parseArr(theme.tags);
}

/** 搜索状态下，标题命中关键字的主题高亮（标签命中由搜索结果体现） */
function isMatched(theme: any): boolean {
  const kw = searchKeyword.value.trim();
  if (!kw) return false;
  return !!(theme.title && theme.title.includes(kw));
}

function openCreate() {
  editingId.value = null;
  formTitle.value = '';
  formTags.value = [];
  dialogVisible.value = true;
}

/** 清空全部主题对话数据（对话 / 主题 / 标签），二次确认后执行 */
async function onClearAll() {
  try {
    await ElMessageBox.confirm(
      '将清空全部主题、对话以及标签数据，此操作不可恢复。确定继续？',
      '清空确认',
      { type: 'warning', confirmButtonText: '清空', cancelButtonText: '取消' }
    );
  } catch {
    return;
  }
  await clearAllData();
  ElMessage.success('已清空全部数据');
}

/** 打开编辑：用主题现有标题/标签预填表单 */
function openEdit(theme: any) {
  editingId.value = theme.id;
  formTitle.value = theme.title || '';
  formTags.value = parseArr(theme.tags);
  dialogVisible.value = true;
}

/** 右键上下文菜单：修改 / 删除主题 */
const ctxMenu = ref<{ visible: boolean; x: number; y: number; theme: any }>({
  visible: false,
  x: 0,
  y: 0,
  theme: null,
});

function onContextMenu(e: MouseEvent, theme: any) {
  // 简单防溢出：菜单宽约 160、高约 88，贴边时回退
  const x = Math.min(e.clientX, window.innerWidth - 170);
  const y = Math.min(e.clientY, window.innerHeight - 96);
  ctxMenu.value = { visible: true, x, y, theme };
}

function closeCtxMenu() {
  ctxMenu.value.visible = false;
}

function ctxEdit() {
  const t = ctxMenu.value.theme;
  closeCtxMenu();
  if (t) openEdit(t);
}

/** 右键「新增子主题」：切到该主题后打开子主题创建弹窗 */
async function ctxNewSub() {
  const t = ctxMenu.value.theme;
  closeCtxMenu();
  if (!t) return;
  if (currentThemeId.value !== t.id) await selectTheme(t.id);
  openSubThemeDialog([]);
}

function ctxDelete() {
  const t = ctxMenu.value.theme;
  closeCtxMenu();
  if (t) removeTheme(t);
}

/** 右键「导出所有」：导出该主题自身的全部对话为 Markdown（直接写入缓存目录，不弹窗） */
async function ctxExportAll() {
  const t = ctxMenu.value.theme;
  closeCtxMenu();
  if (!t) return;
  const res = await exportThemeToMarkdown(t, fileCachePathC.value);
  if (res?.success) fileNotify({ title: `已导出主题「${t.title || '未命名'}」`, filePath: res.path });
  else ElMessage.error(res?.message || '导出失败');
}

/** 勾选导出弹窗可见态 */
const exportDialogVisible = ref(false);

/** 头部「导出主题」按钮：打开勾选弹窗 */
function openExportDialog() {
  exportDialogVisible.value = true;
}

/** 弹窗确认：按勾选 id 映射主题对象，批量合并导出（直接写入缓存目录，不弹窗） */
async function onExportConfirm(ids: number[]) {
  const selected = themes.value.filter((t) => ids.includes(t.id));
  if (!selected.length) return;
  const res = await exportThemesToMarkdown(selected, fileCachePathC.value);
  if (res?.success) fileNotify({ title: `已导出 ${selected.length} 个主题`, filePath: res.path });
  else ElMessage.error(res?.message || '导出失败');
}

async function removeTheme(theme: any) {
  try {
    await ElMessageBox.confirm(
      `确定删除主题「${theme.title || '未命名'}」？其下全部对话也会一并删除。`,
      '删除确认',
      { type: 'warning' }
    );
  } catch {
    return;
  }
  try {
    await deleteTheme(theme.id);
    ElMessage.success('已删除');
  } catch (e: any) {
    // 删除保护：存在子主题时禁止删除父主题
    ElMessage.warning(e?.message || '删除失败');
  }
}

async function submit() {
  const title = formTitle.value.trim();
  if (!title) {
    ElMessage.warning('请输入主题标题');
    return;
  }
  if (editingId.value) {
    await updateTheme(editingId.value, { title, tags: formTags.value });
  } else {
    await createTheme(title, formTags.value);
  }
  dialogVisible.value = false;
  ElMessage.success('已保存');
}
</script>

<style scoped lang="scss">
.theme-list {
  width: 25%;
  max-width: 500px;
  flex-shrink: 0;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--bg-card);
  border-right: 1px solid var(--border-subtle);
  box-sizing: border-box;
}

.tl-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0px 16px 14px 16px;
  border-bottom: 1px solid var(--border-subtle);

  .tl-title {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 15px;
    font-weight: 600;
    color: var(--text-primary);

    :deep(.lucide-icon) {
      color: var(--color-primary);
    }
  }

  .tl-header-actions {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }

  .tl-new,
  .tl-clear,
  .tl-export {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border: none;
    border-radius: var(--radius-btn);
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    transition: background 0.2s, color 0.2s;
  }

  .tl-new:hover,
  .tl-export:hover {
    background: var(--color-primary-light);
    color: var(--color-primary);
  }

  /* 清空按钮：危险操作，hover 呈红色警示 */
  .tl-clear:hover {
    background: rgba(239, 68, 68, 0.1);
    color: var(--color-danger, #ef4444);
  }
}

.tl-body {
  flex: 1;
  overflow-y: auto;
  padding: 8px 24px 8px 0;
  display: flex;
  flex-direction: column;
  gap: 4px;

  &::-webkit-scrollbar { width: 4px; }
  &::-webkit-scrollbar-thumb { background: var(--scrollbar-thumb); border-radius: 2px; }
}

.tl-item {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border-radius: var(--radius-btn);
  cursor: pointer;
  border: 1px solid var(--border-subtle);
  background: var(--bg-base);
  transition: background 0.2s, border-color 0.2s;

  &:hover {
    background: var(--bg-hover);
    border-color: var(--color-primary-light);

    .tl-actions { opacity: 1; }
  }

  &.active {
    background: var(--color-primary-light);
    border-color: var(--color-primary);

    .tl-name { color: var(--color-primary-solid); font-weight: 600; }
  }

  &.matched {
    border-color: var(--color-primary);
    box-shadow: 0 0 0 1px var(--color-primary);
  }

  /* 子主题：左侧引导线 + 更紧凑 */
  &.child {
    border-left: 2px solid var(--color-primary-light);
    padding-left: 10px;
  }

  /* 上层：左=名称，右=数量 + 功能按钮 */
  .tl-row-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .tl-name-wrap {
    display: flex;
    align-items: center;
    gap: 4px;
    flex: 1;
    min-width: 0;

    /* 展开/收起箭头（仅含子主题的主题显示） */
    .tl-caret {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 18px;
      height: 18px;
      padding: 0;
      border: none;
      background: transparent;
      color: var(--text-muted);
      cursor: pointer;
      border-radius: 4px;
      flex-shrink: 0;
      transition: color 0.2s, background 0.2s;

      &:hover {
        background: var(--bg-hover);
        color: var(--text-primary);
      }

      &.collapsed { color: var(--color-primary); }
    }

    /* 无子主题时占位，保持名称对齐 */
    .tl-caret-ph {
      width: 18px;
      height: 18px;
      flex-shrink: 0;
    }

    .tl-hash { color: var(--text-muted); flex-shrink: 0; }

    /* 子主题图标：主题色弱化，区分于顶级主题 */
    .tl-hash.child { color: var(--color-primary); opacity: 0.75; }

    .tl-name {
      flex: 1;
      font-size: 14px;
      color: var(--text-primary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
  }

  .tl-right {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
  }

  .tl-count {
    font-size: 11px;
    color: var(--text-muted);
    background: var(--bg-active-btn);
    border-radius: 10px;
    padding: 0 7px;
    flex-shrink: 0;
  }

  /* 下层：标签 */
  .tl-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }

  .tl-actions {
    display: flex;
    align-items: center;
    gap: 2px;
    flex-shrink: 0;
    opacity: 0;
    transition: opacity 0.2s;
  }

  .tl-edit,
  .tl-del {
    border: none;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    padding: 2px;
    border-radius: 4px;
    transition: color 0.2s, background 0.2s;

    &:hover { background: var(--bg-hover); }
  }

  .tl-edit:hover { color: var(--color-primary); }
  .tl-del:hover { color: var(--color-danger, #ef4444); }
}

/* 主题右键上下文菜单 */
.tl-menu-backdrop {
  position: fixed;
  inset: 0;
  z-index: 2000;
}

.tl-context-menu {
  position: fixed;
  z-index: 2001;
  min-width: 150px;
  padding: 4px;
  background: var(--bg-card);
  border: 1px solid var(--border-subtle);
  border-radius: 10px;
  box-shadow: var(--shadow-card, 0 6px 24px rgba(0, 0, 0, 0.12));
  display: flex;
  flex-direction: column;
  gap: 2px;

  .ctx-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 10px;
    border: none;
    background: transparent;
    border-radius: 6px;
    font-size: 13px;
    color: var(--text-primary);
    cursor: pointer;
    text-align: left;
    transition: background 0.15s, color 0.15s;

    &:hover { background: var(--bg-hover); }
    &.danger { color: var(--color-danger, #ef4444); }
    &.danger:hover { background: rgba(239, 68, 68, 0.1); }
  }
}

.tl-empty {
  padding: 30px 16px;
  text-align: center;
  font-size: 13px;
  color: var(--text-muted);
  line-height: 1.6;
}

.theme-form {
  display: flex;
  flex-direction: column;
  gap: 10px;

  .form-label {
    font-size: 13px;
    color: var(--text-secondary);
    font-weight: 500;
  }
}
</style>

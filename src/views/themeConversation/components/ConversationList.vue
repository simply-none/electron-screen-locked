<template>
  <div class="conv-list">
    <!-- 置顶会话快捷区：固定置顶于列表顶部（位于滚动区之外），可折叠，点击跳转定位并高亮闪烁 -->
    <div class="pin-panel" v-if="!isSearching && pinnedConversations.length">
      <button class="pin-head" type="button" @click="togglePinPanel">
        <LucideIcon :name="pinnedExpanded ? 'ChevronDown' : 'ChevronRight'" :size="15" />
        <LucideIcon name="Pin" :size="13" />
        <span class="pin-head-title">置顶 ({{ pinnedConversations.length }})</span>
        <span class="pin-head-hint" v-if="!pinnedExpanded">点击展开</span>
      </button>
      <transition name="pin-fade">
        <div class="pin-list" v-show="pinnedExpanded">
          <button
            v-for="c in pinnedConversations"
            :key="c.id"
            class="pin-item"
            type="button"
            :title="snippetOf(c.content, 120)"
            @click="jumpTo(c)"
          >
            <LucideIcon name="Pin" :size="12" class="pin-item-ico" />
            <span class="pin-item-text">{{ snippetOf(c.content) }}</span>
            <span class="pin-item-time">{{ c.create_time }}</span>
          </button>
        </div>
      </transition>
    </div>

    <!-- 可滚动的对话列表区域 -->
    <div class="conv-scroll" ref="listRef">
      <!-- 搜索结果提示条 -->
      <div class="search-banner" v-if="isSearching">
        <LucideIcon name="Search" :size="14" />
        <span>搜索结果：{{ displayConversations.length }} 条对话</span>
        <button class="banner-clear" @click="clearSearch">退出搜索</button>
      </div>

      <!-- 空状态 -->
      <div class="empty-state" v-if="!displayConversations.length">
        <LucideIcon :name="isSearching ? 'SearchX' : 'MessageCircle'" :size="40" />
        <p v-if="isSearching">没有匹配的对话</p>
        <template v-else>
          <p>这个主题下还没有对话</p>
          <span>在下方输入框记录你的思考波动吧</span>
        </template>
      </div>

      <!-- 对话气泡列表 -->
      <div class="bubble-wrap" v-for="conv in displayConversations" :key="conv.id" :data-conv-id="conv.id">
        <!-- 多选勾选框：位于气泡外侧最左边 -->
        <label v-if="multiselect" class="sel-check" @click.stop>
          <input
            type="checkbox"
            :checked="selectedIds.includes(String(conv.id))"
            @change="toggleSelect(conv.id)"
          />
        </label>
        <ConversationBubble
          :conv="conv"
          :show-theme-title="isSearching"
          :theme-title="conv.theme_title"
          @edit="openEdit"
          @delete="removeConv"
          @open-references="showReferenceTargets"
          @open-referenced-by="showReferencedBy"
          @open-cross-referenced-by="showCrossReferencedBy"
          @quote="onQuote"
          @open-cross-ref="onOpenCrossRef"
          @contextmenu="onContextMenu"
        />
      </div>

      <!-- 编辑对话弹窗 -->
      <ConversationEditDialog
        v-model="editVisible"
        :conv="editingConv"
        @saved="onSaved"
      />
    </div>

    <!-- 底部操作条：多选入口 / 多选态下的批量引用 -->
    <div class="conv-footer">
      <template v-if="!multiselect">
        <button class="ms-btn" @click="toggleMultiselect" title="勾选多条对话批量引用">
          <LucideIcon name="CheckSquare" :size="15" />
          <span>多选</span>
        </button>
        <span class="ms-hint">可勾选多条对话，批量引用到新对话</span>
      </template>
      <template v-else>
        <span class="ms-count">已选 {{ selectedIds.length }} 条</span>
        <button
          class="ms-btn primary"
          :disabled="!selectedIds.length"
          @click="batchQuote"
        >
          <LucideIcon name="Link" :size="15" />
          <span>引用选中 ({{ selectedIds.length }})</span>
        </button>
        <button class="ms-btn" @click="openCrossRefPicker">
          <LucideIcon name="Layers" :size="15" />
          <span>跨主题引用</span>
        </button>
        <button
          class="ms-btn"
          :disabled="!selectedIds.length"
          @click="batchSubTheme"
        >
          <LucideIcon name="MessageSquarePlus" :size="15" />
          <span>新增子主题 ({{ selectedIds.length }})</span>
        </button>
        <button class="ms-btn" @click="toggleMultiselect">退出多选</button>
      </template>
    </div>

    <!-- 右键上下文菜单 -->
    <div
      v-if="ctxMenu.open"
      class="ctx-backdrop"
      @click="closeCtx"
      @contextmenu.prevent="closeCtx"
    ></div>
    <div
      v-if="ctxMenu.open"
      class="ctx-menu"
      :style="{ left: ctxMenu.x + 'px', top: ctxMenu.y + 'px' }"
    >
      <button class="ctx-item" @click="ctxQuote">
        <LucideIcon name="Link" :size="14" /> 引用此对话
      </button>
      <button class="ctx-item" @click="ctxTogglePin">
        <LucideIcon :name="ctxMenu.conv?.pinned === '1' ? 'PinOff' : 'Pin'" :size="14" />
        {{ ctxMenu.conv?.pinned === '1' ? '取消置顶' : '置顶' }}
      </button>
      <button class="ctx-item" @click="ctxCrossRef">
        <LucideIcon name="Layers" :size="14" /> 跨主题引用…
      </button>
      <button class="ctx-item" @click="ctxOutgoing">
        <LucideIcon name="ArrowUpRight" :size="14" /> 正向链接
      </button>
      <button class="ctx-item" @click="ctxBacklinks">
        <LucideIcon name="ArrowDownLeft" :size="14" /> 反向链接
      </button>
      <button class="ctx-item" @click="ctxSubTheme">
        <LucideIcon name="MessageSquarePlus" :size="14" /> 发起子主题…
      </button>
      <button class="ctx-item" @click="ctxEdit">
        <LucideIcon name="Pencil" :size="14" /> 编辑
      </button>
      <button class="ctx-item danger" @click="ctxDelete">
        <LucideIcon name="Trash2" :size="14" /> 删除
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import LucideIcon from '@/components/LucideIcon.vue';
import ConversationBubble from './ConversationBubble.vue';
import ConversationEditDialog from './ConversationEditDialog.vue';
import { useThemeConversation } from '../composables/useThemeConversation';
import { snippetOf } from '../composables/richText';

const {
  displayConversations,
  conversations,
  isSearching,
  clearSearch,
  deleteConversation,
  updateConversation,
  showReferenceTargets,
  showReferencedBy,
  showCrossReferencedBy,
  loadConversations,
  runSearch,
  currentThemeId,
  // 草稿引用 / 多选
  addPendingRef,
  addPendingRefs,
  multiselect,
  selectedIds,
  toggleMultiselect,
  toggleSelect,
  // 跨主题引用
  openCrossRefPicker,
  showCrossRefTargets,
  // 子主题：发起子主题弹窗（右键 / 多选共用）
  openSubThemeDialog,
  // 高亮定位（从引用弹窗跳转到对话项）
  locateConversation,
  highlightConvId,
  highlightTick,
} = useThemeConversation();

const listRef = ref<HTMLElement | null>(null);
const editVisible = ref(false);
const editingConv = ref<any>(null);

/** 右键菜单状态 */
const ctxMenu = ref<{ open: boolean; x: number; y: number; conv: any }>({
  open: false,
  x: 0,
  y: 0,
  conv: null,
});

/** 新对话时自动滚动到底部（聊天回溯体验） */
watch(
  () => displayConversations.value.length,
  async () => {
    if (!isSearching.value) {
      await nextTick();
      const el = listRef.value;
      if (el) el.scrollTop = el.scrollHeight;
    }
  }
);

/**
 * 从引用弹窗「定位」某条对话：监听 highlightTick，将中间列表滚动到目标项并高亮。
 * 用 setTimeout 延迟到列表 DOM 渲染完成（主题切换 / 退出搜索后需等待数据注入）再滚动。
 */
watch(
  highlightTick,
  async () => {
    const id = highlightConvId.value;
    if (id == null) return;
    await nextTick();
    setTimeout(() => {
      const root = listRef.value;
      if (!root) return;
      const el = root.querySelector(`.bubble-wrap[data-conv-id="${id}"]`);
      if (!el) return;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      // 强制重排以重启动画，然后加高亮类，2 秒后移除
      const node = el as HTMLElement;
      node.classList.remove('highlight');
      void node.offsetWidth;
      node.classList.add('highlight');
      setTimeout(() => node.classList.remove('highlight'), 3000);
    }, 80);
  }
);

function openEdit(conv: any) {
  editingConv.value = conv;
  editVisible.value = true;
}

/* ============================ 置顶会话快捷区 ============================ */

/** 置顶数量超过该阈值时，首次出现默认折叠，避免占用过多空间 */
const PIN_COLLAPSE_THRESHOLD = 1;

/** 当前主题下被置顶的对话（过滤 pinned === '1'） */
const pinnedConversations = computed(() =>
  conversations.value.filter((c: any) => c.pinned === '1'),
);

/** 置顶区折叠状态：首次出现较多置顶项时默认折叠，少量则默认展开 */
const pinnedExpanded = ref(true);
watch(
  () => pinnedConversations.value.length,
  (n, o) => {
    if (o === 0 && n > 0) pinnedExpanded.value = n <= PIN_COLLAPSE_THRESHOLD;
  },
);

function togglePinPanel() {
  pinnedExpanded.value = !pinnedExpanded.value;
}

/** 点击置顶项：跳转到主列表对应位置并高亮闪烁（复用 locateConversation + 既有高亮机制） */
function jumpTo(conv: any) {
  locateConversation(conv.id);
}

/** 切换某条对话的置顶状态 */
async function togglePin(conv: any) {
  await updateConversation(conv.id, { pinned: conv.pinned === '1' ? '0' : '1' });
}

async function removeConv(conv: any) {
  try {
    await ElMessageBox.confirm('确定删除这条对话？', '删除确认', { type: 'warning' });
  } catch {
    return;
  }
  await deleteConversation(conv.id);
  ElMessage.success('已删除');
}

/** 编辑保存后刷新：搜索态刷新结果，否则重载当前主题 */
async function onSaved() {
  if (isSearching.value) await runSearch();
  else if (currentThemeId.value) await loadConversations(currentThemeId.value);
}

/* ============================ 引用便捷操作 ============================ */

/** 气泡右下角「引用」按钮：直接把该对话加入输入框草稿引用 */
function onQuote(conv: any) {
  addPendingRef(conv.id);
  ElMessage.success('已引用该对话，发送新对话时会带上此引用');
}

/** 右键菜单：定位到光标处 */
function onContextMenu(payload: { conv: any; x: number; y: number }) {
  ctxMenu.value = { open: true, x: payload.x, y: payload.y, conv: payload.conv };
}

function closeCtx() {
  ctxMenu.value = { ...ctxMenu.value, open: false };
}

/** 右键「引用此对话」 */
function ctxQuote() {
  if (ctxMenu.value.conv) {
    addPendingRef(ctxMenu.value.conv.id);
    ElMessage.success('已引用该对话，发送新对话时会带上此引用');
  }
  closeCtx();
}

/** 右键「置顶 / 取消置顶」 */
async function ctxTogglePin() {
  if (ctxMenu.value.conv) await togglePin(ctxMenu.value.conv);
  closeCtx();
}

/** 右键「跨主题引用…」：打开跨主题引用选择弹窗 */
function ctxCrossRef() {
  openCrossRefPicker();
  closeCtx();
}

/** 右键「正向链接」：本对话跨主题引用了哪些对话（右侧抽屉展示目标） */
function ctxOutgoing() {
  if (ctxMenu.value.conv) showCrossRefTargets(ctxMenu.value.conv);
  closeCtx();
}

/** 右键「反向链接」：哪些对话跨主题引用了本对话（右侧抽屉展示来源） */
function ctxBacklinks() {
  if (ctxMenu.value.conv) showCrossReferencedBy(ctxMenu.value.conv);
  closeCtx();
}

/** 右键「发起子主题…」：以当前主题为父，把该对话预置为跨主题引用草稿 */
function ctxSubTheme() {
  const conv = ctxMenu.value.conv;
  if (conv && currentThemeId.value != null) {
    openSubThemeDialog([{ themeId: currentThemeId.value, convId: conv.id }]);
  }
  closeCtx();
}

/** 多选态：把选中的对话作为源，发起子主题（源对话预置为跨主题引用） */
function batchSubTheme() {
  if (!selectedIds.value.length || currentThemeId.value == null) return;
  openSubThemeDialog(
    selectedIds.value.map((id) => ({
      themeId: currentThemeId.value as number,
      convId: Number(id),
    })),
  );
  // 进入创建流程后退出多选模式（toggleMultiselect 关闭时会清空已选）
  toggleMultiselect();
}

/** 气泡中的跨主题引用 chip/flag：在右侧抽屉展示被引用的目标对话（ref 为空展示全部） */
function onOpenCrossRef(payload: { conv: any; ref: { themeId: number; convId: number } | null }) {
  showCrossRefTargets(payload.conv, payload.ref);
}

/** 右键「编辑」 */
function ctxEdit() {
  if (ctxMenu.value.conv) openEdit(ctxMenu.value.conv);
  closeCtx();
}

/** 右键「删除」 */
function ctxDelete() {
  if (ctxMenu.value.conv) removeConv(ctxMenu.value.conv);
  closeCtx();
}

/** 多选态：批量引用选中对话 */
function batchQuote() {
  if (!selectedIds.value.length) return;
  addPendingRefs(selectedIds.value.map(Number));
  ElMessage.success(`已引用 ${selectedIds.value.length} 条对话，发送新对话时会带上`);
  // 批量引入后退出多选模式（toggleMultiselect 关闭时会清空已选）
  toggleMultiselect();
}
</script>

<style scoped lang="scss">
.conv-list {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--bg-base);
}

.conv-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 14px;

  &::-webkit-scrollbar { width: 6px; }
  &::-webkit-scrollbar-thumb { background: var(--scrollbar-thumb); border-radius: 3px; }
}

.search-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  align-self: center;
  padding: 6px 14px;
  border-radius: 999px;
  background: var(--color-primary-light);
  color: var(--color-primary-solid);
  font-size: 13px;

  :deep(.lucide-icon) { color: var(--color-primary); }

  .banner-clear {
    border: none;
    background: transparent;
    color: var(--color-primary);
    cursor: pointer;
    font-size: 12px;
    text-decoration: underline;
    padding: 0 2px;
  }
}

.empty-state {
  margin: auto;
  text-align: center;
  color: var(--text-muted);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;

  :deep(.lucide-icon) { opacity: 0.5; }

  p { margin: 0; font-size: 14px; }
  span { font-size: 12px; opacity: 0.8; }
}

.bubble-wrap {
  display: flex;
  justify-content: flex-end;
  align-items: flex-start;
}

/* 多选勾选框：位于对话气泡外侧最左边 */
.sel-check {
  flex-shrink: 0;
  margin-top: 16px;
  margin-right: 4px;
  cursor: pointer;

  input {
    width: 16px;
    height: 16px;
    cursor: pointer;
    accent-color: var(--color-primary);
  }
}

/* 从引用弹窗「定位」时：高亮目标对话项，便于回溯（持续 5 秒闪烁） */
.bubble-wrap.highlight :deep(.conv-bubble) {
  /* 总时长约 5 秒，更从容 */
  animation: conv-blink 1s ease-in-out 3;
}

@keyframes conv-blink {
  0%, 100% {
    border-color: var(--color-primary) !important;
    box-shadow: 0 0 8px var(--color-primary-light); /* 稍微增大阴影扩散，更柔和 */
    /* 独有高亮背景：定位态使用专属强调底色，确保与引用/被引用等其它样式区分 */
    background: var(--conv-highlight-bg, rgba(59, 130, 246, 0.16)) !important;
  }
  50% {
    border-color: var(--border-subtle) !important;
    box-shadow: 0 0 0 0 transparent;
    background: var(--bg-card) !important;
  }
}

/* 底部操作条：多选入口 / 多选态批量引用 */
.conv-footer {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 16px;
  border-top: 1px solid var(--border-subtle);
  background: var(--bg-card);
  font-size: 13px;

  .ms-btn {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: 32px;
    padding: 0 12px;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-btn);
    background: var(--bg-base);
    color: var(--text-secondary);
    font-size: 13px;
    cursor: pointer;
    transition: all 0.2s;

    &:hover { border-color: var(--color-primary); color: var(--color-primary); }

    &.primary {
      background: var(--color-primary);
      border-color: var(--color-primary);
      color: #fff;
      &:hover { filter: brightness(1.05); color: #fff; }
      &:disabled { opacity: 0.5; cursor: not-allowed; }
    }
  }

  .ms-hint { color: var(--text-muted); font-size: 12px; }
  .ms-count { color: var(--text-secondary); }
}

/* ===================== 置顶会话快捷区 ===================== */
/* 注意：不要用 position: sticky —— 在 flex + overflow-y:auto 容器里
   sticky 的 flex item 会出现渲染塌缩/不可见。这里面板放在 .conv-scroll
   之外、作为 .conv-list 的直接子元素，天然固定在列表顶部，滚动时始终可见。 */
.pin-panel {
  flex-shrink: 0;
  margin: 12px 16px 0;
  border: 1px solid var(--color-primary);
  border-left: 3px solid var(--color-primary);
  border-radius: 12px;
  background: var(--bg-card);
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.10);
  overflow: hidden;
}

.pin-head {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  padding: 10px 12px;
  border: none;
  background: transparent;
  color: var(--color-primary);
  font-size: 13px;
  font-weight: 700;
  font-family: inherit;
  cursor: pointer;
  text-align: left;

  :deep(.lucide-icon) { color: var(--color-primary); }

  &:hover { background: var(--bg-hover); }

  .pin-head-title { flex: 1; }
  .pin-head-hint { font-size: 11px; font-weight: 400; color: var(--text-muted); }
}

.pin-list {
  display: flex;
  flex-direction: column;
  padding: 0 6px 6px;
  gap: 2px;
}

.pin-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 8px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--text-primary);
  font-size: 13px;
  font-family: inherit;
  cursor: pointer;
  text-align: left;
  transition: background 0.18s;

  &:hover { background: var(--bg-hover); }

  .pin-item-ico { color: var(--color-primary); flex-shrink: 0; }

  .pin-item-text {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-primary);
  }

  .pin-item-time {
    flex-shrink: 0;
    font-size: 11px;
    color: var(--text-muted);
  }
}

/* 折叠 / 展开过渡 */
.pin-fade-enter-active,
.pin-fade-leave-active {
  transition: opacity 0.2s ease;
}
.pin-fade-enter-from,
.pin-fade-leave-to {
  opacity: 0;
}

/* 右键上下文菜单 */
.ctx-backdrop {
  position: fixed;
  inset: 0;
  z-index: 2900;
}

.ctx-menu {
  position: fixed;
  z-index: 3000;
  min-width: 140px;
  padding: 6px;
  border-radius: 10px;
  background: var(--bg-card);
  border: 1px solid var(--border-subtle);
  box-shadow: var(--shadow-card);

  .ctx-item {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 7px 10px;
    border: none;
    background: transparent;
    color: var(--text-primary);
    font-size: 13px;
    border-radius: 6px;
    cursor: pointer;
    text-align: left;

    &:hover { background: var(--bg-hover); }
    &.danger { color: var(--color-danger, #ef4444); }
  }
}
</style>

<template>
  <layout-vue>
    <template #main>
      <div class="ebook-reader-page" :class="{ 'is-fullscreen': isFullscreen }" ref="readerPageRef">
        <!-- 顶部工具栏 -->
        <header class="reader-toolbar" v-show="settings.readerTopbarVisible">
          <div class="toolbar-left">
            <!-- 书架按钮：仅在阅读视图显示，点击切回书架视图 -->
            <el-button
              v-if="view === 'reader'"
              size="default"
              @click="view = 'bookshelf'"
            >
              <LucideIcon name="LibraryBig" :size="16" />
              书架
            </el-button>
            <!-- 打开文件按钮 -->
            <el-button type="primary" @click="openFile">
              <LucideIcon name="FolderOpen" :size="16" />
              打开文件
            </el-button>
            <!-- 一键传书按钮：与手机 App 书架「传书」对齐，多选后批量拉取/推送 epub、txt -->
            <el-button @click="bookTransferVisible = true">
              <LucideIcon name="ArrowLeftRight" :size="16" />
              传书
            </el-button>
            <!-- 当前文件名与格式徽标（仅阅读视图且已打开文件时显示） -->
            <div class="file-info" v-if="view === 'reader' && currentFile.format">
              <el-tag
                size="small"
                :type="currentFile.format === 'epub' ? 'warning' : currentFile.format === 'pdf' ? 'danger' : 'success'"
              >
                {{ currentFile.format.toUpperCase() }}
              </el-tag>
              <span class="file-name" :title="currentFile.title || currentFile.name">
                {{ currentFile.title || currentFile.name }}
              </span>
              <span
                v-if="currentFile.author"
                class="file-author"
                :title="currentFile.author"
              >
                {{ currentFile.author }}
              </span>
            </div>
          </div>

          <!-- 右侧阅读控制区：仅在阅读视图显示；窄屏可横向滚动（含鼠标滚轮映射） -->
          <div
            class="toolbar-right"
            v-if="view === 'reader'"
            ref="toolbarRightRef"
            @wheel="onToolbarRightWheel"
          >
            <!-- 目录按钮（epub / pdf 均可用） -->
            <el-button
              v-if="currentFile.format === 'epub' || currentFile.format === 'pdf'"
              size="small"
              @click="tocVisible = true"
            >
              <LucideIcon name="List" :size="16" />
              目录
            </el-button>
            <!-- 笔记按钮：打开笔记与划线抽屉，附带数量徽标 -->
            <el-badge
              :value="annotations.length"
              :hidden="annotations.length === 0"
              :max="99"
              type="primary"
            >
              <el-button size="small" @click="annotationDrawerVisible = true">
                <LucideIcon name="NotebookPen" :size="16" />
                笔记
              </el-button>
            </el-badge>
            <!-- 书签按钮（epub / pdf 均可用）：打开书签抽屉，附带数量徽标 -->
            <el-badge
              v-if="currentFile.format === 'epub' || currentFile.format === 'pdf'"
              :value="bookmarks.length"
              :hidden="bookmarks.length === 0"
              :max="99"
              type="warning"
            >
              <el-button size="small" @click="bookmarkDrawerVisible = true">
                <LucideIcon name="Bookmark" :size="16" />
                书签
              </el-button>
            </el-badge>
            <!-- 全文搜索按钮（epub / pdf 均可用）：打开搜索面板 -->
            <el-button
              v-if="currentFile.format === 'epub' || currentFile.format === 'pdf'"
              size="small"
              @click="searchPanelVisible = true"
            >
              <LucideIcon name="Search" :size="16" />
              搜索
            </el-button>
            <!-- 附件按钮（仅 PDF）：列出 PDF 内嵌的附件并可另存到本地 -->
            <el-button
              v-if="currentFile.format === 'pdf'"
              size="small"
              @click="openAttachments"
            >
              <LucideIcon name="Paperclip" :size="16" />
              附件
            </el-button>
            <!-- 更多阅读设置按钮：点击打开右侧弹窗（字体/字号/分栏/翻页模式/行距/页边距等） -->
            <el-button
              size="small"
              @click="settingsDrawerVisible = true"
              :title="'更多阅读设置'"
            >
              <LucideIcon name="Settings" :size="16" />
              设置
            </el-button>
            <!-- 全屏阅读按钮：进入/退出沉浸全屏 -->
            <el-button
              size="small"
              @click="toggleFullscreen"
              :title="isFullscreen ? '退出全屏' : '全屏阅读（沉浸模式）'"
            >
              <LucideIcon :name="isFullscreen ? 'Minimize2' : 'Maximize2'" :size="16" />
              {{ isFullscreen ? '退出全屏' : '全屏' }}
            </el-button>
          </div>
        </header>

        <!-- 当顶部栏隐藏时，显示浮动设置按钮以便重新打开设置抽屉 -->
        <transition name="fade">
          <el-button
            v-if="view === 'reader' && !settings.readerTopbarVisible"
            class="floating-settings-btn"
            size="small"
            circle
            @click="settingsDrawerVisible = true"
            title="设置"
          >
            <LucideIcon name="Settings" :size="16" />
          </el-button>
        </transition>

        <!-- 沉浸全屏时的浮动控制条：PDF 缩放 + 设置 + 退出全屏，统一在同一区域（工具栏已隐藏） -->
        <transition name="fade">
          <div
            v-if="isFullscreen"
            class="floating-fs-controls"
          >
            <!-- PDF 缩放（仅 PDF 格式、全屏时显示）：缩小 / 百分比（点击复位） / 放大 -->
            <template v-if="currentFile.format === 'pdf'">
              <el-button
                size="small"
                circle
                @click="readerRef?.zoomOut?.()"
                title="缩小"
              >
                <LucideIcon name="Minus" :size="16" />
              </el-button>
              <span
                class="fs-zoom-percent"
                title="点击复位到当前适应方式"
                @click="readerRef?.zoomReset?.()"
              >{{ readerRef?.scalePercent }}%</span>
              <el-button
                size="small"
                circle
                @click="readerRef?.zoomIn?.()"
                title="放大"
              >
                <LucideIcon name="Plus" :size="16" />
              </el-button>
              <span class="fs-divider"></span>
            </template>
            <!-- 笔记：打开笔记与划线抽屉，附带数量徽标（与顶部工具栏一致，常显） -->
            <el-badge
              :value="annotations.length"
              :hidden="annotations.length === 0"
              :max="99"
              type="primary"
            >
              <el-button
                size="small"
                circle
                @click="annotationDrawerVisible = true"
                title="笔记"
              >
                <LucideIcon name="NotebookPen" :size="16" />
              </el-button>
            </el-badge>
            <!-- 书签：打开书签抽屉，附带数量徽标（仅 epub / pdf 生效，与顶部工具栏一致） -->
            <el-badge
              v-if="currentFile.format === 'epub' || currentFile.format === 'pdf'"
              :value="bookmarks.length"
              :hidden="bookmarks.length === 0"
              :max="99"
              type="warning"
            >
              <el-button
                size="small"
                circle
                @click="bookmarkDrawerVisible = true"
                title="书签"
              >
                <LucideIcon name="Bookmark" :size="16" />
              </el-button>
            </el-badge>
            <el-button
              size="small"
              circle
              @click="settingsDrawerVisible = true"
              title="设置"
            >
              <LucideIcon name="Settings" :size="16" />
            </el-button>
            <el-button
              size="small"
              circle
              @click="toggleFullscreen"
              title="退出全屏"
            >
              <LucideIcon name="Minimize2" :size="16" />
            </el-button>
          </div>
        </transition>

        <!-- 内容区：根据 view 状态切换「书架视图」与「阅读视图」 -->
        <div class="reader-content">
          <!-- 书架视图（已抽为独立组件 Bookshelf）：卡片网格 + 徽标 + 笔记/导出，打开/删除/加入/导出由父组件处理 -->
          <Bookshelf
            v-if="view === 'bookshelf'"
            :items="filteredItems"
            :annotation-count-map="annotationCountMap"
            :categories="categories"
            :selected-category="selectedCategory"
            :search-keyword="searchKeyword"
            @open="openBook"
            @remove="removeBook"
            @add-external="addExternal"
            @add-folder="addFolder"
            @open-file="openFile"
            @open-annotations="openShelfAnnotations"
            @export="exportBook"
            @export-all="exportAll"
            @update:selected-category="onSelectCategory"
            @update:search-keyword="onSearchKeyword"
            @add-category="onAddCat"
            @delete-category="onDelCat"
            @update-category="onUpdateCat"
            @set-book-categories="onSetBookCats"
            @clear-all="clearAll"
          />

          <!-- 阅读视图：根据格式支持状态与是否打开文件动态切换显示 -->
          <template v-else>
            <!-- 优先级 1：unsupportedTip 非空时，显示不支持格式提示 -->
            <div v-if="unsupportedTip" class="empty-state">
              <el-empty :description="unsupportedTip" />
            </div>
            <!-- 优先级 2：当前文件格式支持时，显示动态阅读组件 -->
            <component
              v-else-if="readerComponent"
              :is="readerComponent"
              :key="currentFile.path"
              ref="readerRef"
              :file-path="currentFile.path"
              :content-hash="currentFile.contentHash"
              :font-size="settings.fontSize"
              :font-family="settings.fontFamily"
              :font-family-en="settings.fontFamilyEN"
              :theme="settings.theme"
              :bg-type="settings.bgType"
              :bg-color="settings.bgColor"
              :bg-image="settings.bgImage"
              :text-color="settings.textColor"
              :bottom-bar-visible="settings.readerBottomBarVisible && !isFullscreen"
              :edge-click-enabled="settings.edgeClickEnabled"
              :edge-click-percent="settings.edgeClickPercent"
              :wheel-page-enabled="settings.wheelPageEnabled"
              :wheel-page-sensitivity="settings.wheelPageSensitivity"
              :line-height="settings.lineHeight"
              :column-count="settings.columnCount"
              :scroll-mode="settings.scrollMode"
              :margin="settings.margin"
              v-bind="extraReaderProps"
              @progress-update="onProgressUpdate"
              @toc-loaded="onTocLoaded"
              @landmarks-loaded="onLandmarksLoaded"
              @current-href="onCurrentHref"
              @annotations-updated="onAnnotationsUpdated"
              @bookmarks-updated="onBookmarksUpdated"
              @search-results="onSearchResults"
              @searching="onSearching"
              @font-size-change="onFontSizeChange"
              @book-meta="onBookMeta"
            />
            <!-- 优先级 3：未打开文件时引导用户 -->
            <div v-else class="empty-state">
              <el-empty description="暂未打开任何电子书">
                <el-button type="primary" @click="openFile">
                  <LucideIcon name="FolderOpen" :size="16" />
                  打开文件
                </el-button>
              </el-empty>
            </div>
          </template>
        </div>

        <!-- 目录抽屉（仅 epub 有效），已抽为独立组件 TocDrawer -->
        <TocDrawer
          v-model="tocVisible"
          :items="tocItems"
          :landmarks="tocLandmarks"
          :current-href="currentFileHref"
          @select="onTocItemClick"
        />

        <!-- 笔记与划线抽屉（已抽为独立组件 AnnotationDrawer）：分「笔记」与「划线」，跳转/删除/导出/保存由父组件处理 -->
        <AnnotationDrawer
          v-model="annotationDrawerVisible"
          :items="annotations"
          :title="annotationDrawerTitle"
          @jump="onAnnotationClick"
          @delete="onAnnotationDelete"
          @delete-all="onDeleteAll"
          @export="exportCurrentAnnotations"
          @export-to-conversation="exportAnnotationsToConversation"
          @save-note="saveShelfNote"
        />

        <!-- 书签抽屉（已抽为独立组件 BookmarksDrawer）：跳转/删除由父组件处理 -->
        <BookmarksDrawer
          v-model="bookmarkDrawerVisible"
          :items="bookmarks"
          :current-cfi="currentFileCfi"
          @jump="onBookmarkClick"
          @delete="onBookmarkDelete"
        />

        <!-- 全文搜索面板（已抽为独立组件 SearchPanel）：检索/跳转由父组件处理 -->
        <SearchPanel
          v-model="searchPanelVisible"
          :results="searchResults"
          :searching="searching"
          :max-results="300"
          @search="onSearch"
          @jump="onSearchJump"
        />

        <!-- 附件抽屉（仅 PDF）：展示 PDF 内嵌附件，另存由父组件走主进程完成 -->
        <AttachmentsDrawer
          v-model="attachmentsDrawerVisible"
          :items="attachments"
          :loading="attachmentsLoading"
          @download="onAttachmentDownload"
        />

      <!-- 更多阅读设置抽屉（主题/排版/标注/翻页交互/界面），已抽为独立组件 SettingsDrawer -->
      <SettingsDrawer v-model="settingsDrawerVisible" :current-file="currentFile" />

      <!-- 一键传书弹窗（PC ↔ 手机）：扫描设备 → 选方向 → 勾选多本 → 批量传输，与移动端对齐 -->
      <BookTransferDialog
        v-model="bookTransferVisible"
        :books="ebookStore.bookshelf"
        @done="loadBookshelf"
      />
      </div>
    </template>
  </layout-vue>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { storeToRefs } from 'pinia';
import { ElMessage, ElMessageBox } from 'element-plus';
import LayoutVue from '@/components/layout.vue';
import LucideIcon from '@/components/LucideIcon.vue';
import useEbookReader from '@/store/useEbookReader';
import type { EbookTheme, EbookBgType, BookshelfItem } from '@/store/useEbookReader';
import TxtReader from './components/TxtReader.vue';
import EpubReader from './components/EpubReader.vue';
import PdfReader from './components/PdfReader.vue';
import SettingsDrawer from './components/SettingsDrawer.vue';
import TocDrawer from './components/TocDrawer.vue';
import AnnotationDrawer from './components/AnnotationDrawer.vue';
import BookmarksDrawer from './components/BookmarksDrawer.vue';
import BookTransferDialog from './components/BookTransferDialog.vue';
import SearchPanel from './components/SearchPanel.vue';
import Bookshelf from './components/Bookshelf.vue';
import AttachmentsDrawer from './components/AttachmentsDrawer.vue';
import { useBookshelf, handleExportResult } from './composables/useBookshelf';
// PDF 内嵌附件的读取/导出复用 PDF 工具箱已封装的 IPC（pdf:get-attachments / pdf:extract-attachment）
import { pdfApi } from '@/views/pdfTools/api/pdfApi';
import type { PdfAttachmentItem } from '@/views/pdfTools/types';
import { useThemeConversation } from '@/views/themeConversation/composables/useThemeConversation';
import { getFileName, getFormat } from './utils/fileUtils';
import type { TocItem, FlatTocItem, ReaderComponentInstance, AnnotationDisplayItem, EpubSearchResult } from './types';

// 电子书阅读器 store
const ebookStore = useEbookReader();
// 解构响应式状态：currentFile 当前文件、settings 设置
const { currentFile, settings } = storeToRefs(ebookStore);
// 解构 actions：setCurrentFile 设置当前文件、setProgress 设置进度、setFontSize 设置字号、
// setTheme 设置主题、setBgType/setBgColor/setBgImage/setTextColor 设置阅读区背景与文字色、
// loadBookshelf 加载书架、addToBookshelf 写入书架、setBookProgress/getBookProgress 按书进度映射
const {
  setCurrentFile,
  setProgress,
  setFontSize,
  loadBookshelf,
  loadCategories,
  addToBookshelf,
  setBookProgress,
  getBookProgress,
} = ebookStore;

// 书架功能 composable：抽取书架列表、徽标数量与打开/移除/加入/导出等操作
const {
  bookshelf,
  annotationCountMap,
  refreshCounts,
  openBook,
  removeBook,
  clearAll,
  addExternal,
  addFolder,
  exportBook,
  exportAll,
  // 分类相关状态与操作
  categories,
  selectedCategory,
  searchKeyword,
  filteredItems,
  addCategory,
  deleteCategory,
  updateCategory,
  setBookCategories,
} = useBookshelf({
  // 打开书时写入 store 并切换到阅读视图（复用统一的 loadFile 加载器）
  openBook: (item) => loadFile(item.path, item.name, item.format as 'txt' | 'epub'),
});

// 主题对话单例（与主题对话页面共享）：用于把笔记/划线导出为「主题=书名」下的对话
const {
  themes,
  selectTheme,
  createTheme,
  createConversation,
  loadThemes,
  getConversationsByTheme,
  deleteConversation,
} = useThemeConversation();

/** 分类筛选切换（null 表示全部） */
function onSelectCategory(v: number | null): void {
  selectedCategory.value = v;
}
/** 名称搜索关键词变化 */
function onSearchKeyword(v: string): void {
  searchKeyword.value = v;
}
/** 新增分类 */
function onAddCat(name: string): void {
  addCategory(name);
}
/** 删除分类 */
function onDelCat(id: number): void {
  deleteCategory(id);
}
/** 修改分类（名称 / 颜色） */
function onUpdateCat(p: { id: number; name?: string; color?: string | null }): void {
  updateCategory(p.id, p.name, p.color);
}
/** 设置某本书的分类 */
function onSetBookCats(p: { bookPath: string; categoryIds: number[] }): void {
  setBookCategories(p.bookPath, p.categoryIds);
}

/**
 * 当前视图状态
 * - 'bookshelf'：书架视图（默认），展示书架卡片网格
 * - 'reader'：阅读视图，展示阅读内容区
 */
const view = ref<'bookshelf' | 'reader'>('bookshelf');

/** 目录抽屉显示状态 */
const tocVisible = ref(false);
/** 目录项列表（由 EpubReader 通过 toc-loaded 事件回传） */
const tocItems = ref<TocItem[]>([]);
/** 目录地标列表（封面/正文/目录等，由 EpubReader 通过 landmarks-loaded 事件回传） */
const tocLandmarks = ref<any[]>([]);
/** 当前阅读位置的 href（由 EpubReader 通过 current-href 事件回传，用于目录高亮） */
const currentFileHref = ref('');
/** 子组件实例引用 */
const readerRef = ref<ReaderComponentInstance | null>(null);
/** 阅读页根元素引用：全屏功能作用于该元素 */
const readerPageRef = ref<HTMLElement | null>(null);
/** 顶部栏右侧功能区容器引用：用于挂载鼠标滚轮→横向滚动 */
const toolbarRightRef = ref<HTMLElement | null>(null);
/**
 * 沉浸全屏状态：
 * - true：阅读区进入全屏/沉浸模式（隐藏工具栏，内容撑满），浮动控制条可见
 * - false：普通阅读模式
 * 真实 OS 全屏（requestFullscreen）成功时由 fullscreenchange 事件同步；
 * 若环境不支持/拒绝真实全屏，则退化为仅隐藏工具栏的沉浸模式（本状态仍为 true）。
 */
const isFullscreen = ref(false);
/**
 * 不支持格式的提示文本
 * - 空字符串：不显示提示（正常打开文件或未打开文件状态）
 * - 非空字符串：在阅读内容区以 el-empty 形式展示该提示文本
 */
const unsupportedTip = ref('');

/**
 * 当前文件的笔记与划线列表（统一展示格式）
 * 由子组件通过 annotations-updated 事件回填，用于笔记抽屉展示
 */
const annotations = ref<AnnotationDisplayItem[]>([]);

/** 笔记抽屉显示状态 */
const annotationDrawerVisible = ref(false);

/** 当前文件的书签列表（由 EpubReader 通过 bookmarks-updated 事件回填，用于书签抽屉展示） */
const bookmarks = ref<BookmarkRecord[]>([]);

/** 书签抽屉显示状态 */
const bookmarkDrawerVisible = ref(false);

/** 当前阅读位置的 cfi（用于书签抽屉高亮当前书签，随进度更新回填） */
const currentFileCfi = ref('');

/** 全文搜索结果列表（由 EpubReader 通过 search-results 事件回填，用于搜索面板展示） */
const searchResults = ref<EpubSearchResult[]>([]);

/** 是否正在搜索（由 EpubReader 通过 searching 事件回填） */
const searching = ref(false);

/** 全文搜索面板显示状态 */
const searchPanelVisible = ref(false);

/** 附件抽屉显示状态（仅 PDF） */
const attachmentsDrawerVisible = ref(false);
/** PDF 内嵌附件列表（仅元信息：名称 / 类型 / 体积，字节在下载时由主进程直接写盘） */
const attachments = ref<PdfAttachmentItem[]>([]);
/** 是否正在读取附件列表 */
const attachmentsLoading = ref(false);

/** 笔记抽屉来源文件：null = 当前打开的书；string = 从书架打开的指定书路径 */
const annotationSourceFile = ref<string | null>(null);

/** 笔记抽屉标题：书架来源显示书名，否则显示默认标题 */
const annotationDrawerTitle = computed(() => {
  if (annotationSourceFile.value) {
    const book = bookshelf.value.find((b) => b.path === annotationSourceFile.value);
    return book ? `${book.name} · 笔记` : '笔记与划线';
  }
  return '笔记与划线';
});

/** 更多阅读设置抽屉显示状态 */
const settingsDrawerVisible = ref(false);
/** 一键传书弹窗可见性（工具栏「传书」按钮打开） */
const bookTransferVisible = ref(false);

/** 主题（预设）双向绑定：写入 store 并持久化 */

/** 根据文件格式动态计算渲染组件 */
const readerComponent = computed(() => {
  if (currentFile.value.format === 'txt') return TxtReader;
  if (currentFile.value.format === 'epub') return EpubReader;
  if (currentFile.value.format === 'pdf') return PdfReader;
  return null;
});

/**
 * 仅包含按格式区分的额外 props，避免把 PDF / EPUB 专用参数透传给 TxtReader。
 * 这些 props 在 TxtReader 中未声明，会作为 HTML attributes 落到根 div，
 * 可能干扰其 CSS 多列布局或首次渲染。
 */
const extraReaderProps = computed(() => {
  if (currentFile.value.format === 'epub') {
    return {
      letterSpacing: settings.value.letterSpacing,
      paragraphSpacing: settings.value.paragraphSpacing,
      firstLineIndent: settings.value.firstLineIndent,
    };
  }
  if (currentFile.value.format === 'pdf') {
    return {
      pdfFitMode: settings.value.pdfFitMode,
    };
  }
  return {};
});

/**
 * 加载电子书文件并切换到阅读视图
 * 统一处理：清空不支持格式提示 → 写入 store → 清除目录状态 → 写入书架记录 → 切换视图
 *
 * @param filePath - 文件绝对路径
 * @param name - 文件名（含扩展名）
 * @param format - 文件格式：'txt'、'epub' 或 'pdf'
 * @returns 无返回值
 */
async function loadFile(filePath: string, name: string, format: 'txt' | 'epub' | 'pdf') {
  // 清空不支持格式提示，避免上一次的提示残留
  unsupportedTip.value = '';
  // 计算文件内容哈希（内容身份）：用于换路径重新导入时复用标注/进度
  let contentHash = '';
  try {
    const hashRes = await window.ipcRenderer.ebook.computeFileHash(filePath);
    if (hashRes && hashRes.success && hashRes.hash) contentHash = hashRes.hash;
  } catch (err) {
    console.error('计算文件内容哈希失败：', err);
  }
  // 写入 store 的当前文件（同步持久化到本地存储）
  setCurrentFile({ path: filePath, name, format, contentHash });
  // 清除旧目录状态，避免上本书目录残留
  tocItems.value = [];
  tocVisible.value = false;
  // 清除上一本书的笔记列表，避免抽屉中残留旧数据
  annotations.value = [];
  annotationDrawerVisible.value = false;
  // 写入/更新书架记录：仅确保该书存在于书架并刷新 last_read_at。
  // percent 不再由全局 progress 覆盖——saveProgress 已保证 ebook_bookshelf.percent 与真实阅读进度同源，
  // 此处沿用该书已有的书架进度（existingItem.percent）即可，避免把全局 progress 误写进本书条目。
  // contentHash 一并写入，主进程据其把同内容、不同路径的遗留标注/进度关联到当前书。
  const existingItem = bookshelf.value.find((b) => b.path === filePath);
  addToBookshelf({
    path: filePath,
    name,
    format,
    percent: existingItem ? existingItem.percent : getBookProgress(filePath)?.percent || 0,
    lastReadAt: new Date().toISOString(),
    addedAt: new Date().toISOString(),
    contentHash,
  });
  // 切换到阅读视图
  view.value = 'reader';
}

/**
 * 打开文件选择对话框并加载选中的电子书
 * 调用项目既有的 get-file-list IPC（sendSync），不支持格式时弹出提示
 * 不支持格式时同步清空 currentFile 并在内容区以 el-empty 形式展示提示文本
 *
 * @returns 无返回值
 */
/**
 * 顶部栏右侧功能区的鼠标滚轮处理：将纵向滚轮映射为横向滚动，
 * 便于小屏幕下用普通鼠标滚动查看被裁切的「目录/笔记/字体/字号/设置」。
 * 仅当容器确实存在横向溢出时生效；到达左/右边缘时让出默认行为，避免卡死页面滚动。
 *
 * @param e - 滚轮事件对象
 * @returns 无返回值
 */
function onToolbarRightWheel(e: WheelEvent) {
  const el = toolbarRightRef.value;
  if (!el) return;
  // 不存在横向溢出时不拦截，保持原生行为
  if (el.scrollWidth <= el.clientWidth) return;

  // 优先取纵向滚轮 deltaY；若已携带横向意图（如触控板）则取 deltaX
  const delta = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
  if (delta === 0) return;

  const atStart = el.scrollLeft <= 0;
  const atEnd = el.scrollLeft + el.clientWidth >= el.scrollWidth - 1;
  // 已到边缘：不拦截，让页面/外层正常滚动
  if ((delta < 0 && atStart) || (delta > 0 && atEnd)) return;

  // 仅在确能横向滚动时阻止默认，避免无谓拦截纵向页面滚动
  e.preventDefault();
  el.scrollLeft += delta;
}

/**
 * 切换阅读区全屏（沉浸模式）
 * - 进入：调用真实 Fullscreen API 让阅读页撑满整屏；
 *   若环境不支持或被拒绝，则退化为「仅隐藏工具栏」的沉浸模式（isFullscreen 仍为 true）。
 * - 退出：若存在真实全屏则退出，否则仅关闭沉浸模式。
 * 工具栏与浮动设置按钮在 .is-fullscreen 下隐藏，由右上角浮动控制条提供「设置 / 退出全屏」。
 */
function toggleFullscreen() {
  if (isFullscreen.value) {
    isFullscreen.value = false;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    }
    return;
  }
  isFullscreen.value = true;
  const el = readerPageRef.value;
  const req = el?.requestFullscreen?.();
  if (req && typeof (req as Promise<void>).then === 'function') {
    (req as Promise<void>).catch(() => {
      // 真实全屏失败：保持 isFullscreen=true 的沉浸模式（已隐藏工具栏），不报错
    });
  }
}

/** 监听 document 全屏变化（如用户按 ESC 退出），同步 isFullscreen 状态 */
function onFsChange() {
  const el = readerPageRef.value;
  isFullscreen.value = !!el && document.fullscreenElement === el;
}

function openFile() {
  // 每次点击「打开文件」时重置不支持格式提示，避免上一次的提示残留
  unsupportedTip.value = '';
  // 调用主进程文件选择对话框：openFile 表示选择文件，type: ['file'] 表示所有文件
  const result = window.ipcRenderer.sendSync('get-file-list', {
    openFile: true,
    type: ['file'],
  });
  // 用户取消选择或未选中文件
  if (!result || !Array.isArray(result) || result.length === 0) return;

  const filePath = result[0];
  const fileName = getFileName(filePath);
  const format = getFormat(fileName);

  // 不支持的格式（含 .mobi 等）提示用户
  if (!format) {
    // 保留 ElMessage 作为即时反馈
    ElMessage.warning('暂不支持该格式（当前支持 txt、epub、pdf）');
    // 在阅读内容区以 el-empty 形式展示提示文本
    unsupportedTip.value = '暂不支持该格式（当前支持 txt、epub、pdf）';
    // 清空 currentFile，避免显示阅读器组件
    setCurrentFile({ path: '', name: '', format: '' });
    // 同步清除目录状态
    tocItems.value = [];
    tocVisible.value = false;
    // 同步清除笔记列表与抽屉状态
    annotations.value = [];
    annotationDrawerVisible.value = false;
    // 切换到阅读视图以展示提示
    view.value = 'reader';
    return;
  }

  // 调用统一的 loadFile 方法：写入 store、加入书架、切换到阅读视图
  loadFile(filePath, fileName, format);
}

/**
 * 子组件进度更新事件处理
 * 同步到 store 并通过 IPC 持久化到数据库
 * 同时按 500ms 节流刷新书架进度（addToBookshelf）
 *
 * @param payload - 进度数据，包含 cfi 定位与百分比
 * @returns 无返回值
 */
async function onProgressUpdate(payload: { cfi: string; percent: number; filePath?: string }) {
  // 更新当前阅读位置 cfi（供书签抽屉高亮当前书签）
  currentFileCfi.value = payload.cfi;
  // 进度持久化的目标文件：优先用子组件随进度带回的 filePath（组件卸载/切换时仍能指向正确的书）
  const savePath = payload.filePath || currentFile.value.path;
  if (!savePath) return;
  const sameBook = savePath === currentFile.value.path;
  // 同步写入「每本书独立进度映射」（本地存储，同步落库）——这是进程退出时 IPC 来不及落库的最终兜底
  setBookProgress(savePath, { cfi: payload.cfi, percent: payload.percent });
  // 更新全局 progress（兼容旧逻辑）
  setProgress(payload);
  // 立即同步书架内存条目的 percent，保证 UI 实时反映真实进度（saveProgress 已负责把书架表 percent 与进度同源落库）
  const idx = bookshelf.value.findIndex((b) => b.path === savePath);
  if (idx >= 0) {
    const list = bookshelf.value.slice();
    list[idx] = { ...list[idx], percent: payload.percent, lastReadAt: new Date().toISOString() };
    bookshelf.value = list;
  }
  // 通过 IPC 持久化到数据库（ebook_progress + 同步 bookshelf.percent，二者同源）
  try {
    await window.ipcRenderer.ebook.saveProgress({
      filePath: savePath,
      format: currentFile.value.format,
      cfi: payload.cfi,
      percent: payload.percent,
      name: currentFile.value.name,
      contentHash: currentFile.value.contentHash || '',
    });
  } catch (err) {
    // 持久化失败不影响阅读，仅打印日志（本地映射已兜底）
    console.error('保存阅读进度失败', err);
  }
}

/**
 * EpubReader 目录加载完成事件处理
 *
 * @param items - 目录项数组
 * @returns 无返回值
 */
function onTocLoaded(items: TocItem[]) {
  tocItems.value = items || [];
}

/**
 * EpubReader 目录地标加载完成事件处理
 *
 * @param items - 地标项数组（封面/正文/目录等）
 * @returns 无返回值
 */
function onLandmarksLoaded(items: any[]) {
  tocLandmarks.value = Array.isArray(items) ? items : [];
}

/**
 * EpubReader 当前阅读位置 href 变更事件处理（用于目录高亮）
 *
 * @param href - 当前章节 href
 * @returns 无返回值
 */
function onCurrentHref(href: string) {
  currentFileHref.value = href || '';
}

/**
 * 目录项点击事件处理
 * 调用 EpubReader 暴露的 displayTarget 方法跳转
 *
 * @param item - 被点击的目录项
 * @returns 无返回值
 */
function onTocItemClick(item: FlatTocItem) {
  if (currentFile.value.format === 'epub' && readerRef.value?.displayTarget) {
    readerRef.value.displayTarget(item.href);
  } else if (currentFile.value.format === 'pdf' && readerRef.value?.goToTocPage) {
    // PDF 目录项 href 形如 "page:N"，解析页码后跳转
    const m = /^page:(\d+)$/.exec(item.href || '');
    if (m) readerRef.value.goToTocPage(Number(m[1]));
  }
  tocVisible.value = false;
}

/**
 * 子组件标注列表变更事件处理
 * 接收 EpubAnnotation[] 或 TxtAnnotation[]，统一映射为 AnnotationDisplayItem[]
 * - epub 项有 anchor 字段（cfiRange），直接使用
 * - txt 项无 anchor 但有 start/end，组合为 "start-end" 作为锚点
 *
 * @param items - 子组件 emit 的标注 payload，可能是 EpubAnnotation[] 或 TxtAnnotation[]
 * @returns 无返回值；payload 非数组时清空当前列表
 */
function onAnnotationsUpdated(items: any[]) {
  if (!Array.isArray(items)) {
    annotations.value = [];
    return;
  }
  annotations.value = items.map((item) => ({
    id: item.id,
    anchor: item.anchor ?? `${item.start}-${item.end}`,
    text: item.text ?? '',
    note: item.note ?? '',
    createdAt: item.createdAt ?? '',
    updatedAt: item.updatedAt ?? '',
  }));
}

/**
 * EpubReader 书签列表变更事件处理
 * 接收 BookmarkRecord[]，直接回填到父组件书签列表用于抽屉展示
 *
 * @param items - 子组件 emit 的书签 payload
 * @returns 无返回值；payload 非数组时清空当前列表
 */
function onBookmarksUpdated(items: BookmarkRecord[]) {
  bookmarks.value = Array.isArray(items) ? items : [];
}

/**
 * 书签抽屉项点击事件处理
 * 调用子组件暴露的 jumpToBookmark 方法跳转到书签位置，并关闭抽屉
 *
 * @param item - 被点击的书签项
 * @returns 无返回值
 */
function onBookmarkClick(item: BookmarkRecord) {
  readerRef.value?.jumpToBookmark?.(item.cfi);
  bookmarkDrawerVisible.value = false;
}

/**
 * 书签抽屉项删除事件处理
 * 弹出确认框，确认后调用子组件暴露的 removeBookmark 删除对应书签，并同步父组件列表
 *
 * @param item - 待删除的书签项
 * @returns 无返回值；用户取消时不做任何操作
 */
async function onBookmarkDelete(item: BookmarkRecord) {
  try {
    await ElMessageBox.confirm('确认删除该书签？', '提示', {
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      type: 'warning',
    });
  } catch {
    return;
  }
  readerRef.value?.removeBookmark?.(item.id);
  bookmarks.value = bookmarks.value.filter((b) => b.id !== item.id);
  ElMessage.success('已删除书签');
}

/**
 * EpubReader 全文搜索结果变更事件处理
 * 接收 EpubSearchResult[]，直接回填到父组件搜索结果列表用于搜索面板展示
 *
 * @param items - 子组件 emit 的搜索命中 payload
 * @returns 无返回值
 */
function onSearchResults(items: EpubSearchResult[]) {
  searchResults.value = Array.isArray(items) ? items : [];
}

/**
 * EpubReader 搜索进行中状态变更事件处理
 *
 * @param val - 是否正在搜索
 * @returns 无返回值
 */
function onSearching(val: boolean) {
  searching.value = val;
}

/**
 * 搜索面板触发搜索
 * 转发关键词到子组件暴露的 runSearch 方法（子组件遍历 spine 检索并回传结果）
 *
 * @param term - 搜索关键词
 * @returns 无返回值
 */
function onSearch(term: string) {
  readerRef.value?.runSearch?.(term);
}

/**
 * 搜索面板点击命中项
 * 调用子组件暴露的 jumpToSearchResult 方法跳转并关闭搜索面板
 *
 * @param item - 被点击的搜索命中项
 * @returns 无返回值
 */
function onSearchJump(item: EpubSearchResult) {
  readerRef.value?.jumpToSearchResult?.(item.cfi);
  searchPanelVisible.value = false;
}

/**
 * 打开附件抽屉并读取当前 PDF 的内嵌附件列表
 * 列表只含元信息（名称 / 类型 / 体积），避免把可能很大的附件字节全量送过 IPC；
 * 真正的提取在用户点击「另存」时由主进程直接写盘（pdf:extract-attachment）。
 *
 * @returns 无返回值
 */
async function openAttachments(): Promise<void> {
  const path = currentFile.value.path;
  if (!path) return;
  attachmentsDrawerVisible.value = true;
  attachmentsLoading.value = true;
  try {
    const res = await pdfApi.getAttachments(path);
    if (!res?.success) {
      ElMessage.error(`读取附件失败：${res?.error || '未知错误'}`);
      attachments.value = [];
      return;
    }
    attachments.value = res.attachments || [];
  } catch (err) {
    console.error('读取附件异常', err);
    attachments.value = [];
  } finally {
    attachmentsLoading.value = false;
  }
}

/**
 * 另存指定附件到本地：先弹保存对话框，再由主进程从 PDF 中提取并写盘
 * 按列表序号定位附件（而非文件名），避免同名附件产生歧义。
 *
 * @param index - 附件在 attachments 列表中的序号
 * @returns 无返回值
 */
async function onAttachmentDownload(index: number): Promise<void> {
  const item = attachments.value[index];
  const path = currentFile.value.path;
  if (!item || !path) return;
  const save = await pdfApi.pickSave(item.name || '附件');
  if (!save?.success || !save.filePath) return;
  try {
    const res = await pdfApi.extractAttachment(path, index, save.filePath);
    if (!res?.success) {
      ElMessage.error(`导出失败：${res?.error || '未知错误'}`);
      return;
    }
    ElMessage.success(`已保存到 ${save.filePath}`);
  } catch (err) {
    console.error('导出附件异常', err);
    ElMessage.error('导出附件失败');
  }
}

/**
 * 阅读区内 A-/A+ 字号快捷调整
 * 接收目标字号并写入 store 持久化（store 变化会同步 props.fontSize → 子组件自动重排）
 *
 * @param size - 目标字号 px
 * @returns 无返回值
 */
function onFontSizeChange(size: number) {
  setFontSize(size);
}

/**
 * 书籍基本信息事件处理（由 EpubReader / PdfReader 解析后回传）
 * 更新当前文件（标题/作者/封面，持久化到 localStorage，下次启动直接恢复），
 * 并异步落库（供书架列表秒出），同时同步本地书架卡片，避免下次重进才刷新。
 *
 * @param payload - { title, author, cover }，空串表示无对应信息（UI 回退文件名）
 * @returns 无返回值
 */
function onBookMeta(payload: { title: string; author: string; cover: string }) {
  const path = currentFile.value.path;
  if (!path) return;
  // 更新当前文件并持久化（title/author/cover 带则覆盖，空串保留原值）
  setCurrentFile({
    path,
    name: currentFile.value.name,
    format: currentFile.value.format,
    contentHash: currentFile.value.contentHash,
    title: payload.title || currentFile.value.title,
    author: payload.author || currentFile.value.author,
    cover: payload.cover || currentFile.value.cover,
  });
  // 落库（供书架秒出），失败不影响阅读
  window.ipcRenderer.ebook
    .saveBookMeta({
      filePath: path,
      name: currentFile.value.name,
      format: currentFile.value.format,
      title: payload.title,
      author: payload.author,
      cover: payload.cover,
      contentHash: currentFile.value.contentHash || '',
    })
    .catch((err: any) => console.error('保存书籍基本信息失败', err));
  // 同步本地书架卡片（无需重新 loadBookshelf）
  const idx = ebookStore.bookshelf.findIndex((b) => b.path === path);
  if (idx >= 0) {
    const list = ebookStore.bookshelf.slice();
    list[idx] = {
      ...list[idx],
      title: payload.title || list[idx].title,
      author: payload.author || list[idx].author,
      cover: payload.cover || list[idx].cover,
    };
    ebookStore.bookshelf = list;
  }
}

/**
 * 笔记抽屉项点击事件处理
 * 调用子组件暴露的 jumpToAnnotation 方法跳转到划线位置，并关闭抽屉
 *
 * @param item - 被点击的笔记项
 * @returns 无返回值
 */
function onAnnotationClick(item: AnnotationDisplayItem) {
  if (annotationSourceFile.value) {
    // 书架来源：书尚未打开，点击条目先打开该书（阅读位置由保存的进度恢复）
    const book = bookshelf.value.find((b) => b.path === annotationSourceFile.value);
    annotationDrawerVisible.value = false;
    annotationSourceFile.value = null;
    if (book) {
      openBook(book);
    }
    return;
  }
  readerRef.value?.jumpToAnnotation?.(item.anchor, item.id);
  annotationDrawerVisible.value = false;
}

/**
 * 笔记抽屉项删除事件处理
 * 弹出确认框，确认后调用 IPC 删除数据库记录，成功后同步移除子组件本地高亮与父组件展示列表
 *
 * @param item - 待删除的笔记项
 * @returns 无返回值；用户取消时不做任何操作
 */
async function onAnnotationDelete(item: AnnotationDisplayItem) {
  try {
    await ElMessageBox.confirm('确认删除该划线？', '提示', {
      confirmButtonText: '确定',
      cancelButtonText: '取消',
      type: 'warning',
    });
    const res = await window.ipcRenderer.ebook.removeAnnotation(item.id);
    if (!res?.success) {
      ElMessage.error(`删除失败：${res?.error || '未知错误'}`);
      return;
    }
    // 同步子组件本地高亮渲染，避免删除后高亮残留
    readerRef.value?.removeAnnotationById?.(item.id);
    // 更新父组件展示列表（子组件 removeAnnotationById 会 emit annotations-updated，
    // 但为保险起见此处也直接同步父组件列表）
    annotations.value = annotations.value.filter((a) => a.id !== item.id);
    ElMessage.success('已删除划线');
    // 刷新书架卡片上的笔记/划线数量徽标
    refreshCounts();
  } catch (err) {
    // 用户点击取消时 ElMessageBox.reject 抛出 'cancel'，此处统一忽略
    // 真正的异常（如 IPC 调用失败）已在上方 try 中通过 ElMessage.error 提示
    if (err !== 'cancel' && err !== 'close') {
      console.error('删除划线异常', err);
    }
  }
}

/**
 * 一键删除当前标签页全部（笔记或划线）
 * 调用批量 IPC 删除数据库记录，成功后同步移除子组件本地高亮与父组件展示列表
 *
 * @param scope - 'note' 仅删笔记（note 非空）；'highlight' 仅删划线（note 为空）
 * @returns 无返回值；用户取消时不做任何操作
 */
async function onDeleteAll(scope: 'note' | 'highlight'): Promise<void> {
  const isNote = scope === 'note';
  const targetFile = annotationSourceFile.value || currentFile.value.path;
  if (!targetFile) return;

  // 当前列表中属于该范围的项（用于本地高亮清理与列表同步）
  const matched = annotations.value.filter((a) =>
    isNote ? (a.note || '').trim().length > 0 : !(a.note || '').trim()
  );
  if (matched.length === 0) return;

  try {
    await ElMessageBox.confirm(
      isNote ? '确认删除全部笔记吗？此操作不可恢复。' : '确认删除全部划线吗？此操作不可恢复。',
      '提示',
      {
        confirmButtonText: '删除',
        cancelButtonText: '取消',
        type: 'warning',
      }
    );
  } catch {
    return;
  }

  try {
    // 以内容身份（content_hash）命中共享标注：多副本共用同一内容的标注，删除覆盖全部副本
    const hash =
      (bookshelf.value.find((b) => b.path === targetFile)?.contentHash as string | undefined) ||
      currentFile.value.contentHash ||
      '';
    const res = await window.ipcRenderer.ebook.removeAnnotations({ filePath: targetFile, scope, contentHash: hash });
    if (!res?.success) {
      ElMessage.error(`删除失败：${res?.error || '未知错误'}`);
      return;
    }
    // 同步父组件展示列表（移除该范围内的全部项）
    annotations.value = annotations.value.filter((a) =>
      isNote ? !(a.note || '').trim() : (a.note || '').trim()
    );
    // 若当前书已打开（非书架来源），重新加载阅读组件本地高亮，清掉页面上的划线/笔记层
    if (!annotationSourceFile.value) {
      readerRef.value?.loadAnnotations?.(currentFile.value.path);
    }
    ElMessage.success(isNote ? '已删除全部笔记' : '已删除全部划线');
    // 刷新书架卡片上的笔记/划线数量徽标
    refreshCounts();
  } catch (err) {
    console.error('一键删除异常', err);
    ElMessage.error('删除失败，请重试');
  }
}

/**
 * 从书架打开某本书的笔记抽屉（不打开书本体）
 * 加载该书的笔记与划线到抽屉展示，并标记来源文件
 *
 * @param item - 书架条目
 * @returns 无返回值
 */
async function openShelfAnnotations(item: BookshelfItem): Promise<void> {
  annotationSourceFile.value = item.path;
  const res = await window.ipcRenderer.ebook.getAnnotations(item.path, item.contentHash || '');
  if (res?.success) {
    annotations.value = (res.data || []).map((r) => ({
      id: r.id,
      anchor: r.anchor,
      text: r.text,
      note: r.note || '',
      createdAt: r.created_at || '',
      updatedAt: r.updated_at || '',
    }));
  } else {
    annotations.value = [];
  }
  annotationDrawerVisible.value = true;
}

/**
 * 导出当前笔记抽屉所查看的书（书架来源则导出该书，否则导出当前打开的书）
 *
 * @returns 无返回值
 */
async function exportCurrentAnnotations(): Promise<void> {
  if (annotationSourceFile.value) {
    const book = bookshelf.value.find((b) => b.path === annotationSourceFile.value);
    // 书名去掉扩展名（"笔记与划线"由后端分区标题体现，无需塞进标题）
    const title = book?.name?.replace(/\.[^.]+$/, '') || '电子书';
    const res = await window.ipcRenderer.ebook.exportAnnotations({
      filePath: annotationSourceFile.value,
      title,
      contentHash: book?.contentHash || '',
    });
    handleExportResult(res);
  } else if (currentFile.value.path) {
    const title = currentFile.value.name.replace(/\.[^.]+$/, '');
    const res = await window.ipcRenderer.ebook.exportAnnotations({
      filePath: currentFile.value.path,
      title,
      contentHash: currentFile.value.contentHash || '',
    });
    handleExportResult(res);
  }
}

/**
 * 将当前抽屉里的全部笔记/划线导出到「主题对话」：
 * - 主题名 = 书名（去扩展名）；每条标注生成一条对话。
 * - 对话内容：划分线原文在前、笔记在后，分别用【划线】【笔记】标注，不附带引用。
 * - 若已存在同名主题，弹窗询问「覆盖」（清空该主题旧对话后写入）或「追加」（取消则保留旧对话并追加）。
 */
async function exportAnnotationsToConversation(): Promise<void> {
  if (!annotations.value.length) {
    ElMessage.warning('当前没有可导出的笔记或划线');
    return;
  }
  // 取书名（去掉扩展名）；书架来源用书架书名，否则用当前文件标题/名称
  let bookTitle = '电子书';
  if (annotationSourceFile.value) {
    const book = bookshelf.value.find((b) => b.path === annotationSourceFile.value);
    bookTitle = book?.name?.replace(/\.[^.]+$/, '') || '电子书';
  } else if (currentFile.value.title || currentFile.value.name) {
    bookTitle = (currentFile.value.title || currentFile.value.name).replace(/\.[^.]+$/, '');
  }

  await loadThemes();
  const existing = themes.value.find((t: any) => t.title === bookTitle);

  if (existing) {
    try {
      await ElMessageBox.confirm(
        `已存在同名主题「${bookTitle}」，是否覆盖其全部对话？（取消则追加到该主题）`,
        '导出到主题对话',
        { confirmButtonText: '覆盖', cancelButtonText: '追加', type: 'warning' }
      );
      // 覆盖：先清空该主题现有对话，再写入
      const oldConvs = await getConversationsByTheme(existing.id);
      for (const c of oldConvs) {
        await deleteConversation(c.id);
      }
      await selectTheme(existing.id);
    } catch {
      // 用户点「追加」或关闭弹窗：保留旧对话，追加到已有主题
      await selectTheme(existing.id);
    }
  } else {
    await createTheme(bookTitle);
  }

  let count = 0;
  for (const a of annotations.value) {
    const text = (a.text || '').trim();
    const note = (a.note || '').trim();
    let content = text ? `【划线】${text}` : '';
    if (note) content += (content ? '\n' : '') + `【笔记】${note}`;
    if (!content) continue;
    await createConversation({ content });
    count += 1;
  }

  ElMessage.success(`已导出 ${count} 条到主题「${bookTitle}」`);
}

/**
 * 保存笔记编辑（由 AnnotationDrawer 的 save-note 事件触发，调用 updateAnnotation IPC）
 *
 * @param payload - { id: 标注 id, text: 笔记内容 }
 * @returns 无返回值
 */
async function saveShelfNote(payload: { id: number; text: string }): Promise<void> {
  const { id, text } = payload;
  try {
    const res = await window.ipcRenderer.ebook.updateAnnotation({
      id,
      note: text,
    });
    if (!res?.success) {
      ElMessage.error(`保存失败：${res?.error || '未知错误'}`);
      return;
    }
    // 同步本地列表中的笔记内容与更新时间
    const target = annotations.value.find((a) => a.id === id);
    if (target) {
      target.note = text;
      target.updatedAt = new Date().toISOString();
    }
    ElMessage.success('笔记已保存');
    // 笔记/划线分类可能变化（划线加笔记后变成笔记），刷新书架徽标
    refreshCounts();
  } catch (err) {
    console.error('保存笔记失败', err);
  }
}

// 组件挂载时加载书架列表（从数据库读取）
onMounted(() => {
  // 加载分类列表（书架分类筛选/管理依赖）
  loadCategories();
  // 加载书架后刷新每本书的笔记/驾线数量徽标
  loadBookshelf().then(() => refreshCounts());
  // 监听全屏变化（ESC 退出等），同步沉浸状态
  document.addEventListener('fullscreenchange', onFsChange);
  // 右键「用渐离阅读」外部打开：挂载时若有待打开文件则入库并打开（App.vue 已写入 store）
  const ext = ebookStore.pendingOpenFiles.slice();
  if (ext.length) {
    ebookStore.pendingOpenFiles = [];
    openExternalFiles(ext);
  }
});

onUnmounted(() => {
  document.removeEventListener('fullscreenchange', onFsChange);
  // 卸载时若处于真实全屏，安全退出
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
  }
});

// 监听文件路径变化，切换文件时清除目录状态与笔记列表
watch(
  () => currentFile.value.path,
  () => {
    tocItems.value = [];
    tocVisible.value = false;
    tocLandmarks.value = [];
    currentFileHref.value = '';
    annotations.value = [];
    annotationDrawerVisible.value = false;
    annotationSourceFile.value = null;
    bookmarks.value = [];
    bookmarkDrawerVisible.value = false;
    currentFileCfi.value = '';
    searchResults.value = [];
    searching.value = false;
    searchPanelVisible.value = false;
    attachments.value = [];
    attachmentsLoading.value = false;
    attachmentsDrawerVisible.value = false;
  }
);

// 笔记抽屉关闭时重置来源标记，避免下次打开阅读视图抽屉时误判为书架来源
watch(
  () => annotationDrawerVisible.value,
  (visible) => {
    if (!visible) {
      annotationSourceFile.value = null;
    }
  }
);

// 切换回书架视图时重新拉取每本书的笔记/划线数量徽标：
// 阅读过程中新增/删除的标注已写入数据库，回到书架需刷新计数（原返回书架逻辑在此处补回刷新）
watch(
  () => view.value,
  (val) => {
    if (val === 'bookshelf') {
      refreshCounts();
      // 离开阅读视图时退出沉浸全屏，避免书架停留在隐藏工具栏的全屏态
      if (isFullscreen.value) {
        isFullscreen.value = false;
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      }
    }
  }
);

// 右键「用渐离阅读」外部打开：路由已切到阅读器但组件已挂载时，消费后续到达的文件
function openExternalFiles(files: string[]): void {
  for (const p of files) {
    const lower = p.toLowerCase();
    const format: 'txt' | 'epub' | 'pdf' = lower.endsWith('.pdf')
      ? 'pdf'
      : lower.endsWith('.txt')
        ? 'txt'
        : 'epub';
    loadFile(p, p.replace(/^.*[\\/]/, ''), format);
  }
}
watch(
  () => ebookStore.pendingOpenFiles,
  (files) => {
    if (files && files.length) {
      ebookStore.pendingOpenFiles = [];
      openExternalFiles(files);
    }
  }
);
</script>

<style scoped lang="scss">
:deep(.main) {
  padding: 0 !important;
  overflow: hidden !important;
}

.ebook-reader-page {
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
  box-sizing: border-box;

  .reader-toolbar {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 6px 16px;
    background: var(--bg-card);
    border-bottom: 1px solid var(--border-subtle);
    box-shadow: var(--shadow-top);

    .toolbar-left {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-shrink: 0; /* 核心按钮（书架/打开文件/文件名）保持完整，不随屏幕变窄被压缩 */
      min-width: 0;
    }

    /* 右侧阅读控制区：空间不足时横向滚动，保证所有功能（目录/笔记/字体/字号/设置）始终可触及 */
    .toolbar-right {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-left: auto; /* 始终贴右 */
      flex-shrink: 1; /* 允许收缩以触发横向滚动 */
      min-width: 0;
      flex-wrap: nowrap;
      overflow-x: auto;
      overflow-y: hidden;
      /* 顶部补 padding：el-badge 角标绝对定位于按钮右上角、会向上溢出约 9px，
         若不加 padding 会被 overflow-y:hidden 裁掉（数量角标显示不全）。
         仅补顶部（底部不补），因 .toolbar-right 垂直居中于工具栏，按钮仍与左侧对齐，且高度更省。 */
      padding: 10px 0 0;
      scrollbar-width: thin;
      scrollbar-color: var(--border-subtle, rgba(0, 0, 0, 0.2)) transparent;

      /* 子项不压缩，保持按钮/下拉框的可点尺寸，超出部分由容器横向滚动 */
      > * {
        flex-shrink: 0;
      }

      /* 细滚动条（webkit） */
      &::-webkit-scrollbar {
        height: 4px;
      }
      &::-webkit-scrollbar-thumb {
        background: var(--border-subtle, rgba(0, 0, 0, 0.2));
        border-radius: 2px;
      }
      &::-webkit-scrollbar-track {
        background: transparent;
      }
    }

    .file-info {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;

      .file-name {
        font-size: 13px;
        color: var(--text-primary);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        max-width: 220px;
      }

      .file-author {
        font-size: 12px;
        color: var(--text-secondary);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        max-width: 120px;
      }
    }
  }

  /* 外层容器不再定义独立的 day/night/eye 主题变量，
     改为继承全局系统主题（src/styles/themes/*，由 useTheme 的 data-theme 控制），
     因此工具栏 / 书架 / 抽屉等区域随系统主题（浅色 / 深色 / 玻璃拟态…）变化；
     阅读正文区的日间 / 夜间 / 护眼主题由各阅读组件（TxtReader / EpubReader / PdfReader）自行保留。 */

  .reader-content {
    flex: 1;
    overflow: hidden;
    min-height: 0;

    .empty-state {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100%;
    }

  }

  /* 顶部栏隐藏时右下角浮动设置按钮（淡入动画） */
  .floating-settings-btn {
    position: fixed;
    right: 20px;
    bottom: 20px;
    z-index: 100;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    opacity: 0.85;
    transition: opacity 0.2s;

    &:hover {
      opacity: 1;
    }
  }

  /* ============ 沉浸全屏模式 ============ */
  /* 全屏时隐藏顶部工具栏与常规浮动设置按钮，让阅读内容撑满；由右上角浮动控制条替代操作 */
  &.is-fullscreen {
    .reader-toolbar {
      display: none;
    }
    .floating-settings-btn {
      display: none;
    }
    /* 全屏下内容区取消圆角/留白以增强沉浸感（视阅读组件自身背景而定） */
    .reader-content {
      padding: 0;
    }
  }

  /* 全屏模式右上角浮动控制条：默认完全隐藏，鼠标 hover 到右上角区域才显形，避免遮挡阅读 */
  .floating-fs-controls {
    position: fixed;
    top: 16px;
    right: 16px;
    z-index: 200;
    display: flex;
    gap: 8px;
    padding: 6px;
    border-radius: 999px;
    background: var(--bg-card);
    border: 1px solid var(--border-subtle);
    box-shadow: var(--shadow-card);
    opacity: 0;
    transition: opacity 0.25s;

    &:hover {
      opacity: 1;
    }

    .el-button {
      margin-left: 0;
    }

    /* PDF 缩放百分比（点击复位）：与两侧按钮共用同一控制条 */
    .fs-zoom-percent {
      min-width: 42px;
      text-align: center;
      font-size: 13px;
      line-height: 1;
      color: var(--text-secondary, #666);
      cursor: pointer;
      user-select: none;
      white-space: nowrap;
    }

    /* 缩放组与设置/退出之间的分隔线 */
    .fs-divider {
      width: 1px;
      align-self: stretch;
      margin: 2px 2px;
      background: var(--border-subtle, #e5e5e5);
    }
  }

  .fade-enter-active,
  .fade-leave-active {
    transition: opacity 0.3s;
  }
  .fade-enter-from,
  .fade-leave-to {
    opacity: 0;
  }
}
</style>

<template>
  <!-- 资源嗅探抽屉：类型/大小筛选 + 缩略图列表 + 批量下载/导出 -->
  <el-drawer
    v-model="visible"
    title="资源嗅探"
    direction="rtl"
    size="480px"
    :append-to-body="true"
  >
    <div class="sniffer-panel">
      <!-- 筛选工具条 -->
      <div class="sniffer-toolbar">
        <span class="sniffer-status" :class="{ 'is-on': isSniffing }">
          <span class="status-dot"></span>
          {{ isSniffing ? `嗅探中 · ${items.length}` : "未嗅探" }}
        </span>
        <el-select v-model="minSize" size="small" class="size-filter">
          <el-option v-for="opt in sizeOptions" :key="opt.value" :label="opt.label" :value="opt.value" />
        </el-select>
        <el-radio-group v-model="filter" size="small">
          <el-radio-button value="all">全部</el-radio-button>
          <el-radio-button value="video">视频</el-radio-button>
          <el-radio-button value="audio">音频</el-radio-button>
          <el-radio-button value="image">图片</el-radio-button>
        </el-radio-group>
      </div>

      <!-- 批量操作条（有选中项时展示） -->
      <div v-if="selectedItems.length > 0" class="batch-bar">
        <span class="batch-count">已选 {{ selectedItems.length }} 项</span>
        <el-button size="small" type="primary" @click="onBatchDownload">
          <LucideIcon name="Download" :size="13" />
          <span style="margin-left: 4px">批量下载</span>
        </el-button>
        <el-button size="small" @click="onExport">
          <LucideIcon name="SquareArrowOutUpRight" :size="13" />
          <span style="margin-left: 4px">导出TXT</span>
        </el-button>
        <el-button size="small" @click="onCopySelected">
          <LucideIcon name="Copy" :size="13" />
          <span style="margin-left: 4px">复制链接</span>
        </el-button>
      </div>

      <!-- 资源列表 -->
      <div class="sniffer-list">
        <template v-if="filteredList.length > 0">
          <!-- 全选 -->
          <div class="select-all-row">
            <el-checkbox
              :model-value="allSelected"
              :indeterminate="someSelected && !allSelected"
              @change="toggleSelectAll"
            >全选（当前筛选 {{ filteredList.length }} 项）</el-checkbox>
          </div>
          <div v-for="(item, index) in filteredList" :key="`${item.url}-${index}`" class="sniff-item">
            <el-checkbox
              class="item-check"
              :model-value="selected.has(item.url)"
              @change="toggleSelect(item.url)"
            />
            <!-- 图片类型直接用资源本身做缩略图，便于识别内容 -->
            <span class="item-icon" :class="{ 'is-image': item.type === 'image' && !thumbFailed.has(item.url) }">
              <img
                v-if="item.type === 'image' && !thumbFailed.has(item.url)"
                class="item-thumb"
                :src="item.url"
                loading="lazy"
                referrerpolicy="no-referrer"
                @error="thumbFailed.add(item.url)"
              />
              <LucideIcon v-else :name="typeIcon(item.type)" :size="15" />
            </span>
            <span class="item-body">
              <span class="item-name" :title="item.url">{{ fileName(item.url) }}</span>
              <span class="item-meta">
                {{ typeLabel(item.type) }}
                <template v-if="item.stream"> · 流媒体</template>
                <template v-if="item.suspect"> · 疑似视频</template>
                <template v-if="item.size > 0"> · {{ formatBytes(item.size) }}</template>
                <template v-if="item.size === 0"> · 大小未知</template>
              </span>
            </span>
            <span class="item-actions">
              <span
                v-if="item.type === 'video'"
                class="action-btn"
                title="视频解析（yt-dlp）：解析清晰度并下载"
                @click="onYtDlpParse(item)"
              >
                <LucideIcon name="Wand" :size="14" />
              </span>
              <span v-if="!item.stream" class="action-btn" title="下载（进入下载管理）" @click="onDownload(item)">
                <LucideIcon name="Download" :size="14" />
              </span>
              <span class="action-btn" title="复制链接" @click="onCopy(item)">
                <LucideIcon name="Copy" :size="14" />
              </span>
              <span class="action-btn" title="新标签页打开" @click="onOpen(item)">
                <LucideIcon name="SquareArrowOutUpRight" :size="14" />
              </span>
            </span>
          </div>
        </template>
        <div v-else class="sniffer-empty">
          <LucideIcon name="MonitorPlay" :size="36" color="var(--text-muted)" />
          <p>{{ isSniffing ? "暂未捕获资源，滚动页面或播放视频试试" : "未嗅探：页面加载过的媒体/图片会自动补录" }}</p>
          <p class="empty-sub">提示：视频站（B站/YouTube/抖音等）请播放视频后点条目上的「魔法棒」用 yt-dlp 解析下载</p>
        </div>
      </div>

      <!-- 底部操作 -->
      <div v-if="items.length > 0 || !ytdlpState.installed" class="sniffer-footer">
        <el-button size="small" plain @click="onClear">
          <LucideIcon name="Trash2" :size="13" />
          <span style="margin-left: 4px">清空列表</span>
        </el-button>
        <!-- yt-dlp 引擎状态（未安装时提供一键安装，下载中支持暂停/继续；视频解析/合并依赖它） -->
        <div class="ytdlp-box">
          <template v-if="!ytdlpState.installed">
            <el-button v-if="!installing" size="small" type="primary" plain @click="onInstallYtDlp">
              <LucideIcon name="Download" :size="13" />
              <span style="margin-left: 4px">安装视频解析引擎</span>
            </el-button>
            <template v-else>
              <span class="ytdlp-hint">{{ installMessage || "正在安装 yt-dlp…" }}</span>
              <el-progress :percentage="installPercent" :stroke-width="6" class="ytdlp-progress" />
              <!-- 暂停/继续：暂停保留断点，继续时断点续传 -->
              <el-button v-if="!enginePaused" link size="small" type="warning" @click="onPauseEngine">暂停</el-button>
              <el-button v-else link size="small" type="primary" @click="onResumeEngine">继续</el-button>
            </template>
          </template>
          <span v-else class="ytdlp-ready">
            <LucideIcon name="CircleCheckBig" :size="13" />
            yt-dlp 就绪{{ ytdlpState.ffmpegInstalled ? "" : "（ffmpeg 将按需获取）" }}
          </span>
        </div>
      </div>

      <!-- yt-dlp 解析对话框 -->
      <YtDlpDialog v-model:visible="showYtDlpDialog" :url="ytDlpUrl" />
    </div>
  </el-drawer>
</template>

<script setup lang="ts">
/**
 * 内置浏览器 - 资源嗅探抽屉
 * ------------------------------------------------------------------
 * 职责：展示当前标签嗅探到的媒体/图片资源（主进程 webRequest + 页面 Hook 捕获并回填），
 * 提供：
 * - 类型筛选（全部/视频/音频/图片）与最小文件大小筛选（未知大小始终显示）；
 * - 图片资源直接以自身 URL 作缩略图（懒加载 + no-referrer 绕防盗链 + 失败回退图标）；
 * - 勾选批量操作：批量下载（逐个触发下载管理管线，流媒体自动跳过）、
 *   导出 TXT 链接清单（落系统「下载」文件夹）、复制所选链接；
 * - 视频条目支持 yt-dlp 解析（清晰度选择 + DASH 合成下载），引擎未安装可一键安装。
 * 打开抽屉即开始嗅探当前标签，关闭即停止。
 */
import { computed, onMounted, ref, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import LucideIcon from "@/components/LucideIcon.vue";
import useBrowser from "@/store/useBrowser";
import { useSniffer, clearSniffItems, exportSniffItems, type SniffItem } from "../composables/useSniffer";
import { downloadResource } from "../composables/useWebviewBridge";
import { isTakeOverEnabled } from "../../downloader/api/downloaderApi";
import { checkYtDlp, installYtDlp, pauseEngineDownload, resumeEngineDownload, useYtDlpProgress } from "../composables/useYtDlp";
import YtDlpDialog from "./YtDlpDialog.vue";

/** 抽屉显隐（v-model:visible；开/关由父级驱动嗅探启停） */
const visible = defineModel<boolean>("visible", { default: false });

const browserStore = useBrowser();
const { items, isSniffing } = useSniffer();

// ==================== 筛选 ====================
/** 类型筛选：all / video / audio / image */
const filter = ref<"all" | SniffItem["type"]>("all");

/** 大小筛选档位（value 为字节，0 表示不限） */
const sizeOptions = [
  { label: "大小不限", value: 0 },
  { label: "≥ 10 KB", value: 10 * 1024 },
  { label: "≥ 50 KB", value: 50 * 1024 },
  { label: "≥ 100 KB", value: 100 * 1024 },
  { label: "≥ 500 KB", value: 500 * 1024 },
  { label: "≥ 1 MB", value: 1024 * 1024 },
];
/** 最小文件大小（字节） */
const minSize = ref(0);

/**
 * 按类型 + 大小过滤后的列表
 * 说明：大小未知（size=0，如分块传输）的资源在启用大小筛选时仍显示，避免漏掉有价值的流
 */
const filteredList = computed(() => {
  return items.value.filter((it) => {
    if (filter.value !== "all" && it.type !== filter.value) return false;
    if (minSize.value > 0 && it.size > 0 && it.size < minSize.value) return false;
    return true;
  });
});

// ==================== 图片缩略图 ====================
/** 加载失败的缩略图 URL 集合（回退为图标） */
const thumbFailed = ref(new Set<string>());

// ==================== 选择与批量操作 ====================
/** 已勾选的资源 URL 集合 */
const selected = ref(new Set<string>());

/** 当前已勾选且仍存在于列表中的资源 */
const selectedItems = computed(() => items.value.filter((it) => selected.value.has(it.url)));

/** 当前筛选列表是否全选 */
const allSelected = computed(() => {
  return filteredList.value.length > 0 && filteredList.value.every((it) => selected.value.has(it.url));
});

/** 当前筛选列表是否有部分选中（用于半选态） */
const someSelected = computed(() => {
  return filteredList.value.some((it) => selected.value.has(it.url));
});

/**
 * 列表变化时修剪失效的勾选（被清空/淘汰的资源）
 */
watch(items, (list) => {
  const urls = new Set(list.map((it) => it.url));
  if (selected.value.size === 0) return;
  const next = new Set([...selected.value].filter((u) => urls.has(u)));
  if (next.size !== selected.value.size) {
    selected.value = next;
  }
});

/**
 * 切换单个资源的勾选状态
 * @param url 必填，资源地址
 */
function toggleSelect(url: string) {
  const next = new Set(selected.value);
  if (next.has(url)) {
    next.delete(url);
  } else {
    next.add(url);
  }
  selected.value = next;
}

/**
 * 全选/取消全选当前筛选列表
 */
function toggleSelectAll() {
  if (allSelected.value) {
    // 仅取消当前筛选范围内的勾选
    const next = new Set(selected.value);
    filteredList.value.forEach((it) => next.delete(it.url));
    selected.value = next;
  } else {
    const next = new Set(selected.value);
    filteredList.value.forEach((it) => next.add(it.url));
    selected.value = next;
  }
}

// ==================== 展示辅助 ====================

/**
 * 类型图标
 * @param type 必填，资源类型
 * @returns 图标名（均在 LucideIcon nameMap 中已验证）
 */
function typeIcon(type: SniffItem["type"]): string {
  const map: Record<SniffItem["type"], string> = { video: "Film", audio: "Music", image: "Image" };
  return map[type];
}

/**
 * 类型中文标签
 * @param type 必填，资源类型
 * @returns 中文
 */
function typeLabel(type: SniffItem["type"]): string {
  const map: Record<SniffItem["type"], string> = { video: "视频", audio: "音频", image: "图片" };
  return map[type];
}

/**
 * 从 URL 提取展示文件名（解码 + 截断过长查询串）
 * @param url 必填，资源地址
 * @returns 文件名
 */
function fileName(url: string): string {
  try {
    const u = new URL(url);
    const name = decodeURIComponent(u.pathname.split("/").pop() || u.hostname);
    return name.length > 60 ? `${name.slice(0, 57)}...` : name || url;
  } catch {
    return url.slice(0, 60);
  }
}

/**
 * 字节数转可读文本
 * @param bytes 必填，字节数
 * @returns 如 "1.2 MB"
 */
function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

// ==================== 单项动作 ====================

/**
 * 下载资源（经现有下载管理管线）
 * 若下载器接管开关开启，实际进度在系统级下载器页面，提示语相应区分
 * @param item 必填，嗅探到的资源条目
 * @returns void
 */
async function onDownload(item: SniffItem) {
  const ok = downloadResource(browserStore.activeTabId, item.url);
  if (!ok) {
    ElMessage.error("下载失败：网页尚未加载完成");
    return;
  }
  if (await isTakeOverEnabled()) {
    ElMessage.success("已转交系统级下载器，请到下载器页面查看进度");
  } else {
    ElMessage.success("已加入下载");
  }
}

/**
 * 复制资源链接
 * @param item 必填，资源条目
 */
function onCopy(item: SniffItem) {
  window.ipcRenderer.clipboard.writeText(item.url);
  ElMessage.success("链接已复制");
}

/**
 * 新标签页打开资源
 * @param item 必填，资源条目
 */
function onOpen(item: SniffItem) {
  browserStore.createTab(item.url, "资源打开");
}

// ==================== 批量动作 ====================

/** 批量下载间隔（ms），避免瞬时并发触发站点限流 */
const BATCH_GAP = 150;

/**
 * 批量下载所选项：逐个触发下载（流媒体自动跳过并提示）
 * 接管开关开启时进度在系统级下载器页面，提示语相应区分
 * @returns Promise，逐个间隔触发完成
 */
async function onBatchDownload() {
  const targets = selectedItems.value.filter((it) => !it.stream);
  const skipped = selectedItems.value.length - targets.length;
  if (targets.length === 0) {
    ElMessage.warning("所选资源均为流媒体，请使用「复制链接」配合专门下载工具");
    return;
  }
  const takenOver = await isTakeOverEnabled();
  ElMessage.info(
    takenOver
      ? `已转交系统级下载器 ${targets.length} 个资源，请到下载器页面查看进度`
      : `开始下载 ${targets.length} 个资源，进度见「下载内容」`
  );
  for (const it of targets) {
    downloadResource(browserStore.activeTabId, it.url);
    // 间隔触发，防瞬时并发
    await new Promise((r) => setTimeout(r, BATCH_GAP));
  }
  if (skipped > 0) {
    ElMessage.warning(`${skipped} 个流媒体已跳过，可「复制链接」后用专门工具下载`);
  }
}

/**
 * 导出所选项链接清单为 TXT（直写缓存目录，成功提示由导出工具 fileNotify 展示）
 */
async function onExport() {
  const ok = await exportSniffItems(selectedItems.value);
  if (!ok) {
    ElMessage.error("导出失败，请重试");
  }
}

/**
 * 复制所选项链接（每行一个）
 */
function onCopySelected() {
  const text = selectedItems.value.map((it) => it.url).join("\n");
  window.ipcRenderer.clipboard.writeText(text);
  ElMessage.success(`已复制 ${selectedItems.value.length} 条链接`);
}

/** 清空当前嗅探列表（同时清空勾选） */
async function onClear() {
  if (browserStore.activeTabId) {
    await clearSniffItems(browserStore.activeTabId);
  }
  selected.value = new Set();
}

// ==================== yt-dlp 视频解析 ====================
/** yt-dlp 安装状态 */
const ytdlpState = ref({ installed: false, ffmpegInstalled: false, installing: false, ffmpegInstalling: false });
/** 安装中 */
const installing = ref(false);
/** 安装进度百分比 */
const installPercent = ref(0);
/** 安装提示文本 */
const installMessage = ref("");
/** 引擎下载是否已暂停（暂停保留断点，继续时断点续传） */
const enginePaused = ref(false);
/** 解析对话框显隐 */
const showYtDlpDialog = ref(false);
/** 解析目标地址 */
const ytDlpUrl = ref("");

/**
 * 组件挂载：查询 yt-dlp 安装状态
 */
onMounted(async () => {
  ytdlpState.value = await checkYtDlp();
});

/**
 * 订阅 yt-dlp 进度推送（安装阶段刷新进度条，处理暂停/完成/失败）
 */
useYtDlpProgress((p) => {
  if (p.stage === "install") {
    installing.value = true;
    enginePaused.value = false;
    installPercent.value = p.percent || 0;
    installMessage.value = p.message || "";
  } else if (p.stage === "install-paused") {
    enginePaused.value = true;
    installMessage.value = p.message || "已暂停";
  } else if (p.stage === "install-done") {
    installing.value = false;
    enginePaused.value = false;
    installPercent.value = 100;
    checkYtDlp().then((s) => (ytdlpState.value = s));
    ElMessage.success(p.message || "安装完成");
  } else if (p.stage === "error") {
    installing.value = false;
    enginePaused.value = false;
    ElMessage.error(p.message || "安装失败");
  }
});

/**
 * 一键安装 yt-dlp 引擎（主进程自动从 GitHub 下载，支持暂停/续传）
 */
async function onInstallYtDlp() {
  installing.value = true;
  installPercent.value = 0;
  enginePaused.value = false;
  installMessage.value = "正在下载 yt-dlp 引擎…";
  const ok = await installYtDlp();
  ytdlpState.value = await checkYtDlp();
  // 暂停场景：主进程正常返回但未完成安装，保持进度条展示并提示
  if (enginePaused.value) {
    ElMessage.info("引擎下载已暂停，可点击「继续」完成剩余部分");
  } else {
    installing.value = false;
    if (!ok) {
      ElMessage.error("安装失败，请检查网络（GitHub 访问可能需要代理）后重试");
    }
  }
}

/**
 * 暂停引擎下载（保留断点文件）
 */
async function onPauseEngine() {
  await pauseEngineDownload();
}

/**
 * 继续引擎下载（断点续传剩余字节）
 */
async function onResumeEngine() {
  enginePaused.value = false;
  installing.value = true;
  await resumeEngineDownload();
}

/**
 * 打开 yt-dlp 解析对话框
 * 前置检查：引擎未安装时弹窗让用户确认是否立即下载，下载成功后再进入解析；
 * 解析目标选择：
 * - 疑似视频（MSE 分段）：分段本身不可独立播放，解析当前页面地址；
 * - 其它（直链 mp4/m3u8 等）：直接解析资源地址（yt-dlp 支持）。
 * @param item 必填，嗅探条目
 */
async function onYtDlpParse(item: SniffItem) {
  // 前置检查：实时查询引擎安装状态（不依赖缓存）
  const state = await checkYtDlp();
  ytdlpState.value = state;
  if (!state.installed) {
    try {
      await ElMessageBox.confirm(
        "视频解析需要 yt-dlp 引擎（将从 GitHub 下载，约 17MB），是否立即下载？",
        "未检测到 yt-dlp 引擎",
        { confirmButtonText: "立即下载", cancelButtonText: "取消", type: "warning" }
      );
    } catch {
      return; // 用户取消
    }
    // 下载（进度展示在抽屉底部状态条）
    await onInstallYtDlp();
    // 下载后复查：失败则不进入解析（错误已在 onInstallYtDlp 中提示）
    const after = await checkYtDlp();
    ytdlpState.value = after;
    if (!after.installed) return;
  }
  const activeUrl = browserStore.tabs.find((t) => t.id === browserStore.activeTabId)?.url || "";
  ytDlpUrl.value = item.suspect && /^https?:/.test(activeUrl) ? activeUrl : item.url;
  showYtDlpDialog.value = true;
}
</script>

<style scoped lang="scss">
.sniffer-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  gap: 12px;
}

.sniffer-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;

  .sniffer-status {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--text-muted);
    flex-shrink: 0;

    .status-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--text-muted);
    }

    &.is-on {
      color: var(--color-success, #67c23a);

      .status-dot {
        background: var(--color-success, #67c23a);
        animation: sniff-blink 1.2s ease-in-out infinite;
      }
    }
  }

  .size-filter {
    width: 96px;
    flex-shrink: 0;
  }
}

@keyframes sniff-blink {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.3;
  }
}

.batch-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--color-primary-light);
  border: 1px solid var(--color-primary);

  .batch-count {
    font-size: 12px;
    color: var(--color-primary-solid);
    margin-right: auto;
    white-space: nowrap;
  }
}

.sniffer-list {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}

.select-all-row {
  padding: 4px 8px 8px;
  border-bottom: 1px solid var(--border-subtle);
  margin-bottom: 4px;
}

.sniff-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 6px;
  border-radius: 8px;
  transition: background 0.15s;

  &:hover {
    background: var(--bg-hover);

    .item-actions {
      opacity: 1;
    }
  }

  .item-check {
    flex-shrink: 0;
    height: auto;
  }

  .item-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border-radius: 6px;
    flex-shrink: 0;
    color: var(--text-muted);

    &.is-image {
      width: 36px;
      height: 36px;
      overflow: hidden;
      background: var(--bg-hover);
    }

    .item-thumb {
      width: 100%;
      height: 100%;
      object-fit: cover;
      border-radius: 4px;
      display: block;
    }
  }

  .item-body {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;

    .item-name {
      font-size: 13px;
      color: var(--text-primary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .item-meta {
      font-size: 12px;
      color: var(--text-muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
  }

  .item-actions {
    display: flex;
    align-items: center;
    gap: 4px;
    opacity: 0;
    transition: opacity 0.15s;
    flex-shrink: 0;

    .action-btn {
      width: 24px;
      height: 24px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 6px;
      cursor: pointer;
      color: var(--text-muted);

      &:hover {
        background: var(--bg-hover);
        color: var(--text-primary);
      }
    }
  }
}

.sniffer-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 60px 20px;
  color: var(--text-muted);
  text-align: center;

  p {
    font-size: 13px;
    margin: 0;
  }

  .empty-sub {
    font-size: 12px;
  }
}

.sniffer-footer {
  border-top: 1px solid var(--border-subtle);
  padding-top: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;

  .ytdlp-box {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    flex: 1;

    .ytdlp-hint {
      font-size: 12px;
      color: var(--text-muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .ytdlp-progress {
      width: 120px;
      flex-shrink: 0;
    }

    .ytdlp-ready {
      display: flex;
      align-items: center;
      gap: 4px;
      font-size: 12px;
      color: var(--color-success, #67c23a);
      white-space: nowrap;
    }
  }
}
</style>

/**
 * PDF 工具箱 Pinia store
 * 维护工具清单与最近输出记录（轻量，非持久化核心数据）。
 */
import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { PdfToolMeta, PdfToolKey } from '../types';

/** 工具清单（卡片仪表盘数据）：一期 → 二期 → 三期 */
const TOOL_CATALOG: PdfToolMeta[] = [
  // ===== 一期：骨架 + 核心 =====
  {
    key: 'merge',
    title: '合并 PDF',
    desc: '将多个 PDF 按顺序合并为一个文件',
    icon: 'Files',
    accent: 'var(--color-primary)',
  },
  {
    key: 'split',
    title: '拆分 PDF',
    desc: '按页码范围 / 每 N 页 / 奇偶页拆分成多份',
    icon: 'FileBox',
    accent: 'var(--color-warning)',
  },
  {
    key: 'organize',
    title: '组织页面',
    desc: '缩略图重排、删除、旋转、提取页面',
    icon: 'LayoutGrid',
    accent: 'var(--color-success)',
  },
  {
    key: 'exportImages',
    title: '导出图片',
    desc: '将每页导出为 PNG / JPG 图片',
    icon: 'Download',
    accent: 'var(--color-info)',
  },
  // ===== 二期：页面修饰处理 =====
  {
    key: 'insert',
    title: '插入页面',
    desc: '在指定位置插入另一文件的页面',
    icon: 'FilePlus',
    accent: 'var(--color-primary)',
  },
  {
    key: 'replace',
    title: '替换页面',
    desc: '用另一文件替换源文件某段页面',
    icon: 'Replace',
    accent: 'var(--color-warning)',
  },
  {
    key: 'duplicate',
    title: '复制页面',
    desc: '在选中页后追加其副本',
    icon: 'Copy',
    accent: 'var(--color-success)',
  },
  {
    key: 'crop',
    title: '裁剪白边',
    desc: '按四边边距裁剪页面白边',
    icon: 'Crop',
    accent: 'var(--color-info)',
  },
  {
    key: 'decorate',
    title: '页码/页眉/页脚',
    desc: '为页面添加页码、页眉与页脚',
    icon: 'Heading',
    accent: 'var(--color-primary)',
  },
  {
    key: 'watermark',
    title: '水印',
    desc: '平铺文字水印，支持颜色与角度',
    icon: 'PaintbrushVertical',
    accent: 'var(--color-warning)',
  },
  {
    key: 'cover',
    title: '添加封面',
    desc: '插入封面页（图片铺底 / 标题文字）',
    icon: 'FileImage',
    accent: 'var(--color-success)',
  },
  {
    key: 'resize',
    title: '统一尺寸',
    desc: '等比缩放统一所有页面尺寸',
    icon: 'Scaling',
    accent: 'var(--color-info)',
  },
  {
    key: 'detectBlank',
    title: '空白页检测',
    desc: '识别并一键清理空白页',
    icon: 'ScanEye',
    accent: 'var(--color-error)',
  },
  {
    key: 'flatten',
    title: '展平标注',
    desc: '将批注/表单烧录为内容层（不可逆）',
    icon: 'Layers',
    accent: 'var(--color-primary)',
  },
  // ===== 三期：文档级 =====
  {
    key: 'compress',
    title: '压缩 PDF',
    desc: '重新生成以减小文件体积',
    icon: 'FileArchive',
    accent: 'var(--color-warning)',
  },
  {
    key: 'redact',
    title: '密文遮盖',
    desc: '永久涂黑整页或指定区域',
    icon: 'Highlighter',
    accent: 'var(--color-error)',
  },
  {
    key: 'security',
    title: '加密 / 解密',
    desc: '基于 qpdf 引擎（规划中）',
    icon: 'Lock',
    accent: 'var(--color-error)',
  },
  {
    key: 'pageLabels',
    title: '页面标签',
    desc: '设置页码标签样式（如 i, ii, 1, 2）',
    icon: 'Tags',
    accent: 'var(--color-info)',
  },
  {
    key: 'attach',
    title: '嵌入附件',
    desc: '向 PDF 嵌入附件文件',
    icon: 'Paperclip',
    accent: 'var(--color-success)',
  },
  {
    key: 'compare',
    title: '对比 PDF',
    desc: '双栏并排对比两份文档',
    icon: 'GitCompare',
    accent: 'var(--color-primary)',
  },
];

export const usePdfTools = defineStore('pdfTools', () => {
  /** 工具清单 */
  const tools = ref<PdfToolMeta[]>(TOOL_CATALOG);
  /** 当前打开的工具（null=仪表盘） */
  const activeTool = ref<PdfToolKey | null>(null);
  /** 最近一次输出结果（用于结果区展示） */
  const recentOutputs = ref<string[]>([]);
  /** 右键「PDF 工具箱」外部打开：预载的源文件（App.vue 写入，具体工具组件消费后清空） */
  const pendingFiles = ref<string[]>([]);

  /** 打开某工具 */
  function openTool(key: PdfToolKey): void {
    activeTool.value = key;
  }
  /** 返回仪表盘 */
  function backToDashboard(): void {
    activeTool.value = null;
  }
  /** 记录输出路径 */
  function pushOutput(path: string): void {
    recentOutputs.value.unshift(path);
    if (recentOutputs.value.length > 20) recentOutputs.value.pop();
  }
  /** 取走外部预载文件并清空（工具组件挂载时调用，避免重复消费） */
  function consumePendingFiles(): string[] {
    const f = pendingFiles.value;
    pendingFiles.value = [];
    return f;
  }

  return { tools, activeTool, recentOutputs, pendingFiles, openTool, backToDashboard, pushOutput, consumePendingFiles };
});

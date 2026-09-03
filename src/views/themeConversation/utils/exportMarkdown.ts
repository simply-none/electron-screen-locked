/**
 * 主题对话 - 导出 Markdown 工具
 * ------------------------------------------------------------------
 * 把指定主题（含其下全部对话）导出为 .md 文本并写入磁盘缓存目录。
 * - 富文本（is_rich='1'）内容经轻量 HTML→Markdown 转换；纯文本原样保留换行。
 * - 复用既有能力：getConversationsByTheme（按主题查对话）、tagName（标签 id→名称）。
 * - 落盘走主进程 export-text-to-cache IPC（直接写到 fileCachePath 缓存目录，
 *   不弹保存对话框），渲染端不直接碰文件系统，严守进程边界红线。
 * - 导出成功后由调用方用 src/utils/fileNotify.ts 的 fileNotify 提示（蓝色可点击路径）。
 *
 * 对外导出两个入口：
 *   exportThemeToMarkdown(theme, dir?)           单主题「导出所有」（右键菜单用）
 *   exportThemesToMarkdown(themes[], dir?)       多主题批量（合并为单个 .md，勾选导出用）
 * 两者均返回 { success, path?, message? }，path 为写入后的绝对路径。
 */

import { sendSync } from '@/utils/common';
import { useThemeConversation } from '../composables/useThemeConversation';

const { getConversationsByTheme, tagName, parseArr } = useThemeConversation();

/** 解码常见 HTML 实体 */
function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"');
}

/** 轻量 HTML → Markdown（覆盖 vue-quill 常见输出：标题/列表/引用/加粗/斜体/代码/链接/换行） */
export function htmlToMarkdown(html: string | undefined | null): string {
  if (!html) return '';
  let s = String(html);
  // 标题：<h1>..</h1> → # ..\n
  s = s.replace(/<(h[1-6])[^>]*>/gi, (_m, tag) => '\n' + '#'.repeat(parseInt(tag[1], 10)) + ' ');
  s = s.replace(/<\/(h[1-6])>/gi, '\n');
  // 列表
  s = s.replace(/<ul[^>]*>/gi, '\n').replace(/<ol[^>]*>/gi, '\n');
  s = s.replace(/<li[^>]*>/gi, '\n- ');
  // 引用
  s = s.replace(/<blockquote[^>]*>/gi, '\n> ');
  // 块级结尾 / 换行 → 换行
  s = s.replace(/<\/(p|div|li|h[1-6]|blockquote|pre|tr)>/gi, '\n');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  // 行内格式
  s = s.replace(/<(strong|b)[^>]*>/gi, '**').replace(/<\/(strong|b)>/gi, '**');
  s = s.replace(/<(em|i)[^>]*>/gi, '*').replace(/<\/(em|i)>/gi, '*');
  s = s.replace(/<code[^>]*>/gi, '`').replace(/<\/code>/gi, '`');
  // 链接：<a href="url">text</a> → [text](url)
  s = s.replace(/<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, '[$2]($1)');
  // 清理剩余标签
  s = s.replace(/<[^>]+>/g, '');
  // 实体解码 + 换行压缩
  s = decodeEntities(s);
  s = s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return s;
}

/** 解析跨主题引用（JSON 字符串或数组）为数量 */
function crossRefCount(value: any): number {
  if (!value) return 0;
  if (Array.isArray(value)) return value.length;
  try {
    const a = JSON.parse(value);
    return Array.isArray(a) ? a.length : 0;
  } catch {
    return 0;
  }
}

/** 单条对话 → Markdown 片段 */
function conversationToMd(conv: any): string {
  const content =
    conv.is_rich === '1' ? htmlToMarkdown(conv.content) : String(conv.content || '').trim();
  const meta: string[] = [];
  if (conv.annotate_time) meta.push(`标注 ${conv.annotate_time}`);
  const convTags = parseArr(conv.tags).map((id: any) => tagName(id)).filter(Boolean);
  if (convTags.length) meta.push(`标签 ${convTags.join('、')}`);
  const refCount = parseArr(conv.ref_ids).length;
  if (refCount) meta.push(`引用 ${refCount} 条`);
  const cross = crossRefCount(conv.cross_refs);
  if (cross) meta.push(`跨主题 ${cross} 条`);

  const parts = [`### 对话 · ${conv.create_time || ''}`, '', content || '(空对话)'];
  if (meta.length) parts.push('', `> ${meta.join(' ｜ ')}`);
  return parts.join('\n');
}

/** 单个主题 → Markdown（标题头 + 全部对话） */
function themeToMd(theme: any, conversations: any[]): string {
  const themeTags = parseArr(theme.tags).map((id: any) => tagName(id)).filter(Boolean);
  const lines: string[] = [];
  lines.push(`# ${theme.title || '未命名主题'}`);
  lines.push('');
  const head: string[] = [];
  if (theme.create_time) head.push(`创建时间：${theme.create_time}`);
  if (theme.update_time) head.push(`更新时间：${theme.update_time}`);
  if (themeTags.length) head.push(`主题标签：${themeTags.join('、')}`);
  head.push(`对话数：${conversations.length}`);
  lines.push(head.join(' ｜ '));
  lines.push('', '---', '');
  if (!conversations.length) {
    lines.push('（该主题暂无对话）');
  } else {
    conversations.forEach((c, i) => {
      lines.push(conversationToMd(c));
      if (i < conversations.length - 1) lines.push('', '---', '');
    });
  }
  return lines.join('\n');
}

/** 时间戳：YYYYMMDD_HHmmss */
function timestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(
    d.getMinutes(),
  )}${p(d.getSeconds())}`;
}

/** 文件名安全化：去除非法字符并限制长度 */
function sanitizeName(s: string): string {
  return (s || '未命名').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40);
}

/**
 * 直接写入缓存目录（不弹保存框）。
 * dir 优先用渲染端传入的 fileCachePathC 缓存目录；为空时主进程回退到
 * fileCachePath 设置项 / 用户文档目录。返回完整结果与绝对路径。
 */
function saveTextToCache(
  text: string,
  filename: string,
  dir?: string
): { success: boolean; path?: string; message?: string } {
  const res = sendSync('export-text-to-cache', { text, filename, dir });
  if (res && res.success) return { success: true, path: res.path };
  return { success: false, message: (res && res.message) || '导出失败' };
}

/** 过滤软删除的对话 */
function alive(convs: any[]): any[] {
  return convs.filter((c: any) => c.is_deleted !== '1');
}

/**
 * 单主题「导出所有」：导出该主题自身的全部对话（不含子主题）。
 * @param theme 主题对象（含 id/title/tags/create_time/update_time）
 * @param dir   可选，缓存目录（来自 fileCachePathC）；缺省交由主进程回退
 * @returns { success, path?, message? }
 */
export async function exportThemeToMarkdown(
  theme: any,
  dir?: string
): Promise<{ success: boolean; path?: string; message?: string }> {
  if (!theme || !theme.id) return { success: false, message: '主题无效' };
  const convs = alive(await getConversationsByTheme(theme.id));
  const md = themeToMd(theme, convs);
  return saveTextToCache(md, `主题-${sanitizeName(theme.title)}_${timestamp()}.md`, dir);
}

/**
 * 批量导出多个主题：合并为单个 .md 文件，各主题以 `#` 大标题分隔。
 * @param themes 主题对象数组（含 id/title/tags/create_time/update_time）
 * @param dir    可选，缓存目录（来自 fileCachePathC）；缺省交由主进程回退
 * @returns { success, path?, message? }
 */
export async function exportThemesToMarkdown(
  themes: any[],
  dir?: string
): Promise<{ success: boolean; path?: string; message?: string }> {
  if (!themes || !themes.length) return { success: false, message: '未选择主题' };
  const blocks: string[] = [];
  for (const theme of themes) {
    const convs = alive(await getConversationsByTheme(theme.id));
    blocks.push(themeToMd(theme, convs));
  }
  const text = blocks.join('\n\n---\n\n');
  return saveTextToCache(text, `主题对话导出_${timestamp()}.md`, dir);
}

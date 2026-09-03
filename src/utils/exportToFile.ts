/**
 * 统一导出工具（全应用导出规范的渲染端入口）
 * ------------------------------------------------------------------
 * 所有「导出 / 保存文件」类功能都走这里，保证一致的行为：
 *   1. 不弹系统保存对话框；
 *   2. 默认写入缓存目录 fileCachePath（来自 useCacheSet 的 fileCachePathC），
 *      入参 dir 可覆盖；
 *   3. 成功后用 src/utils/fileNotify.ts 的 fileNotify 提示（蓝色可点击路径，
 *      点击在资源管理器定位文件）。
 *
 * 底层走主进程 IPC：
 *   - export-text-to-cache    文本（UTF-8）
 *   - export-buffer-to-cache  二进制（base64 解码后写入）
 * 两者均为同步 IPC（ipcMain.on + e.returnValue），与 export-text-to-cache 一致。
 *
 * 调用示例：
 *   exportTextToCache(csv, '报表.csv', { title: '报表已导出' })
 *   exportBufferToCache(base64, 'qr.png', { title: '二维码已保存' })
 */
import { sendSync } from '@/utils/common';
import { fileNotify } from '@/utils/fileNotify';
import useCacheSet from '@/store/useCacheSet';

/** 导出结果（与主题对话 exportMarkdown 返回结构保持一致） */
export interface ExportResult {
  success: boolean;
  /** 写入后的绝对路径（成功时存在） */
  path?: string;
  /** 失败原因（失败时存在） */
  message?: string;
}

/**
 * 解析目标目录：入参 dir 优先；否则取缓存目录 fileCachePathC；
 * 都为空返回 undefined，由主进程回退到文档目录。
 */
function resolveDir(dir?: string): string | undefined {
  if (dir) return dir;
  try {
    const s = useCacheSet();
    return s.fileCachePathC.value || undefined;
  } catch {
    return undefined;
  }
}

/**
 * 文本导出：直写缓存目录，不弹窗。
 * @param text     文本内容
 * @param filename 文件名（不含目录）
 * @param opts     title 成功提示标题；dir 自定义目录（覆盖缓存目录）
 * @returns 导出结果（成功含 path）
 */
export function exportTextToCache(
  text: string,
  filename: string,
  opts: { title?: string; dir?: string } = {},
): ExportResult {
  const res: any = sendSync('export-text-to-cache', {
    text,
    filename,
    dir: resolveDir(opts.dir),
  });
  const result: ExportResult = res && res.success
    ? { success: true, path: res.path }
    : { success: false, message: (res && res.message) || '导出失败' };
  if (result.success && result.path) {
    fileNotify({ title: opts.title || '导出成功', filePath: result.path });
  }
  return result;
}

/**
 * 二进制导出（base64）：直写缓存目录，不弹窗。
 * 用于图片 / PDF / 通用二进制流（base64 字符串）。
 * @param base64   二进制数据（base64 字符串，可带 dataURL 前缀，会自动剥离）
 * @param filename 文件名（不含目录）
 * @param opts     title 成功提示标题；dir 自定义目录（覆盖缓存目录）
 * @returns 导出结果（成功含 path）
 */
export function exportBufferToCache(
  base64: string,
  filename: string,
  opts: { title?: string; dir?: string } = {},
): ExportResult {
  // 兼容 dataURL（如 data:image/png;base64,xxxx）
  const raw = base64.includes(',') ? base64.split(',')[1] : base64;
  const res: any = sendSync('export-buffer-to-cache', {
    base64: raw,
    filename,
    dir: resolveDir(opts.dir),
  });
  const result: ExportResult = res && res.success
    ? { success: true, path: res.path }
    : { success: false, message: (res && res.message) || '导出失败' };
  if (result.success && result.path) {
    fileNotify({ title: opts.title || '导出成功', filePath: result.path });
  }
  return result;
}

import { app, BrowserWindow, dialog, shell, ipcMain } from "electron";
import fs from "fs";
import axios from "axios";
import moment from "moment";
import { win } from "./mainWindow.ts";
import path from "path";
import { Worker } from "worker_threads";
import { scanWorkerPath } from "../variables.ts";
import { globby } from 'globby'
import fastGlob from 'fast-glob'
import { execSync, exec } from "child_process";
import colors from 'colors';
import { store } from "./store.ts";
// 扫描进程worker
let scanWorker;

interface FileSaveObjType {
  content: any;
  path: string;
  name: string;
  tempSplit: string;
  chunkLength: number;
  currentChunkIndex: number;
}

// 获取下述函数的参数类型
export type CopyFolderType = {
  source: string;
  target: string;
  ignore?: string[];
  include?: string[];
  ignoreSuffix?: string[];
  includeSuffix?: string[];
  // 文件夹（子目录）名称包含/排除，作用于整棵子树
  includeFolder?: string[];
  ignoreFolder?: string[];
  preserveTimestamps?: boolean;
  force?: boolean; // 遗留字段：true 等价于 strategy='overwrite'
  recursive?: boolean;
  // 操作模式：copy=复制(保留源) / move=移动(拷贝成功后删除源)
  op?: 'copy' | 'move';
  // 同名冲突处理：overwrite=覆盖 / skip=跳过 / rename=自动加序号
  strategy?: 'overwrite' | 'skip' | 'rename';
};

function getSelectType(type: String | String[]) {
  let filters = []
  // 选择文件的类型
  // 如果是图片
  if (type.includes("image")) {
    filters.push(
      { name: "图片", extensions: ["jpg", "png", "gif", "webp", "svg", "jpeg"] },
    )
  }
  // 如果是视频
  if (type.includes("video")) {
    filters.push(
      { name: "视频", extensions: ["mkv", "avi", "mp4"] },
    )
  }
  // 如果是音频
  if (type.includes("audio")) {
    filters.push(
      { name: "音频", extensions: ["mp3", "wav", "aac"] },
    )
  }
  // 如果是可执行文件
  if (type.includes("executable")) {
    filters.push(
      { name: "可执行文件", extensions: ["exe"] },
    )
  }
  // 如果是压缩文件
  if (type.includes("zip")) {
    filters.push(
      { name: "压缩文件", extensions: ["zip", "rar", "7z", "tar", "gz", "bz2", "xz"] },
    )
  }
  // 如果是文件
  if (type.includes("file")) {
    filters.push(
      { name: "所有文件", extensions: ["*"] },
    )
  }
  return filters
}

export function getFilePath({
  openFile,
  openDirectory,
  multiSelections,
  type,
}: {
  openFile?: boolean;
  openDirectory?: boolean;
  multiSelections?: boolean;
  type?: String | String[];
}) {
  const properties = [];
  if (openFile) {
    properties.push("openFile");
  }
  if (openDirectory) {
    properties.push("openDirectory");
  }
  if (multiSelections) {
    properties.push("multiSelections");
  }
  const filters = getSelectType(type || "file");

  const result = dialog.showOpenDialogSync({
    title: openDirectory ? "选择文件夹" : "选择文件",
    properties: properties,
    filters: filters,
  });
  return result;
}

const fileSliceList = [];

async function merge() {
  // 排序
  fileSliceList.sort((a, b) => {
    return a.currentChunkIndex - b.currentChunkIndex;
  });
  let path = fileSliceList[0].path;
  let name = fileSliceList[0].name;
  let fileName = path + name;
  // 判断是否存在文件
  if (fs.existsSync(path + name)) {
    // 存在则重新命名
    fileName = path + moment().format("_YYYY-MM-DD_HH-mm-ss_") + name;
  }
  for (let i = 0; i < fileSliceList.length; i++) {
    console.log(fileSliceList[i], `, ${i + 1}\n`);
    const arr = fs.readFileSync(
      fileSliceList[i].path +
        fileSliceList[i].tempSplit +
        fileSliceList[i].name +
        "." +
        fileSliceList[i].currentChunkIndex
    );
    fs.writeFileSync(fileName, arr, { flag: "a+" });
  }
  return fileName;
}
// 使用nodejs的fs同步模块保存文件 函数，保存成功返回ok，否则返回失败信息
export async function saveFile({
  path,
  name,
  tempSplit,
  content,
  chunkLength,
  currentChunkIndex,
}: FileSaveObjType) {
  try {
    let newPath = "";
    const buffer = Buffer.from(content);
    // 获取res的类型 使用toString.call
    const type = Object.prototype.toString.call(buffer);
    console.log(type, "type");
    fs.writeFileSync(path + tempSplit + name + "." + currentChunkIndex, buffer);
    fileSliceList.push({
      path,
      name,
      tempSplit,
      currentChunkIndex,
    });
    if (fileSliceList.length == chunkLength) {
      // 合片
      newPath = await merge();
      // 删除缓存文件
      for (let i = 0; i < fileSliceList.length; i++) {
        const oldPath =
          fileSliceList[i].path +
          fileSliceList[i].tempSplit +
          fileSliceList[i].name +
          "." +
          fileSliceList[i].currentChunkIndex;
        fs.unlinkSync(oldPath);
      }
      fileSliceList.length = 0;
    }
    return newPath;
  } catch (err) {
    console.log(err, "err");
    return "error" + err;
  }
}

// 使用fs.cp 进行整个文件夹的复制 / 移动
export function copyFolder(
  {
    source,
    target,
    // 不想包含的文件名
    ignore,
    // 想包含的文件名
    include,
    // 不想包含的文件后缀名
    ignoreSuffix,
    // 想包含的文件后缀名
    includeSuffix,
    // 文件夹（子目录）名称包含
    includeFolder,
    // 文件夹（子目录）名称排除
    ignoreFolder,
    // 是否包含子目录（false 时仅拷贝顶层文件，保持与前端预览一致）
    recursive = true,
    // 是否保留源文件的时间戳
    preserveTimestamps = true,
    // 是否覆盖现有文件或目录（遗留字段，等价于 strategy='overwrite'）
    force = true,
    // 操作模式：copy=复制(保留源) / move=移动(拷贝成功后删除源)
    op = 'copy',
    // 同名冲突处理：overwrite=覆盖 / skip=跳过 / rename=自动加序号
    strategy = 'overwrite',
  }: CopyFolderType,
  win: BrowserWindow
) {
  try {
    // 不再对目标目录整体重命名；同名冲突交由 strategy 逐文件处理
    runCopyFolder(source, target, {
      ignore,
      include,
      includeSuffix,
      ignoreSuffix,
      includeFolder,
      ignoreFolder,
      recursive,
      preserveTimestamps,
      force,
      op,
      strategy,
      win
    });
  } catch (err) {
    win.webContents.send("copy-folder", { ok: false, error: (err as Error).message });
    console.log(err, "res");
  }
}

/**
 * 递归遍历源目录，按统一过滤谓词筛选后并发复制文件到目标目录。
 * - 目录即时创建，文件入队后用受控并发池复制（默认 8 路），重叠 I/O 提升吞吐（P2）。
 * - 符号链接节点跳过（不复制、不跟随），避免指向祖先目录时无限递归（P3）。
 * - 过滤语义与原 fs.cp filter 完全一致，且跨平台（path 模块替代硬编码分隔符，P1）。
 * - 支持 op=move（拷贝成功后删除源）与 strategy（overwrite/skip/rename）同名冲突处理。
 */
async function runCopyFolder(
  source: string,
  target: string,
  opts: {
    ignore?: string[];
    include?: string[];
    includeSuffix?: string[];
    ignoreSuffix?: string[];
    includeFolder?: string[];
    ignoreFolder?: string[];
    recursive?: boolean;
    preserveTimestamps?: boolean;
    force?: boolean;
    op?: 'copy' | 'move';
    strategy?: 'overwrite' | 'skip' | 'rename';
    win: BrowserWindow;
  }
) {
  const {
    ignore,
    include,
    includeSuffix,
    ignoreSuffix,
    includeFolder,
    ignoreFolder,
    recursive = true,
    preserveTimestamps = true,
    force = true,
    op = 'copy',
    strategy = 'overwrite',
    win
  } = opts;

  // 统一过滤谓词：仅对「文件」生效，语义与前端预览完全一致——
  // 名称含/不含按文件名子串（不区分大小写）匹配；后缀按扩展名匹配。
  // 排除优先于包含；包含集合非空时须命中其一才复制，否则全部复制。
  const matchFilter = (absSrc: string): boolean => {
    const srcName = path.basename(absSrc);
    const srcLower = srcName.toLowerCase();
    const srcNameSuffix = srcName.split(".").slice(1).join(".");
    // 排除（最高优先级）
    if (ignore && ignore.some((item) => srcLower.includes(item.toLowerCase()))) return false;
    if (ignoreSuffix && ignoreSuffix.includes(srcNameSuffix)) return false;
    // 名称包含：非空时须命中
    if (include && include.length && !include.some((item) => srcLower.includes(item.toLowerCase()))) return false;
    // 后缀包含：非空时须命中
    if (includeSuffix && includeSuffix.length && !includeSuffix.includes(srcNameSuffix)) return false;
    // 文件夹（祖先目录链）包含/排除：与前端预览完全一致（OR 语义）
    // 任一祖先命中排除→排除；包含非空时须有任一祖先命中才复制
    const rel = path.relative(source, absSrc);
    const dirPart = rel.replace(/[\\/][^\\/]*$/, ""); // 去掉文件名，保留相对目录
    const segs = dirPart ? dirPart.split(/[\\/]/).filter(Boolean) : [];
    const igF = ignoreFolder;
    const incF = includeFolder;
    if (igF && igF.length && segs.some((seg) => igF.some((k) => seg.toLowerCase().includes(k.toLowerCase())))) return false;
    if (incF && incF.length && !segs.some((seg) => incF.some((k) => seg.toLowerCase().includes(k.toLowerCase())))) return false;
    return true;
  };

  const fileJobs: { src: string; dest: string }[] = [];

  const walk = async (currentSrc: string, currentDest: string) => {
    const entries = await fs.promises.readdir(currentSrc, { withFileTypes: true });
    await fs.promises.mkdir(currentDest, { recursive: true });

    for (const entry of entries) {
      const absSrc = path.join(currentSrc, entry.name);
      const absDest = path.join(currentDest, entry.name);
      // 符号链接环路防护：跳过软链接（文件/目录），既不复制也不跟随（P3）
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        // 非递归模式：跳过子目录，仅拷贝顶层文件（与前端预览一致）
        if (!recursive) continue;
        // 文件夹排除：名称命中排除关键字则整棵跳过（与前端预览一致）
        if (ignoreFolder && ignoreFolder.some((k) => entry.name.toLowerCase().includes(k.toLowerCase()))) continue;
        await walk(absSrc, absDest);
      } else if (entry.isFile()) {
        // 过滤仅在文件层生效，目录始终下钻，保证预览=实际拷贝结果
        if (matchFilter(absSrc)) fileJobs.push({ src: absSrc, dest: absDest });
      }
    }
  };

  try {
    await walk(source, target);
  } catch (err) {
    win.webContents.send("copy-folder", { ok: false, error: (err as Error).message });
    console.log(err, "res");
    return;
  }

  const total = fileJobs.length;
  // 初始进度：total 已通过 walk 取得，current 从 0 开始；前端勾选「进度检测」时弹窗展示
  if (total > 0) {
    win.webContents.send("copy-folder-progress", { current: 0, total, currentPath: "" });
  }

  // 受控并发复制：重叠 I/O 提升大目录（海量小文件 / 网络盘 / SSD）吞吐
  const CONCURRENCY = 8;
  let cursor = 0;
  let processed = 0;
  let lastEmit = 0;
  let skipped = 0; // 因 strategy='skip' 跳过已存在目标的计数
  const failed: string[] = [];

  // 节流上报进度：至少间隔 80ms 或已到收尾，避免海量文件时 IPC 刷屏
  const emitProgress = (currentPath: string) => {
    const now = Date.now();
    if (now - lastEmit >= 80 || processed >= total) {
      lastEmit = now;
      win.webContents.send("copy-folder-progress", { current: processed, total, currentPath });
    }
  };

  const worker = async () => {
    while (cursor < fileJobs.length) {
      const job = fileJobs[cursor++];
      try {
        let dest = job.dest;
        if (fs.existsSync(dest)) {
          if (strategy === 'skip') {
            // 跳过已存在目标：保留目标、源不动，仍计入进度
            skipped++;
            processed++;
            emitProgress(job.src);
            continue;
          } else if (strategy === 'rename') {
            // 自动加序号：于扩展名前插入 (n) 找空闲名
            dest = findFreeName(dest);
          }
          // overwrite / force：直接覆盖（copyFile 会替换）
        }
        await fs.promises.copyFile(job.src, dest);
        if (preserveTimestamps) {
          const st = await fs.promises.stat(job.src);
          await fs.promises.utimes(dest, st.atime, st.mtime);
        }
      } catch (e) {
        failed.push(`${job.src}: ${(e as Error).message}`);
      }
      processed++;
      emitProgress(job.src);
    }
  };

  const poolSize = Math.min(CONCURRENCY, Math.max(1, fileJobs.length));
  await Promise.all(Array.from({ length: poolSize }, () => worker()));

  // 移动模式：仅在「全部拷贝 + 无过滤 + 无跳过/失败」时删除源，避免误删被过滤排除的文件
  const hasFilter =
    (include && include.length) || (ignore && ignore.length) ||
    (includeSuffix && includeSuffix.length) || (ignoreSuffix && ignoreSuffix.length) ||
    (includeFolder && includeFolder.length) || (ignoreFolder && ignoreFolder.length);
  if (op === 'move' && failed.length === 0 && skipped === 0 && !hasFilter) {
    try {
      fs.rmSync(source, { recursive: true, force: true });
    } catch (e) {
      failed.push(`删除源目录失败: ${(e as Error).message}`);
    }
  }

  // 收尾强制上报一次完整进度，保证进度条走到 100%
  win.webContents.send("copy-folder-progress", { current: total, total, currentPath: "" });

  if (failed.length) {
    win.webContents.send(
      "copy-folder",
      { ok: false, skipped, error: `转移完成，但有 ${failed.length} 个失败:\n` + failed.slice(0, 20).join("\n") }
    );
  } else {
    // 成功：回传汇总（skipped 供前端完成提示）
    win.webContents.send("copy-folder", { ok: true, skipped });
  }
}

interface DeleteFilesType {
  folder: string;          // 根文件夹（wholeFolder 时整体删除）
  // 显式待删除文件列表（前端按筛选+勾选计算，保证预览=结果）
  paths?: string[];
  // 整体删除整个文件夹（忽略 paths，含子目录）
  wholeFolder?: boolean;
  // 是否放入回收站（false=永久删除，不可恢复）
  recycleBin?: boolean;
}

// 文件删除：显式路径批量删除 或 整体删除文件夹；支持回收站/永久删除、真实进度上报
export async function deleteFiles(args: DeleteFilesType, win: BrowserWindow) {
  const { folder, paths, wholeFolder = false, recycleBin = true } = args;

  // 1. 收集待删除目标
  let targets: string[] = [];
  if (wholeFolder) {
    targets = [folder];
  } else {
    if (!paths || !paths.length) {
      win.webContents.send('delete-files', '没有可删除的文件');
      return;
    }
    targets = paths;
  }

  const total = targets.length;
  let processed = 0;
  let lastEmit = 0;
  const emitProgress = (currentPath: string) => {
    const now = Date.now();
    if (now - lastEmit >= 80 || processed === total) {
      lastEmit = now;
      win.webContents.send('delete-files-progress', { current: processed, total, currentPath });
    }
  };
  // 先发一条初始进度，扫描阶段即有反馈
  win.webContents.send('delete-files-progress', { current: 0, total, currentPath: '' });

  const failed: string[] = [];
  for (const file of targets) {
    try {
      // 命中文件夹可能已被上游匹配目录删除（父目录先删则子目录已不存在），跳过避免误报失败
      if (fs.existsSync(file)) {
        if (recycleBin) {
          // 移入回收站（Electron 跨平台 API：Trash / Recycle Bin），失败时 reject
          await shell.trashItem(file);
        } else {
          // recursive: true 对文件无效、对文件夹递归删除，统一处理
          fs.rmSync(file, { recursive: true, force: true });
        }
      }
    } catch (e) {
      failed.push(`${file}: ${(e as Error).message}`);
    }
    processed++;
    emitProgress(file);
  }

  // 收尾强制上报一次完整进度，保证进度条走到 100%
  win.webContents.send('delete-files-progress', { current: total, total, currentPath: '' });
  if (failed.length) {
    win.webContents.send(
      'delete-files',
      `删除完成，但有 ${failed.length} 个文件失败:\n` + failed.slice(0, 20).join('\n')
    );
  } else {
    win.webContents.send('delete-files', null);
  }
}

// 列出文件夹内容（批量重命名/文件转移预览用）：返回文件名/路径/是否目录/扩展名/大小/时间
interface ListFolderItem {
  name: string;   // 文件名（含扩展名）
  path: string;   // 完整路径
  isDir: boolean; // 是否为目录
  ext: string;    // 扩展名（含点，目录为空串）
  size: number;   // 字节数（目录为 0）
  mtime: number;   // 修改时间（毫秒）
  ctime: number;   // 状态变更时间（毫秒，Windows 上接近创建时间）
  birthtime: number; // 创建时间（毫秒，部分平台/文件系统可能为 0）
  index?: number;    // 过滤后在最终结果中的全局序号（0 起），供前端按序编号/分页
}
// 过滤 + 分页的入参（语义与 copy-folder 的 matchFilter 完全一致）
interface ListFolderArgs {
  dir: string;
  recursive?: boolean;
  includeDirs?: boolean;
  include?: string[];      // 名称包含（子串，不区分大小写）
  ignore?: string[];       // 名称排除
  includeSuffix?: string[];// 类型包含（不含点）
  ignoreSuffix?: string[]; // 类型排除
  includeFolder?: string[];// 文件夹（祖先目录链）包含
  ignoreFolder?: string[]; // 文件夹（祖先目录链）排除
  page?: number;           // 1 起；pageSize<=0 时忽略，返回全部
  pageSize?: number;       // <=0 或省略 => 返回全部（用于动作时全量构建 renameItems）
}
export function listFolder(args: ListFolderArgs): { items: ListFolderItem[]; total: number; totalSize: number } {
  const {
    dir,
    recursive = false,
    includeDirs = true,
    include = [],
    ignore = [],
    includeSuffix = [],
    ignoreSuffix = [],
    includeFolder = [],
    ignoreFolder = [],
    page = 1,
    pageSize = 0,
  } = args;
  const matched: ListFolderItem[] = [];
  // 统一过滤谓词：仅对「文件」生效，语义与 copy-folder 的 matchFilter 完全一致——
  // 名称含/不含按文件名子串（不区分大小写）；后缀按扩展名；文件夹按祖先目录链 OR 语义。
  const matchFilter = (absSrc: string): boolean => {
    const srcName = path.basename(absSrc);
    const srcLower = srcName.toLowerCase();
    const srcNameSuffix = srcName.split('.').slice(1).join('.');
    // 排除（最高优先级）
    if (ignore.length && ignore.some((item) => srcLower.includes(item.toLowerCase()))) return false;
    if (ignoreSuffix.length && ignoreSuffix.includes(srcNameSuffix)) return false;
    // 名称包含：非空时须命中
    if (include.length && !include.some((item) => srcLower.includes(item.toLowerCase()))) return false;
    // 后缀包含：非空时须命中
    if (includeSuffix.length && !includeSuffix.includes(srcNameSuffix)) return false;
    // 文件夹（祖先目录链）包含/排除：OR 语义，与 copy-folder 一致
    const rel = path.relative(dir, absSrc);
    const dirPart = rel.replace(/[\\/][^\\/]*$/, '');
    const segs = dirPart ? dirPart.split(/[\\/]/).filter(Boolean) : [];
    if (ignoreFolder.length && segs.some((seg) => ignoreFolder.some((k) => seg.toLowerCase().includes(k.toLowerCase())))) return false;
    if (includeFolder.length && !segs.some((seg) => includeFolder.some((k) => seg.toLowerCase().includes(k.toLowerCase())))) return false;
    return true;
  };
  const walk = (current: string) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      // Dirent 不带时间戳，必须 stat 才能拿到真实的 mtime/ctime/birthtime；
      // 否则 entry.mtimeMs 等为 undefined，前端 formatDate 会得到 NaN
      let st;
      try {
        st = fs.statSync(full);
      } catch {
        // 无权限/损坏等异常项：给 0 兜底，不中断整个目录遍历
        st = { mtimeMs: 0, ctimeMs: 0, birthtimeMs: 0, size: 0 } as any;
      }
      if (entry.isDirectory()) {
        // 文件夹排除：命中排除关键字整棵跳过（与 copy-folder 一致），保证预览=实际拷贝
        if (ignoreFolder.length && ignoreFolder.some((k) => entry.name.toLowerCase().includes(k.toLowerCase()))) continue;
        if (includeDirs) {
          matched.push({ name: entry.name, path: full, isDir: true, ext: '', size: st.size, mtime: st.mtimeMs, ctime: st.ctimeMs, birthtime: st.birthtimeMs });
        }
        if (recursive) walk(full);
      } else if (entry.isFile()) {
        // 过滤仅在文件层生效，目录始终下钻，保证预览=实际拷贝结果
        if (matchFilter(full)) {
          matched.push({
            name: entry.name,
            path: full,
            isDir: false,
            ext: path.extname(entry.name),
            size: st.size,
            mtime: st.mtimeMs,
            ctime: st.ctimeMs,
            birthtime: st.birthtimeMs,
          });
        }
      }
    }
  };
  walk(dir);
  // 排序：目录优先，再按名称（中文 locale 排序）
  matched.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name, 'zh');
  });
  // 排序后编号，保证 index 与最终展示顺序一致；供前端按序编号/分页
  matched.forEach((m, i) => (m.index = i));
  const total = matched.length;
  const totalSize = matched.reduce((s, m) => s + (m.size || 0), 0);
  // 分页：pageSize<=0 返回全部（用于动作时全量构建 renameItems）；否则按页切片
  let items = matched;
  if (pageSize > 0) {
    const start = Math.max(0, (page - 1) * pageSize);
    items = matched.slice(start, start + pageSize);
  }
  return { items, total, totalSize };
}

// 批量重命名：前端已算好 oldPath/newPath，这里只负责 I/O + 进度上报
interface RenameItemType {
  oldPath: string;
  newPath: string;
}
type RenameStrategy = 'block' | 'auto' | 'skip';
interface RenameFilesType {
  items: RenameItemType[];
  strategy?: RenameStrategy; // 重名时的处理策略：block=拦截报错（默认） / auto=自动加序号 / skip=跳过
}

// 在目标已存在时，寻找一个空闲名（于扩展名前插入 (n)）
function findFreeName(target: string): string {
  const dir = target.replace(/[\\/][^\\/]*$/, '');
  const base = target.replace(/^.*[\\/]/, '');
  const dot = base.lastIndexOf('.');
  const nameOnly = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : '';
  let n = 2;
  let candidate = path.join(dir, `${nameOnly} (${n})${ext}`);
  while (fs.existsSync(candidate)) {
    n++;
    candidate = path.join(dir, `${nameOnly} (${n})${ext}`);
  }
  return candidate;
}

// 复制一组零散文件到目标文件夹（平铺）；用于「文件扫描结果复制到文件夹」
export function copyFiles(
  args: { files: string[]; target: string; strategy?: 'overwrite' | 'skip' | 'rename' },
  win: BrowserWindow
) {
  const { files, target, strategy = 'rename' } = args;
  const total = files.length;
  let processed = 0;
  let lastEmit = 0;
  let skipped = 0;
  const failed: string[] = [];
  const usedNames = new Set<string>(); // 本次批次内已占用名，防相互覆盖
  try {
    fs.mkdirSync(target, { recursive: true });
  } catch (e) {
    win.webContents.send('copy-files', { ok: false, skipped: 0, failed: [`创建目标目录失败: ${(e as Error).message}`] });
    return;
  }
  if (total > 0) win.webContents.send('copy-files-progress', { current: 0, total, currentPath: '' });
  for (const src of files) {
    try {
      if (!fs.existsSync(src)) {
        failed.push(`${src}: 源不存在`);
        processed++;
        continue;
      }
      const base = path.basename(src);
      let dest = path.join(target, base);
      if (strategy === 'skip' && (fs.existsSync(dest) || usedNames.has(base))) {
        skipped++;
        processed++;
        continue;
      }
      if (strategy === 'rename' && (fs.existsSync(dest) || usedNames.has(base))) {
        dest = findFreeName(dest);
      }
      fs.copyFileSync(src, dest);
      usedNames.add(path.basename(dest));
    } catch (err) {
      failed.push(`${src}: ${(err as Error).message}`);
    }
    processed++;
    const now = Date.now();
    if (now - lastEmit >= 80 || processed === total) {
      lastEmit = now;
      win.webContents.send('copy-files-progress', { current: processed, total, currentPath: src });
    }
  }
  if (total > 0) win.webContents.send('copy-files-progress', { current: total, total, currentPath: '' });
  win.webContents.send('copy-files', { ok: failed.length === 0, skipped, failed });
}

export async function renameFiles(args: RenameFilesType, win: BrowserWindow) {
  const items = args.items || [];
  const strategy: RenameStrategy = args.strategy || 'block';
  const total = items.length;
  let processed = 0;
  let lastEmit = 0;
  // 先发一条初始进度
  win.webContents.send('rename-files-progress', { current: 0, total, currentPath: '' });

  const failed: string[] = [];
  const renamed: RenameItemType[] = []; // 实际成功重命名的映射，供前端「撤销」
  for (const it of items) {
    try {
      // 源 === 目标：无变化，跳过（前端已过滤，这里再兜底一次）
      if (it.oldPath === it.newPath) {
        processed++;
        continue;
      }
      let target = it.newPath;
      // 目标已在磁盘上存在：按策略处理
      if (fs.existsSync(target)) {
        if (strategy === 'skip') {
          processed++;
          continue; // 跳过，不计入已重命名
        } else if (strategy === 'auto') {
          target = findFreeName(target);
        } else {
          throw new Error('目标已存在，可能发生覆盖');
        }
      }
      fs.renameSync(it.oldPath, target);
      renamed.push({ oldPath: it.oldPath, newPath: target });
    } catch (e) {
      failed.push(`${it.oldPath} -> ${it.newPath}: ${(e as Error).message}`);
    }
    processed++;
    const now = Date.now();
    if (now - lastEmit >= 80 || processed === total) {
      lastEmit = now;
      win.webContents.send('rename-files-progress', { current: processed, total, currentPath: it.newPath });
    }
  }

  // 收尾强制上报一次完整进度，保证进度条走到 100%
  win.webContents.send('rename-files-progress', { current: total, total, currentPath: '' });
  if (failed.length) {
    win.webContents.send(
      'rename-files',
      { error: `重命名完成，但有 ${failed.length} 个失败:\n` + failed.slice(0, 20).join('\n'), renamed }
    );
  } else {
    // 成功：返回实际重命名映射，供撤销
    win.webContents.send('rename-files', { renamed });
  }
}

// 撤销重命名：将上一次 newPath 还原回 oldPath（反向重命名）
export async function reverseRename(args: RenameFilesType, win: BrowserWindow) {
  const items = args.items || [];
  const total = items.length;
  let processed = 0;
  let lastEmit = 0;
  win.webContents.send('rename-files-progress', { current: 0, total, currentPath: '' });
  const failed: string[] = [];
  for (const it of items) {
    try {
      // it.newPath 是当前名，it.oldPath 是原名；仅当「新名存在且原名不存在」时才还原
      if (it.newPath !== it.oldPath && fs.existsSync(it.newPath) && !fs.existsSync(it.oldPath)) {
        fs.renameSync(it.newPath, it.oldPath);
      }
    } catch (e) {
      failed.push(`${it.newPath} -> ${it.oldPath}: ${(e as Error).message}`);
    }
    processed++;
    const now = Date.now();
    if (now - lastEmit >= 80 || processed === total) {
      lastEmit = now;
      win.webContents.send('rename-files-progress', { current: processed, total, currentPath: it.newPath });
    }
  }
  win.webContents.send('rename-files-progress', { current: total, total, currentPath: '' });
  if (failed.length) {
    win.webContents.send('rename-files-reversed', `撤销完成，但有 ${failed.length} 个失败:\n` + failed.slice(0, 20).join('\n'));
  } else {
    win.webContents.send('rename-files-reversed', null);
  }
}

// 导出数据到json
export function exportDataToJson(data: any, path: string) {
  try {
    // 格式化json数据并导出
    const jsonData = JSON.stringify(data, null, 2);
    fs.writeFileSync(path, jsonData);
    return "ok";
  } catch (err) {
    return err;
  }
}

/** ElectronStore 最小接口，避免直接耦合类型 */
interface ElectronStoreLike {
  get(key: string): any;
}

/**
 * 导出纯文本（如主题对话 Markdown）到缓存目录，不弹保存框。
 * 目录优先级：入参 dir（渲染端 fileCachePathC）→ electron-store 的 fileCachePath 设置 → 用户文档目录。
 * @param text     文本内容
 * @param filename 文件名（不含目录）
 * @param dir      可选，指定缓存目录；缺省时回退到设置项/文档目录
 * @returns { success, path?, message? }
 */
export function exportTextToCache(
  text: string,
  filename: string,
  dir?: string
): { success: boolean; path?: string; message?: string } {
  try {
    const targetDir =
      dir || (store as ElectronStoreLike).get?.("fileCachePath") || app.getPath("documents");
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
    const fullPath = path.resolve(targetDir, filename);
    fs.writeFileSync(fullPath, text, "utf8");
    return { success: true, path: fullPath };
  } catch (err: any) {
    return { success: false, message: err?.message || String(err) };
  }
}

/**
 * 导出二进制（base64）到缓存目录，不弹保存框。
 * 目录优先级：入参 dir → electron-store 的 fileCachePath → 用户文档目录。
 * @param base64   二进制数据（base64 字符串）
 * @param filename 文件名（不含目录）
 * @param dir      可选，指定缓存目录；缺省时回退到设置项/文档目录
 * @returns { success, path?, message? }
 */
export function exportBufferToCache(
  base64: string,
  filename: string,
  dir?: string
): { success: boolean; path?: string; message?: string } {
  try {
    const targetDir =
      dir || (store as ElectronStoreLike).get?.("fileCachePath") || app.getPath("documents");
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
    const fullPath = path.resolve(targetDir, filename);
    fs.writeFileSync(fullPath, Buffer.from(base64, "base64"));
    return { success: true, path: fullPath };
  } catch (err: any) {
    return { success: false, message: err?.message || String(err) };
  }
}

export function openFileInAssetsManager(filePath: string) {
  const fullPath = filePath.replace(/\//g, '\\');
  if (process.platform === 'win32') {
    try {
      exec(`explorer.exe /select,"${fullPath}"`);
    } catch {
      const dirPath = fullPath.substring(0, fullPath.lastIndexOf('\\'));
      shell.openPath(dirPath);
    }
  } else if (process.platform === 'darwin') {
    try {
      exec(`open -R "${fullPath}"`);
    } catch {
      const dirPath = fullPath.substring(0, fullPath.lastIndexOf('/'));
      shell.openPath(dirPath);
    }
  } else {
    const dirPath = fullPath.substring(0, fullPath.lastIndexOf('/'));
    shell.openPath(dirPath);
  }
}

// 打开目录（直接打开文件夹，区别于 openFileInAssetsManager 的“选中文件”）
export function openFolderInExplorer(dirPath: string) {
  const normalized = dirPath.replace(/\//g, '\\');
  shell.openPath(normalized);
}

export function initFile() {
  // 监听获取文件路径
  ipcMain.on("get-file-list", (e, params: string | ObjectType) => {
    console.log(params, "e");
    if (typeof params === 'string') {
      let result = getFilePath({
        openDirectory: true,
      });
      e.returnValue = result;
    } else {
      let result = getFilePath({
        openDirectory: params.openDirectory,
        openFile: params.openFile,
        multiSelections: params.multiSelections,
        type: params.type,
      });
      e.returnValue = result;
    }
  });

  // 监听文件保存（改用 handle + invoke 异步通道，避免大文件分片经同步 IPC 阻塞渲染进程）
  ipcMain.handle("save-file", async (e, fileSaveObj: FileSaveObjType) => {
    const result = await saveFile(fileSaveObj);
    console.log(result, "result");
    return result;
  });

  // 监听文件夹复制
  ipcMain.on("copy-folder", async (e, copyArgs: CopyFolderType) => {
    copyFolder(copyArgs, win);
  });

  // 复制零散文件到目标文件夹（扫描结果 → 文件夹）
  ipcMain.on("copy-files", async (e, args: { files: string[]; target: string; strategy?: 'overwrite' | 'skip' | 'rename' }) => {
    copyFiles(args, win);
  });

  // 数据保存
  ipcMain.on("export-data-to-json", (e, { data, path }) => {
    e.returnValue = exportDataToJson(data, path);
  });

  // 导出纯文本（Markdown 等）到缓存目录，不弹保存框，返回完整路径
  ipcMain.on("export-text-to-cache", (e, { text, filename, dir }) => {
    e.returnValue = exportTextToCache(text, filename, dir);
  });
  ipcMain.on("export-buffer-to-cache", (e, { base64, filename, dir }) => {
    e.returnValue = exportBufferToCache(base64, filename, dir);
  });

  ipcMain.on("open-file-in-assets-manager", (e, { path }) => {
    openFileInAssetsManager(path);
  });

  // 打开目标目录（文件转移成功后点击打开）
  ipcMain.on("open-folder", (e, dirPath: string) => {
    openFolderInExplorer(dirPath);
  });

  // 文件删除（整体 / 后缀类型 / 模糊文件名）
  ipcMain.on("delete-files", async (e, args: DeleteFilesType) => {
    deleteFiles(args, win);
  });

  // 列出文件夹内容（批量重命名预览用），同步返回
  ipcMain.on("list-folder", (e, args: { dir: string; recursive?: boolean; includeDirs?: boolean }) => {
    try {
      e.returnValue = listFolder(args);
    } catch (err) {
      console.error('[dialog] list-folder 失败:', err);
      e.returnValue = [];
    }
  });

  // 批量重命名：前端算好 oldPath/newPath，后端执行 + 进度上报
  ipcMain.on("rename-files", async (e, args: RenameFilesType) => {
    renameFiles(args, win);
  });

  // 撤销重命名：将上一次重命名的结果反向还原
  ipcMain.on("reverse-rename", async (e, args: RenameFilesType) => {
    reverseRename(args, win);
  });

  ipcMain.handle("save-debug-data", (e, { data, fileName }) => {
    try {
      const userDataPath = app.getPath('userData');
      const debugDir = path.join(userDataPath, 'debug');
      if (!fs.existsSync(debugDir)) {
        fs.mkdirSync(debugDir, { recursive: true });
      }
      const filePath = path.join(debugDir, `${fileName}_${moment().format('YYYY-MM-DD_HH-mm-ss')}.json`);
      const jsonData = JSON.stringify(data, null, 2);
      fs.writeFileSync(filePath, jsonData);
      return { success: true, filePath };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // 资源扫描
  ipcMain.on("start-scan", async (event, { startPath, extensions, options }) => {
    console.log(startPath, "startPath, extensions");
    console.log(extensions, "startPath, extensions");
    searchAllDrives(startPath, extensions, options).then((files) => {
      win.webContents.send("start-scan", files);
    });
  });

  ipcMain.handle('cancel-scan', () => {
    if (scanWorker) {
        scanWorker.terminate();
        scanWorker = null;
        return true;
    }
    return false;
});
}

async function searchAllDrives(startPatha: string, extensions: string[], ops: ObjectType) {
  // 改成promise
  return new Promise(async (resolve, reject) => {
    let startPath = startPatha.replace(/\\/g, '/');
    console.log(startPath, extensions, "startPath, extensions");
    const results = fastGlob.sync([
      ...extensions.map(ext => fastGlob.convertPathToPattern(startPath) + `/**/*.${ext}`),
      // 过滤掉一些特定目录
      '!**/node_modules/**',
      '!**/bower_components/**',
      '!**/.git/**',
      '!**/.svn/**',
      '!**/.hg/**',
      '!**/CVS/**',
      '!**/dist/**',
      // 所有点开头的目录
      '!**/.*',
      // 过滤掉wiindows系统目录
      '!**/Windows/**',


    ], {
      unique: true,
      // absolute: true,
      // 大小写不敏感
      caseSensitiveMatch: !!ops?.caseSensitiveMatch,
      deep: Number(ops?.deep || 0) || Infinity,
      onlyDirectories: !!ops?.onlyDirectories || false,
      onlyFiles: !!ops?.onlyFiles,
      objectMode: true,
      // 目录标记：后缀/
      markDirectories: true,
    })

    // 文件夹含/不含：语义与 copy-folder 的 matchFilter 完全一致（祖先目录名子串匹配）。
    // 「不含」文件夹：其下所有子孙文件与子孙文件夹均跳过。
    const includeFolder: string[] = (ops?.includeFolder || []).map((s: string) => s.toLowerCase());
    const ignoreFolder: string[] = (ops?.ignoreFolder || []).map((s: string) => s.toLowerCase());

    const mapped = results.flat().map((e: any) => {
      let size = 0;
      try {
        size = fs.statSync(e.path).size;
      } catch {
        size = 0;
      }
      return { name: e.name, path: e.path, size };
    }).filter((f: any) => {
      const rel = f.path.slice(startPath.length).replace(/^[\\/]/, '');
      const dirPart = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
      const segs = dirPart ? dirPart.split('/').filter(Boolean).map((s: string) => s.toLowerCase()) : [];
      // 不含：任一祖先目录名子串命中 → 排除（整棵跳过）
      if (ignoreFolder.length && segs.some((s) => ignoreFolder.some((k) => s.includes(k)))) return false;
      // 含：非空时须有祖先目录名子串命中，否则排除
      if (includeFolder.length && !segs.some((s) => includeFolder.some((k) => s.includes(k)))) return false;
      return true;
    });

    resolve(mapped);
  });
}
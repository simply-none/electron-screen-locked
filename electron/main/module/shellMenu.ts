/**
 * 资源管理器右键菜单（Windows 专属）
 * ------------------------------------------------------------------
 * 在文件右键菜单写入「通过渐离App打开」菜单，包含三项动作：
 *   - 加密到保险箱   → "<exe>" --vault-encrypt "%1"
 *   - 解密(.jlv)     → "<exe>" --vault-decrypt "%1"
 *   - 安全删除       → "<exe>" --vault-secure-delete "%1"
 *
 * 设计要点：
 * - Windows 11 真正支持折叠子菜单的只有 `SubCommands` + `HKLM\...\CommandStore` 方案，
 *   需要管理员权限；无权限时自动 fallback 为三个独立 HKCU 一级菜单，保证功能可用。
 * - 用 `reg` 命令（execFile，避免 shell 引号地狱）写入，幂等覆盖；
 * - dev 模式（!app.isPackaged）也会自动注册：命令额外传入仓库目录作为 electron 启动参数；
 * - 启动参数路由：解析 --vault-* 标志并聚合文件，经 flushPending 发给渲染端。
 *
 * ⚠️ 改动本文件后必须重启 Electron 才生效。
 */
import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow } from 'electron';

/** 动作类型（与注册表子命令名称、渲染端 action 对齐） */
export type CliAction = 'encrypt' | 'decrypt' | 'secure-delete';
export interface CliItem {
  action: CliAction;
  files: string[];
}

const HKCU_ROOT = 'HKCU\\Software\\Classes\\*\\shell\\JianliApp';
const HKLM_COMMANDSTORE = 'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\CommandStore\\shell';
const PARENT_NAME = '通过渐离App打开';
const SUB_COMMANDS: { id: string; name: string; action: CliAction; flag: string }[] = [
  { id: 'JianliApp.Encrypt', name: '加密到保险箱', action: 'encrypt', flag: '--vault-encrypt' },
  { id: 'JianliApp.Decrypt', name: '解密(.jlv)', action: 'decrypt', flag: '--vault-decrypt' },
  { id: 'JianliApp.SecureDelete', name: '安全删除', action: 'secure-delete', flag: '--vault-secure-delete' },
];

// ============ 注册表写入（execFile 避免 shell 引号转义问题） ============

/** 写入默认值（/ve） */
function regAddDefault(key: string, value: string): void {
  execFileSync('reg', ['add', key, '/ve', '/t', 'REG_SZ', '/d', value, '/f'], {
    windowsHide: true,
    stdio: 'ignore',
  });
}

/** 写入具名值（/v name） */
function regSet(key: string, name: string, value: string): void {
  execFileSync('reg', ['add', key, '/v', name, '/t', 'REG_SZ', '/d', value, '/f'], {
    windowsHide: true,
    stdio: 'ignore',
  });
}

/** 删除整棵键（含子键） */
function regDeleteTree(key: string): void {
  execFileSync('reg', ['delete', key, '/f'], { windowsHide: true, stdio: 'ignore' });
}

/** 业务 exe 路径（打包后为真实渐离App.exe） */
function exePath(): string {
  return process.execPath;
}

interface RegisterOptions {
  /** 是否已打包；未指定时从 app.isPackaged 读取 */
  packaged?: boolean;
  /** 开发模式下的仓库目录；未指定时从 app.getAppPath() 读取 */
  appDir?: string;
}

/** 构建单条命令字符串 */
function buildCommand(exe: string, flag: string, opts: RegisterOptions = {}): string {
  const packaged = opts.packaged ?? app.isPackaged;
  const appDir = opts.appDir ?? (packaged ? '' : app.getAppPath());
  const appArg = packaged ? '' : `"${appDir}" `;
  return `"${exe}" ${appArg}${flag} "%1"`;
}

/** 清理本级联与扁平两种历史结构 */
function cleanupLegacy(): void {
  if (process.platform !== 'win32') return;
  try { regDeleteTree(HKCU_ROOT); } catch {}
  for (const s of SUB_COMMANDS) {
    try { regDeleteTree(`${HKCU_ROOT}.${s.id}`); } catch {}
    try { regDeleteTree(`${HKLM_COMMANDSTORE}\\${s.id}`); } catch {}
  }
}

/**
 * 注册折叠子菜单（需要 HKLM 管理员权限）。
 * 成功返回 true；失败返回 false，调用方应 fallback 到扁平菜单。
 */
function registerCascading(opts: RegisterOptions = {}): boolean {
  if (process.platform !== 'win32') return false;
  try {
    const exe = exePath();
    const icon = `"${exe}",0`;

    // 1. 在 HKLM CommandStore 注册三条子命令
    for (const s of SUB_COMMANDS) {
      const storeKey = `${HKLM_COMMANDSTORE}\\${s.id}`;
      regAddDefault(storeKey, s.name);
      regSet(storeKey, 'Icon', icon);
      regAddDefault(`${storeKey}\\command`, buildCommand(exe, s.flag, opts));
    }

    // 2. 在 HKCU 文件类型下注册父菜单（SubCommands 引用 CommandStore 的 id）
    // 父菜单 (Default) 必须为空；显示名由 MUIVerb 提供
    regAddDefault(HKCU_ROOT, '');
    regSet(HKCU_ROOT, 'MUIVerb', PARENT_NAME);
    regSet(HKCU_ROOT, 'Icon', icon);
    regSet(HKCU_ROOT, 'SubCommands', SUB_COMMANDS.map((s) => s.id).join(';'));
    return true;
  } catch {
    return false;
  }
}

/** 注册为三个独立 HKCU 一级菜单（无需管理员） */
function registerFlat(opts: RegisterOptions = {}): void {
  if (process.platform !== 'win32') return;
  const exe = exePath();
  const icon = `"${exe}",0`;
  // 清理可能存在的旧父菜单（避免冲突）
  try { regDeleteTree(HKCU_ROOT); } catch {}

  for (const s of SUB_COMMANDS) {
    const key = `${HKCU_ROOT}.${s.id}`;
    try { regDeleteTree(key); } catch {}
    regAddDefault(key, `${PARENT_NAME}：${s.name}`);
    regSet(key, 'Icon', icon);
    regAddDefault(`${key}\\command`, buildCommand(exe, s.flag, opts));
  }
}

/**
 * 注册右键菜单。
 * 优先尝试 HKLM CommandStore 折叠子菜单；无权限时自动 fallback 为三个独立一级菜单。
 */
export function registerShellMenu(opts: RegisterOptions = {}): void {
  cleanupLegacy();
  const ok = registerCascading(opts);
  if (!ok) registerFlat(opts);
}

/** 反注册（清理 HKCU 父菜单、扁平项、HKLM CommandStore 子命令） */
export function unregisterShellMenu(): void {
  if (process.platform !== 'win32') return;
  try { regDeleteTree(HKCU_ROOT); } catch {}
  for (const s of SUB_COMMANDS) {
    try { regDeleteTree(`${HKCU_ROOT}.${s.id}`); } catch {}
    try { regDeleteTree(`${HKLM_COMMANDSTORE}\\${s.id}`); } catch {}
  }
}

/**
 * 以管理员身份重新注册折叠子菜单（会触发 UAC）。
 * 供设置页按钮或 dev 脚本调用；调用后建议重启资源管理器或提示用户重开文件夹。
 */
export function registerShellMenuElevated(): void {
  if (process.platform !== 'win32') return;
  try {
    const exe = exePath();
    const packaged = app.isPackaged;
    const args: string[] = ['--register-shell-menu-elevated'];
    if (!packaged) args.push(`"${app.getAppPath()}"`);
    const ps = `Start-Process -FilePath '${exe.replace(/'/g, "''")}' -ArgumentList '${args.join(' ')}' -Verb runAs -WindowStyle Hidden`;
    execSync(ps, { windowsHide: true, stdio: 'ignore' });
  } catch {
    // 用户取消 UAC 或提权失败：忽略
  }
}

// ============ 启动参数解析与队列 ============

export interface ParseCliOptions {
  /** 当前 exe 路径，用于排除 argv 中的自身 */
  exePath?: string;
  /** 应用目录（dev 模式下注册表命令会传入），用于排除被误当文件的仓库目录 */
  appDir?: string;
}

/** 解析 argv：扫描 --vault-* 标志，其后非选项 token 视为文件路径。
 *  显式排除 exe 路径与应用目录，防止 dev 模式把仓库目录（如 C:\cod\electron-vite-vue）当成待加密文件。
 */
export function parseCliFiles(argv: string[], opts: ParseCliOptions = {}): CliItem[] {
  const flagToAction: Record<string, CliAction> = {
    '--vault-encrypt': 'encrypt',
    '--vault-decrypt': 'decrypt',
    '--vault-secure-delete': 'secure-delete',
  };
  const items: CliItem[] = [];
  let cur: CliItem | null = null;

  const normalize = (p: string) =>
    p
      ?.replace(/\\?\"/g, '')
      .replace(/\\$/g, '')
      .toLowerCase();
  const exclude = new Set<string>();
  if (opts.exePath) exclude.add(normalize(opts.exePath));
  if (opts.appDir) exclude.add(normalize(opts.appDir));

  for (const raw of argv) {
    const a = raw.replace(/^"|"$/g, ''); // 去掉外层引号

    // 跳过 --vault-app-dir=... 等命名参数（值里可能含路径）
    if (a.startsWith('--vault-app-dir')) continue;

    if (flagToAction[a]) {
      cur = { action: flagToAction[a], files: [] };
      items.push(cur);
      continue;
    }

    if (!cur) continue; // 标志前的一切 token 都与本功能无关
    if (a.startsWith('-')) continue; // 其它 Electron/Node 选项
    if (exclude.has(normalize(a))) continue; // 排除 exe / appDir，防止误收集仓库目录

    cur.files.push(a);
  }

  // 过滤：只保留真实存在的文件（排除目录/不存在路径）。
  // 这一步是第二道保险，防止注册表/命令行解析异常把仓库目录等目录当成文件传下去。
  for (const it of items) {
    it.files = it.files.filter((f) => {
      try {
        const st = fs.statSync(path.normalize(f));
        return st.isFile();
      } catch {
        return false;
      }
    });
  }

  if (items.length) {
    console.log('[shellMenu] parsed cli items:', JSON.stringify(items), 'exclude:', [...exclude]);
  }

  return items.filter((i) => i.files.length > 0);
}

/** 跨实例聚合队列（多选文件会多次触发 second-instance，聚合成一批） */
let pending: CliItem[] = [];

/** 入队（首次启动读 process.argv，或 second-instance 携带的参数） */
export function queueCli(items: CliItem[]): void {
  if (items && items.length) pending.push(...items);
}

/** 把排队项逐条发给渲染端主窗口；发送后清空队列 */
export function flushPending(win: BrowserWindow | null): void {
  if (!win || pending.length === 0) return;
  const items = pending;
  pending = [];
  for (const it of items) {
    win.webContents.send('app:cli-open', it);
  }
}

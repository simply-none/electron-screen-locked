import { app, BrowserWindow, crashReporter, ipcMain } from "electron";
import os from "node:os";
import { initJob } from "./module/job.ts";
import { initRecurrence } from "./module/recurrence.ts";
import { initFile } from "./module/dialog.ts";
import { initStore } from "./module/store.ts";
import { initBackup } from "./module/backup.ts";
import { initAppLock } from "./module/appLock.ts";
import { initTray } from "./module/tray.ts";
import { initPoetData } from "./module/poetData.ts";
import { initMainWindow, win, showApp } from "./module/mainWindow.ts";
import { initNewWindow } from "./module/newWindow.ts";
import { initSystemInfo } from "./module/systemInfo.ts";
import { initNetRequest } from "./module/netRequest.ts";
import { initClipboard } from "./module/clipboard.ts";
import { registerJlocalProtocol, registerJlocalProtocolBefore } from "./module/protocol.ts";
import { initNewSqlite, ensureTableExists } from "./module/newSql.ts";
import { initNewReminder } from "./module/newReminder.ts";
import { initCountdown } from "./module/countdown.ts";
import { appName } from "./variables.ts";
import { initRegisterShortcut } from "./module/registerShortcut.ts";
import { initSys } from "./module/sys.ts";
import { initLog } from "./module/log.ts";
import { initAutoUpdate } from "./module/autoUpdate.ts";
import { initWeather } from "./module/weather.ts";
import { initCrawler } from "./module/crawler.ts";
import { initDataAcquisition } from "./module/dataAcquisition/index.ts";
import { initLocation } from "./module/location.ts";
import { initBing } from "./module/bing.ts";
import { initTTS } from "./module/tts.ts";
import { initEbook } from "./module/ebook.ts";
import { initScreenshot } from "./module/screenshot.ts";
import { initStock } from "./module/stock.ts";
import { initSinaFinance } from "./module/sinaFinance.ts";
import { initBrowserDownload } from "./module/browserDownload.ts";
import { initBrowserSniffer } from "./module/browserSniffer.ts";
import { initBrowserYtDlp } from "./module/browserYtDlp.ts";
import { initBrowserPermission, setPermissionWindowGetter } from "./module/browserPermission.ts";
import { initDownloader } from "./module/download/index.ts";
import { initResource } from "./module/resource.ts";
import { initResume } from "./module/resume.ts";
import { initQrCode } from "./module/qrcode.ts";
import { initTwoFactor } from "./module/twoFactor.ts";
import { initPasswordVault } from "./module/passwordVault.ts";
import { initFileVault } from "./module/fileVault.ts";
import {
  registerShellMenu,
  initShellMenu,
  parseCliFiles,
  queueCli,
  flushPending,
} from "./module/shellMenu.ts";
import { initPdf } from "./module/pdf.ts";
import { initSafetyProtection } from "./module/safetyProtection.ts";

registerJlocalProtocolBefore()


app.setName(appName);
app.commandLine.appendSwitch("lang", "zh-CN");

crashReporter.start({ submitURL: "", uploadToServer: false });

// Disable GPU Acceleration for Windows 7
if (os.release().startsWith("6.1")) app.disableHardwareAcceleration();

// Set application name for Windows 10+ notifications
if (process.platform === "win32") app.setAppUserModelId(app.getName());

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

async function createWindow() {
  // 注册自定义协议处理器（必须在创建窗口前完成，否则打包后页面加载时
  // jlocal:// 请求会因 handler 未注册而报 ERR_UNKNOWN_URL_SCHEME）
  registerJlocalProtocol();
  // 主窗口
  initMainWindow();
  // 日志
  initLog();
  // 数据库（统一由 newSql 初始化，包含 db.sqlite 与打包宋词库 shiciDb）
  await initNewSqlite();
  // 全新提醒引擎（定点/周期/多状态），依赖 newSql
  await initNewReminder();
  // 倒计时模块（独立调度 + 自有表 countdown）
  await initCountdown();
  // 诗词数据
  initPoetData();
  // 定时任务（番茄钟）
  initJob();
  // 重复任务引擎（启动扫描 + 每日 00:00 生成实例）
  initRecurrence();
  // 修复历史数据：确保待办表 key 列具备唯一索引，并清理重构前遗留的重复记录
  // （旧表常出现「key 列已存在但无唯一约束」，导致 upsert 退化为重复 INSERT —— 编辑变新增）
  ensureTableExists('todo_list', undefined, 'key', { primaryKeyType: 'TEXT' }).catch((e) =>
    console.warn('ensure todo_list key index failed:', e),
  );
  ensureTableExists('todo_tags', undefined, 'id', { primaryKeyType: 'INTEGER' }).catch((e) =>
    console.warn('ensure todo_tags id index failed:', e),
  );
  // 数据缓存
  initStore();
  // 备份与恢复 + 数据导出中心（依赖 newSql 连接池，须在其后初始化）
  initBackup();
  // 文件相关
  initFile();
  // 资源管理（文本预览读取 + 物理文件删除）
  initResource();
  // 应用锁 / 隐私模式（依赖 DB）
  initAppLock();
  // 安全保护（密保）：与 2FA/应用锁共用 vault/crypto 加密架构，密钥来源为设备绑定主密钥
  initSafetyProtection();
  // 托盘图标
  initTray();
  // 系统信息监控
  initSystemInfo();
  // 网络请求工作台（Postman 风格）
  initNetRequest();
  // 新窗口相关
  initNewWindow();
  // 剪贴板（异步：需先补齐新增列，失败不应阻塞启动）
  initClipboard().catch((err) => console.error("initClipboard error:", err));
  // 快捷键注册
  initRegisterShortcut();
  // 系统相关
  initSys();
  // 自动更新
  initAutoUpdate();
  // 天气模块
  initWeather();
  // 新爬虫工具（通用网页爬取）
  initCrawler();
  // 数据获取模块（Puppeteer 任务化采集引擎，独立于天气爬虫）
  initDataAcquisition();
  // 定位模块
  initLocation();
  // Bing 图片模块
  initBing();
  // TTS 语音合成模块
  initTTS();
  // 电子书阅读模块
  await initEbook();
  // 截图模块
  initScreenshot();
  // 股票查询模块（TickFlow，主进程查询，依赖数据库基础表）
  initStock();
  // 新浪财经数据源模块（收益看板 earning：实时行情 / 净值 / 估值，免费无需 Key）
  initSinaFinance();
  // 内置浏览器下载管理（拦截 webview 会话的 will-download）
  initBrowserDownload();
  // 内置浏览器资源嗅探（webRequest 挂钩 persist:browser 会话）
  initBrowserSniffer();
  // 内置浏览器 yt-dlp 视频解析/下载引擎
  initBrowserYtDlp();
  // 内置浏览器站点权限管理（persist:browser 会话权限请求拦截）
  setPermissionWindowGetter(() => win);
  initBrowserPermission();
  // 系统级下载器（多线程分段引擎，接管浏览器下载 + 剪贴板监视）
  await initDownloader();
  // 简历模块（printToPDF 导出）
  initResume();
  // 二维码能力层（保存/复制/打包 IPC + 安全建表 qr_history / qr_template）
  await initQrCode();
  // 2FA 动态验证码模块（保险库在内存 + 用户加密文件，密钥不进应用数据库）
  initTwoFactor();
  // 密码保险库模块（与 2FA 共用同一套 AES-256-GCM + PBKDF2 加密架构）
  initPasswordVault();
  // 私密文件保险箱模块（复用 2FA / 密码保险库的 AES-256-GCM + PBKDF2 安全架构）
  initFileVault();
  // 资源管理器右键菜单（Windows 专属）：注册「通过渐离App打开」菜单（按扩展名限定 + 打开方式 ProgID）
  registerShellMenu();
  // 右键菜单管理 IPC（启用集合 / 默认打开 / 重新注册）
  initShellMenu();
  // PDF 工具箱模块（本地离线 PDF 合并/拆分/组织/导出）
  initPdf();
}

app.whenReady().then(async () => {
  // 首次启动：若通过资源管理器右键带文件参数启动，解析并入队，待渲染端就绪后下发
  queueCli(
    parseCliFiles(process.argv, {
      exePath: process.execPath,
      appDir: app.getAppPath(),
    }),
  );
  createWindow();
});

// 渲染端主窗口就绪后，把排队的右键文件参数发给它（解决首启「发早于监听注册」的竞态）
ipcMain.on('app:cli-ready', () => {
  if (win) flushPending(win);
});

app.on("second-instance", (_e, argv) => {
  // 资源管理器右键多选会多次触发本事件，聚合后一次性下发
  const items = parseCliFiles(argv, {
    exePath: process.execPath,
    appDir: app.getAppPath(),
  });
  if (items.length) queueCli(items);
  if (win) {
    // 只允许打开一个窗口。
    // 注意：应用可能只是被「隐藏到托盘」(win.hide()) 而非最小化，此时
    // isMinimized() 为 false、focus() 无法让隐藏窗口重新可见，导致右键触发的解密
    // /加密/安全删除弹窗在后台静默执行、用户完全看不到。
    // 因此改用 showApp()：无论最小化还是隐藏到托盘，都先确保主窗口可见并置前，
    // 再下发右键参数。
    showApp();
    flushPending(win);
  }
});

app.on("activate", () => {
  const allWindows = BrowserWindow.getAllWindows();
  // 只允许打开一个窗口
  if (allWindows.length > 0) {
    allWindows[0].focus();
  } else {
    createWindow();
  }
});

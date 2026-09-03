import { Tray, Menu, ipcMain, BrowserWindow } from "electron";
import { appLogoPng, appName } from "../variables.ts";
import {
  win,
  hideApp,
  exitApp,
  showApp,
} from "./mainWindow.ts";
import { createOtherWindow, hideOtherWindow } from "./newWindow.ts";
import { store } from "./store.ts";
import { queryByConditions } from "../utils/sql.ts";
import { myDb } from "./newSql.ts";
import { startScreenshotCapture } from "./screenshot.ts";

// 各小窗的兜底配置（与 src/views/windowMode/config/windowSections.ts 的默认尺寸保持一致）。
// createOtherWindow 的兜底尺寸只有 108x81，面板放不下，必须给足尺寸。
const DEFAULT_HABIT_CONFIG = {
  position: "bottom-right",
  width: 420,
  height: 520,
  gap: 30,
  x: 0,
  y: 0,
  skin: "white",
};

const DEFAULT_QUICK_NOTE_CONFIG = {
  position: "bottom-right",
  width: 400,
  height: 300,
  gap: 30,
  x: 0,
  y: 0,
  skin: "white",
  layout: "minimal",
};

const DEFAULT_POMODORO_CONFIG = {
  position: "bottom-right",
  width: 200,
  height: 100,
  gap: 30,
  x: 0,
  y: 0,
  skin: "white",
};

/** 关闭时最小化到托盘的偏好键（持久化在 electron-store） */
const CLOSE_TO_TRAY_KEY = "closeToTray";

let tray: Tray | null = null;

// —— 偏好读写 ——
function isCloseToTray(): boolean {
  try {
    return store.get(CLOSE_TO_TRAY_KEY) === true;
  } catch {
    return false;
  }
}

function setCloseToTray(value: boolean): void {
  try {
    store.set(CLOSE_TO_TRAY_KEY, value);
  } catch {
    /* noop */
  }
}

// —— 打开 / 切换小窗（打卡 / 番茄钟 / 快速记录）——
// 复用 registerShortcut 的成熟模式：命中已存在窗口则隐藏，否则读取 window-mode:{key}
// 配置并以 frameless + 可交互（mouseEvents）方式打开对应路由的小窗。
function openOrToggleMiniWindow(
  arg: string,
  storeKey: string,
  fallback: Record<string, any>
) {
  const existing = BrowserWindow.getAllWindows().find((w) => {
    const url = w.webContents.getURL();
    return url.includes(arg) && url.includes("isSecondWindow=true");
  });
  if (existing && existing.isVisible()) {
    // 已显示则收起到托盘
    hideOtherWindow(arg);
    return;
  }
  queryByConditions({
    db: myDb.db,
    tableName: "basic_info",
    conditions: { whereStr: `key = 'window-mode:${storeKey}'` },
    callback: (err, data) => {
      let config: Record<string, any> = { ...fallback };
      if (!err && data && data.length > 0) {
        try {
          config = { ...config, ...JSON.parse(data[0].value) };
        } catch {
          /* 解析失败则用兜底配置 */
        }
      }
      createOtherWindow(arg, { ...config, mouseEvents: true });
    },
  });
}

// —— 托盘气泡提醒（Windows 专属 displayBalloon）——
// 非 Windows 平台 Electron 无 displayBalloon，需做能力守卫，避免抛错。
function showTrayBalloon(title: string, content: string) {
  if (process.platform !== "win32" || !tray) return;
  try {
    tray.displayBalloon({
      icon: appLogoPng,
      title: title || appName,
      content: content || "",
    });
  } catch {
    /* 个别系统/权限下可能抛错，静默忽略 */
  }
}

/** 构建托盘右键菜单（选项变更后需重建以刷新 checkbox 状态） */
function buildContextMenu(): Menu {
  return Menu.buildFromTemplate([
    // —— 快捷操作区 ——
    {
      label: "打卡",
      click: () =>
        openOrToggleMiniWindow(
          "habitMiniWindow",
          "habitMiniWindow",
          DEFAULT_HABIT_CONFIG
        ),
    },
    {
      label: "番茄钟",
      click: () =>
        openOrToggleMiniWindow("pomodoro", "pomodoro", DEFAULT_POMODORO_CONFIG),
    },
    {
      label: "截图",
      click: () => startScreenshotCapture(),
    },
    {
      label: "快速记录",
      click: () =>
        openOrToggleMiniWindow("quickNote", "quickNote", DEFAULT_QUICK_NOTE_CONFIG),
    },
    { type: "separator" },
    // —— 窗口显隐 ——
    {
      label: "显示应用",
      click: () => {
        if (win) showApp();
      },
    },
    {
      label: "隐藏到托盘",
      click: () => {
        if (win) hideApp();
      },
    },
    { type: "separator" },
    // —— 设置 ——
    {
      label: "设置",
      submenu: [
        {
          label: "关闭时最小化到托盘",
          type: "checkbox",
          checked: isCloseToTray(),
          click: () => {
            setCloseToTray(!isCloseToTray());
            // 重建菜单，使 checkbox 勾选态立即刷新
            if (tray) tray.setContextMenu(buildContextMenu());
          },
        },
      ],
    },
    { type: "separator" },
    {
      label: "退出应用",
      click: () => exitApp(),
    },
  ]);
}

function setTray() {
  tray = new Tray(appLogoPng);
  tray.setToolTip(appName);
  tray.setTitle(appName);
}

/** 托盘气泡提醒通道：渲染端在提醒触发时调用，主进程据此弹出气泡（Windows） */
function initTrayBalloonIpc() {
  ipcMain.on(
    "tray-balloon",
    (_e, payload: { title?: string; content?: string }) => {
      showTrayBalloon(payload?.title || appName, payload?.content || "");
    }
  );
}

export function destroyTray() {
  if (tray) {
    tray.destroy();
    tray = null;
  }
}

export function initTray() {
  setTray();

  tray.setContextMenu(buildContextMenu());

  // 双击托盘图标：仅打开应用界面（不强制顶级置顶，避免屏幕无法点击）
  tray.on("double-click", () => {
    if (win) showApp();
  });

  // 点击气泡：把应用从托盘恢复出来
  if (process.platform === "win32") {
    tray.on("balloon-click", () => {
      if (win) showApp();
    });
  }

  initTrayBalloonIpc();
}

/** 显式弹出托盘气泡（供主进程提醒发射点等直接调用） */
export function notifyTrayBalloon(title: string, content: string) {
  showTrayBalloon(title, content);
}

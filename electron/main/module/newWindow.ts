import { BrowserWindow, ipcMain, screen } from "electron";
import colors from "colors";
import { getAllStore, tableName } from "./store.ts";
import { myDb } from "./newSql.ts";
import {
  appLogoIco,
  appName,
  indexHtml,
  preload,
  VITE_DEV_SERVER_URL,
} from "../variables.ts";
import { queryByConditions, upsertData } from "../utils/sql.ts";
import { objectArrayToObject } from "../utils/common.ts";

let childWindow: Record<string, BrowserWindow | null> = {};
// 获取屏幕宽高
let screenWidth = 0;
let screenHeight = 0;

type PositionType = 
  | 'bottom-right' 
  | 'bottom-left' 
  | 'top-right' 
  | 'top-left' 
  | 'center' 
  | 'center-top' 
  | 'center-bottom' 
  | 'center-left' 
  | 'center-right'
  | 'custom';

interface PositionOps {
  width?: number;
  height?: number;
  gap?: number;
  position?: PositionType;
  x?: number;
  y?: number;
  center?: boolean;
}

function calculatePosition(ops?: PositionOps) {
  const width = ops?.width || 108;
  const height = ops?.height || 81;
  const gap = ops?.gap || 30;
  const position = ops?.position || 'bottom-right';
  
  let x: number;
  let y: number;
  
  switch (position) {
    case 'bottom-right':
      x = screenWidth - width - gap;
      y = screenHeight - height - gap;
      break;
    case 'bottom-left':
      x = gap;
      y = screenHeight - height - gap;
      break;
    case 'top-right':
      x = screenWidth - width - gap;
      y = gap;
      break;
    case 'top-left':
      x = gap;
      y = gap;
      break;
    case 'center':
      x = Math.floor((screenWidth - width) / 2);
      y = Math.floor((screenHeight - height) / 2);
      break;
    case 'center-top':
      x = Math.floor((screenWidth - width) / 2);
      y = gap;
      break;
    case 'center-bottom':
      x = Math.floor((screenWidth - width) / 2);
      y = screenHeight - height - gap;
      break;
    case 'center-left':
      x = gap;
      y = Math.floor((screenHeight - height) / 2);
      break;
    case 'center-right':
      x = screenWidth - width - gap;
      y = Math.floor((screenHeight - height) / 2);
      break;
    case 'custom':
      x = ops?.x ?? 0;
      y = ops?.y ?? 0;
      break;
    default:
      x = screenWidth - width - gap;
      y = screenHeight - height - gap;
  }
  
  return { x, y };
}

// 需要记住拖拽位置的窗口：拖动结束后把坐标回写到配置，下次打开仍在原处。
// 当前为空：剪贴板小窗等不再把位置回写数据库（与 quickNote 一致，避免拖拽触发 SQL 写入）。
// 如某小窗需要记忆位置，把其 arg 加回此数组即可。
const POSITION_MEMORY_WINDOWS: string[] = [];
const positionSaveTimers: Record<string, ReturnType<typeof setTimeout> | null> = {};

/** 把窗口当前坐标写入 window-mode:{arg}，并把定位方式切换为 custom */
function saveWindowPosition(arg: string) {
  const win = childWindow[arg];
  if (!win || win.isDestroyed()) return;
  const [x, y] = win.getPosition();
  const field = `window-mode:${arg}`;
  queryByConditions({
    db: myDb.db,
    tableName: "basic_info",
    conditions: { whereStr: `key = '${field}'` },
    callback: (err, data) => {
      let config: Record<string, any> = {};
      if (!err && Array.isArray(data) && data.length > 0) {
        try {
          config = JSON.parse(data[0].value);
        } catch (e) {
          config = {};
        }
      }
      config.position = "custom";
      config.x = x;
      config.y = y;
      upsertData({
        db: myDb.db,
        tableName: "basic_info",
        data: { key: field, value: JSON.stringify(config) },
        config: { primaryKey: "key" },
        callback: (saveErr) => {
          if (saveErr) {
            console.error("save window position error:", saveErr);
            return;
          }
          // 同步给设置页，避免设置项与实际位置不一致
          BrowserWindow.getAllWindows().forEach((w) => {
            if (!w.isDestroyed()) {
              w.webContents.send("sync-data-to-other-window", { clipboardWindowConfig: config });
            }
          });
        },
      });
    },
  });
}

function getScreenInfo() {
  // 获取屏幕宽高
  const primaryDisplay = screen.getPrimaryDisplay();
  screenWidth = primaryDisplay.size.width;
  screenHeight = primaryDisplay.size.height;
}

export function createOtherWindow(arg: string, ops?: ObjectType, recreate = false) {
  getScreenInfo();
  console.log(arg, 'arg', ops)
  if (childWindow[arg] && !recreate) {
    try {
      childWindow[arg]?.show();
      childWindow[arg]?.focus();
      getAllData(arg, true)
      return;
    } catch (e) {
      createOtherWindow(arg, ops, true)
    }
  }
  let windowOps = ({
    title: appName,
    icon: appLogoIco,
    transparent: ops?.transparent || true,
    center: ops?.center || false,
    resizable: ops?.resizable || false,
    frame: ops?.frame || false,
    fullscreenable: ops?.fullscreenable || false,
    width: ops?.fullscreenable ? null : ops?.width || 108,
    height: ops?.fullscreenable ? null : ops?.height || 81,
    x: ops?.center ? null : calculatePosition(ops).x,
    y: ops?.center ? null : calculatePosition(ops).y,
    webPreferences: {
      preload,
      devTools: true,
      // 加载扩展必须启动该配置
      plugins: true,
      webSecurity: false,
    },
  });
  childWindow[arg] = new BrowserWindow(windowOps)

  childWindow[arg]?.setAlwaysOnTop(true, "screen-saver");
  if (!ops || !ops.mouseEvents) {
    childWindow[arg]?.setIgnoreMouseEvents(true, { forward: true });
  } else {
    childWindow[arg]?.setIgnoreMouseEvents(false);
  }
  childWindow[arg]?.show();
  childWindow[arg]?.focus();
  console.log(arg, '窗口名称')
  if (VITE_DEV_SERVER_URL) {
    childWindow[arg].loadURL(
      `${VITE_DEV_SERVER_URL}#${arg}?isSecondWindow=true`
    );
  } else {
    childWindow[arg].loadFile(indexHtml, {
      hash: arg,
      query: { isSecondWindow: "true" },
    });
  }
  // 不在任务栏显示
  childWindow[arg]?.setSkipTaskbar(true);

  // 位置记忆：拖动结束后防抖回写坐标
  if (POSITION_MEMORY_WINDOWS.includes(arg)) {
    childWindow[arg]?.on("move", () => {
      if (positionSaveTimers[arg]) clearTimeout(positionSaveTimers[arg]!);
      positionSaveTimers[arg] = setTimeout(() => saveWindowPosition(arg), 400);
    });
  }

  childWindow[arg]?.on("close", (e) => {
    e.preventDefault(); //先阻止一下默认行为，不然直接关了，提示框只会闪一下
    hideOtherWindow(arg);
  });

  getAllData(arg)
}

function getAllData(arg, immediately = false) {
  queryByConditions({
    db: myDb.db,
    tableName: tableName,
    conditions: {},
    callback: (err, data) => {
      let res = null
      if (err) {
        console.log(err, "err");
        res = "error";
      } else {
        res = objectArrayToObject(data);
      }
      if (immediately) {
        childWindow[arg].webContents.send("sync-data-to-other-window", {
          ...res,
        });
      } else {
        setTimeout(() => {
          childWindow[arg].webContents.send("sync-data-to-other-window", {
            ...res,
          });
        }, 2000);
      }
    },
  });
}

export function closeOtherWindow(arg) {
  if (childWindow) {
    try {
      childWindow[arg]?.close();
      childWindow[arg]?.destroy();
      childWindow[arg] = null;
    } catch (e) {
      // console.log(e, "closeOtherWindow")
    }
  }
}

export function hideOtherWindow(arg) {
  if (childWindow) {
    childWindow[arg]?.hide();
  }
}

export function showOtherWindow(arg) {
  if (childWindow) {
    childWindow[arg]?.show();
    childWindow[arg]?.focus();
  }
}

export function initNewWindow() {
  ipcMain.on("close-win", async (_, arg) => {
    closeOtherWindow(arg);
  });

  // 打开新窗口
  ipcMain.on("open-new-window", (_, newWindowName, ops: ObjectType) => {
    createOtherWindow(newWindowName, ops);
  });
  // 关闭新窗口
  ipcMain.on("close-new-window", (_, newWindowName) => {
    closeOtherWindow(newWindowName);
  });
  // 隐藏新窗口
  ipcMain.on("hide-new-window", (_, newWindowName) => {
    hideOtherWindow(newWindowName);
  });

  ipcMain.on("sync-data-to-other-window", (event, arg) => {
    // console.log(colors.bgGreen(arg), 'in sync-data-to-other-window');

    // 遍历window
    const allWindows = BrowserWindow.getAllWindows();
    // 获取发送事件的窗口id
    const sendId = event.sender.id;
    // 根据id匹配窗口
    allWindows.map((item) => {
      if (item.id != sendId && !item.isDestroyed()) {
        // 判断是否show，未展示继续隐藏
        let isShow = item.isVisible();
        // 保持窗口处于活跃状态，避免假卡死
        item.showInactive();
        // 向匹配的窗口发送消息，同步数据
        item.webContents.send("sync-data-to-other-window", arg);
        if (!isShow) {
          item.hide();
        }
      }
    });
  });

  // 禁止窗口的鼠标穿透事件
  ipcMain.on("disable-mouse-click-through", (_, arg) => {
    console.log(colors.bgCyan(arg));
    if (typeof arg !== "string") return;
    if (childWindow[arg]) {
      childWindow[arg]?.setIgnoreMouseEvents(false);
    }
  });

  // 允许窗口的鼠标穿透事件
  ipcMain.on("enable-mouse-click-through", (_, arg) => {
    console.log(colors.bgCyan(arg), "enable-mouse-click-through");
    if (typeof arg !== "string") return;
    if (childWindow[arg]) {
      childWindow[arg]?.setIgnoreMouseEvents(true, { forward: true });
    }
  });

  // 剪贴板小窗：透明窗口下 -webkit-app-region:drag 不可靠，改用 JS 拖拽。
  // 渲染端在 mousedown 时读取窗口当前坐标，mousemove 时下发新坐标，本进程用 setBounds 移动。
  ipcMain.on("get-window-bounds", (e, arg) => {
    const win = childWindow[arg];
    if (win && !win.isDestroyed()) {
      const b = win.getBounds();
      e.returnValue = { x: b.x, y: b.y, width: b.width, height: b.height };
    } else {
      e.returnValue = null;
    }
  });
  // 拖拽移动窗口：必须原样回传 width/height，否则 Windows 透明无边框窗口在
  // DPI 缩放下会被系统按内容尺寸重新评估，导致拖动过程中窗口尺寸抖动/变化。
  ipcMain.on("set-window-bounds", (_, arg, bounds) => {
    const win = childWindow[arg];
    if (win && !win.isDestroyed() && bounds) {
      const cur = win.getBounds();
      win.setBounds({
        x: Math.round(bounds.x),
        y: Math.round(bounds.y),
        width: Math.round(bounds.width ?? cur.width),
        height: Math.round(bounds.height ?? cur.height),
      });
    }
  });
}

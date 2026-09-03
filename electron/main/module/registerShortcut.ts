import { createTable, queryByConditions, upsertData } from "../utils/sql.ts";
import { win, hideApp, focusAppToTop } from "./mainWindow.ts";
import moment from "moment";
import { myDb } from "./newSql.ts";
import { clipboard, ipcMain, globalShortcut, BrowserWindow } from "electron";
import colors from "colors";
import { createOtherWindow, hideOtherWindow } from "./newWindow.ts";
import { lockAppNow, togglePrivacyHide } from "./appLock.ts";

export const tableName = "register_shortcut";

/** 命令面板小窗的默认配置：createOtherWindow 的兜底尺寸只有 108x81，必须给足尺寸 */
const DEFAULT_COMMAND_PALETTE_CONFIG = {
  position: "center-top",
  width: 640,
  height: 460,
  gap: 30,
  x: 0,
  y: 0,
  skin: "white",
};

const DEFAULT_HABIT_CONFIG = {
  position: "bottom-right",
  width: 420,
  height: 520,
  gap: 30,
  x: 0,
  y: 0,
  skin: "white",
};

const DEFAULT_COUNTDOWN_CONFIG = {
  position: "bottom-right",
  width: 300,
  height: 380,
  gap: 30,
  x: 0,
  y: 0,
  skin: "white",
};

const DEFAULT_APP_2FA_CONFIG = {
  position: "bottom-right",
  width: 360,
  height: 520,
  gap: 30,
  x: 0,
  y: 0,
  skin: "white",
};

function openMatchPage(url: string) {
  win.show();
  win.webContents.send("open-match-page", url);
}

async function showApp() {
  if (win.isVisible()) {
    // 纯隐藏：不再驱动番茄钟状态机，确保锁屏态下也能正常隐藏/切走
    hideApp();
  } else {
    // 纯显示：恢复窗口（锁屏态下重新打开为普通显示、不顶级置顶，
    // 用户可自由切走；只有状态机重新进入 lock 态才会再次顶级置顶）
    win.show();
  }
}

function toggleQuickNoteWindow() {
  const quickNoteWin = getQuickNoteWindow();
  if (quickNoteWin && quickNoteWin.isVisible()) {
    hideOtherWindow("quickNote");
  } else {
    queryByConditions({
      db: myDb.db,
      tableName: "basic_info",
      conditions: {
        whereStr: "key = 'window-mode:quickNote'",
      },
      callback: (err, data) => {
        if (err) {
          console.log(err, "err");
          createOtherWindow("quickNote", { mouseEvents: true });
          return;
        }
        let config = {};
        if (data && data.length > 0) {
          try {
            config = JSON.parse(data[0].value);
          } catch (e) {
            console.log(e, "parse error");
          }
        }
        createOtherWindow("quickNote", { ...config, mouseEvents: true });
      },
    });
  }
}

function getQuickNoteWindow() {
  const allWindows = BrowserWindow.getAllWindows();
  return allWindows.find((w) => {
    const url = w.webContents.getURL();
    return url.includes("quickNote") && url.includes("isSecondWindow=true");
  });
}

function toggleTodoWindow() {
  const todoWin = getTodoWindow();
  if (todoWin && todoWin.isVisible()) {
    hideOtherWindow("todoMiniWindow");
  } else {
    queryByConditions({
      db: myDb.db,
      tableName: "basic_info",
      conditions: {
        whereStr: "key = 'window-mode:todoMiniWindow'",
      },
      callback: (err, data) => {
        if (err) {
          console.log(err, "err");
          createOtherWindow("todoMiniWindow", { mouseEvents: true });
          return;
        }
        let config = {};
        if (data && data.length > 0) {
          try {
            config = JSON.parse(data[0].value);
          } catch (e) {
            console.log(e, "parse error");
          }
        }
        createOtherWindow("todoMiniWindow", { ...config, mouseEvents: true });
      },
    });
  }
}

function getTodoWindow() {
  const allWindows = BrowserWindow.getAllWindows();
  return allWindows.find((w) => {
    const url = w.webContents.getURL();
    return url.includes("todoMiniWindow") && url.includes("isSecondWindow=true");
  });
}

function togglePomodoroWindow() {
  const pomodoroWin = getPomodoroWindow();
  if (pomodoroWin && pomodoroWin.isVisible()) {
    hideOtherWindow("pomodoro");
  } else {
    queryByConditions({
      db: myDb.db,
      tableName: "basic_info",
      conditions: {
        whereStr: "key = 'window-mode:pomodoro'",
      },
      callback: (err, data) => {
        if (err) {
          console.log(err, "err");
          createOtherWindow("pomodoro", { mouseEvents: true });
          return;
        }
        let config = {};
        if (data && data.length > 0) {
          try {
            config = JSON.parse(data[0].value);
          } catch (e) {
            console.log(e, "parse error");
          }
        }
        createOtherWindow("pomodoro", { ...config, mouseEvents: true });
      },
    });
  }
}

function toggleClipboardWindow() {
  const clipboardWin = getClipboardWindow();
  if (clipboardWin && clipboardWin.isVisible()) {
    hideOtherWindow("clipboardMiniWindow");
  } else {
    queryByConditions({
      db: myDb.db,
      tableName: "basic_info",
      conditions: {
        whereStr: "key = 'window-mode:clipboardMiniWindow'",
      },
      callback: (err, data) => {
        if (err) {
          console.log(err, "err");
          createOtherWindow("clipboardMiniWindow", { mouseEvents: true });
          return;
        }
        // 无历史配置时用面板默认尺寸兜底（createOtherWindow 的兜底尺寸只有 108x81，面板放不下）
        let config = {
          position: 'bottom-right',
          width: 520,
          height: 560,
          gap: 30,
          x: 0,
          y: 0,
          skin: 'white',
          layout: 'list',
        };
        if (data && data.length > 0) {
          try {
            config = { ...config, ...JSON.parse(data[0].value) };
          } catch (e) {
            console.log(e, "parse error");
          }
        }
        // 拖拽不再记忆位置（与 quickNote 一致、避免写库）：忽略历史 custom 坐标，
        // 始终回到默认位置（bottom-right），下次唤出不会复用旧坐标。
        config.position = "bottom-right";
        createOtherWindow("clipboardMiniWindow", { ...config, mouseEvents: true });
      },
    });
  }
}

function getClipboardWindow() {
  const allWindows = BrowserWindow.getAllWindows();
  return allWindows.find((w) => {
    const url = w.webContents.getURL();
    return url.includes("clipboardMiniWindow") && url.includes("isSecondWindow=true");
  });
}

function toggleCommandPaletteWindow() {
  const paletteWin = getCommandPaletteWindow();
  if (paletteWin && paletteWin.isVisible()) {
    hideOtherWindow("commandPaletteMiniWindow");
  } else {
    queryByConditions({
      db: myDb.db,
      tableName: "basic_info",
      conditions: {
        whereStr: "key = 'window-mode:commandPaletteMiniWindow'",
      },
      callback: (err, data) => {
        if (err) {
          console.log(err, "err");
          createOtherWindow("commandPaletteMiniWindow", { ...DEFAULT_COMMAND_PALETTE_CONFIG, mouseEvents: true });
          return;
        }
        // 无历史配置时用面板默认尺寸兜底（createOtherWindow 的兜底尺寸只有 108x81，面板放不下）
        let config = { ...DEFAULT_COMMAND_PALETTE_CONFIG };
        if (data && data.length > 0) {
          try {
            config = { ...config, ...JSON.parse(data[0].value) };
          } catch (e) {
            console.log(e, "parse error");
          }
        }
        createOtherWindow("commandPaletteMiniWindow", { ...config, mouseEvents: true });
      },
    });
  }
}

function getCommandPaletteWindow() {
  const allWindows = BrowserWindow.getAllWindows();
  return allWindows.find((w) => {
    const url = w.webContents.getURL();
    return url.includes("commandPaletteMiniWindow") && url.includes("isSecondWindow=true");
  });
}

function toggleHabitWindow() {
  const habitWin = getHabitWindow();
  if (habitWin && habitWin.isVisible()) {
    hideOtherWindow("habitMiniWindow");
  } else {
    queryByConditions({
      db: myDb.db,
      tableName: "basic_info",
      conditions: {
        whereStr: "key = 'window-mode:habitMiniWindow'",
      },
      callback: (err, data) => {
        if (err) {
          console.log(err, "err");
          createOtherWindow("habitMiniWindow", { ...DEFAULT_HABIT_CONFIG, mouseEvents: true });
          return;
        }
        // 无历史配置时用面板默认尺寸兜底（createOtherWindow 的兜底尺寸只有 108x81，放不下）
        let config = { ...DEFAULT_HABIT_CONFIG };
        if (data && data.length > 0) {
          try {
            config = { ...config, ...JSON.parse(data[0].value) };
          } catch (e) {
            console.log(e, "parse error");
          }
        }
        createOtherWindow("habitMiniWindow", { ...config, mouseEvents: true });
      },
    });
  }
}

function getHabitWindow() {
  const allWindows = BrowserWindow.getAllWindows();
  return allWindows.find((w) => {
    const url = w.webContents.getURL();
    return url.includes("habitMiniWindow") && url.includes("isSecondWindow=true");
  });
}

function toggleCountdownWindow() {
  const cdWin = getCountdownWindow();
  if (cdWin && cdWin.isVisible()) {
    hideOtherWindow("countdownMiniWindow");
  } else {
    queryByConditions({
      db: myDb.db,
      tableName: "basic_info",
      conditions: {
        whereStr: "key = 'window-mode:countdownMiniWindow'",
      },
      callback: (err, data) => {
        if (err) {
          console.log(err, "err");
          createOtherWindow("countdownMiniWindow", { ...DEFAULT_COUNTDOWN_CONFIG, mouseEvents: true });
          return;
        }
        let config = { ...DEFAULT_COUNTDOWN_CONFIG };
        if (data && data.length) {
          try {
            const parsed = JSON.parse(data[0].value);
            config = { ...config, ...parsed };
          } catch (e) {
            console.log(e, "parse error");
          }
        }
        createOtherWindow("countdownMiniWindow", { ...config, mouseEvents: true });
      },
    });
  }
}

function getCountdownWindow() {
  const allWindows = BrowserWindow.getAllWindows();
  return allWindows.find((w) => {
    const url = w.webContents.getURL();
    return url.includes("countdownMiniWindow") && url.includes("isSecondWindow=true");
  });
}

function toggleAppTwoFactorWindow() {
  const a2fWin = getAppTwoFactorWindow();
  if (a2fWin && a2fWin.isVisible()) {
    hideOtherWindow("appTwoFactorMiniWindow");
  } else {
    queryByConditions({
      db: myDb.db,
      tableName: "basic_info",
      conditions: {
        whereStr: "key = 'window-mode:appTwoFactorMiniWindow'",
      },
      callback: (err, data) => {
        if (err) {
          console.log(err, "err");
          createOtherWindow("appTwoFactorMiniWindow", { ...DEFAULT_APP_2FA_CONFIG, mouseEvents: true });
          return;
        }
        let config = { ...DEFAULT_APP_2FA_CONFIG };
        if (data && data.length > 0) {
          try {
            config = { ...config, ...JSON.parse(data[0].value) };
          } catch (e) {
            console.log(e, "parse error");
          }
        }
        createOtherWindow("appTwoFactorMiniWindow", { ...config, mouseEvents: true });
      },
    });
  }
}

function getAppTwoFactorWindow() {
  const allWindows = BrowserWindow.getAllWindows();
  return allWindows.find((w) => {
    const url = w.webContents.getURL();
    return url.includes("appTwoFactorMiniWindow") && url.includes("isSecondWindow=true");
  });
}

function getPomodoroWindow() {
  const allWindows = BrowserWindow.getAllWindows();
  return allWindows.find((w) => {
    const url = w.webContents.getURL();
    return url.includes("pomodoro") && url.includes("isSecondWindow=true");
  });
}

export function initRegisterShortcut() {
  createTable({
    db: myDb.db,
    tableName: tableName,
    config: {
      primaryKey: "key",
    },
    callback: async (err, res) => {
      if (!err) {
        await queryByConditions({
          db: myDb.db,
          tableName,
          conditions: {},
          callback: (err, res) => {
            if (err) {
              console.error(err);
              return;
            }
            // 判断是否是数组
            if (Array.isArray(res)) {
              res.forEach((item) => {
                globalShortcutFn(item);
              });
            }
          },
        });
      }
    },
  });

  ipcMain.on("register-shortcut", (event, shortcutOps) => {
    console.log(shortcutOps);
    globalShortcutFn(shortcutOps);
  });
}

function globalShortcutFn(item) {
  globalShortcut.register(item.shortcut, () => {
    if (item.type === "open_match_page") {
      openMatchPage(item.url);
    }
    else if (item.type == 'show_app') {
      showApp();
    }
    else if (item.type == 'open_quick_note') {
      toggleQuickNoteWindow();
    }
    else if (item.type == 'open_todo_window') {
      toggleTodoWindow();
    }
    else if (item.type == 'open_pomodoro_window') {
      togglePomodoroWindow();
    }
    else if (item.type == 'open_clipboard_window') {
      toggleClipboardWindow();
    }
    else if (item.type == 'open_command_palette') {
      toggleCommandPaletteWindow();
    }
    else if (item.type == 'open_habit_window') {
      toggleHabitWindow();
    }
    else if (item.type == 'open_countdown_window') {
      toggleCountdownWindow();
    }
    else if (item.type == 'open_app_2fa_window') {
      toggleAppTwoFactorWindow();
    }
    else if (item.type == 'lock_app') {
      lockAppNow();
    }
    else if (item.type == 'privacy_hide') {
      togglePrivacyHide();
    }
    console.log("Electron loves global shortcuts!");
  });
}

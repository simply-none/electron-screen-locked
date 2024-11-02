import { app, BrowserWindow, shell, ipcMain, dialog, globalShortcut, Tray, nativeImage } from 'electron'
import tray from './tray'

export function focusAppToTop(win) {
  win?.setAlwaysOnTop(true, "screen-saver")
  win?.setFullScreen(true)
  win?.show()
  win?.focus();
}

export function hideApp(win) {
  win?.setAlwaysOnTop(false)
  win?.hide();
}

export function exitApp(win, app) {
  win = null
  globalShortcut.unregisterAll();
  tray?.destroy();
  app.exit();
}
import { app, BrowserWindow, shell, ipcMain, dialog, globalShortcut, Tray, nativeImage } from 'electron'

import { focusAppToTop } from './common'
// Test actively push message to the Electron-Renderer
function didFinishLoad(win) {
  win.webContents.on('did-finish-load', () => {
    win?.webContents.send('main-process-message', new Date().toLocaleString())
    focusAppToTop(win)
  })
}


// Make all links open with the browser, not with the application
function setWindowOpenHandler(win) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:')) shell.openExternal(url)
    return { action: 'deny' }
  })
}

function close(win) {
  win.on('close', e => {
    e.preventDefault(); //先阻止一下默认行为，不然直接关了，提示框只会闪一下
    win.webContents.send('before-close')
  });
}

export default {
  close,
  didFinishLoad,
  setWindowOpenHandler,
}

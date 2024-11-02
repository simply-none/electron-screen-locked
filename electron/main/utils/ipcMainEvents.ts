import { app, BrowserWindow, shell, ipcMain, dialog, globalShortcut, Tray, nativeImage } from 'electron'
import store from './store'
import { hideApp, focusAppToTop } from './common'

let timer = null

// 最大化
function max(win) {
  ipcMain.on("max", (e, fullScreen: boolean) => {
    win!.setFullScreen(fullScreen);
    e.returnValue = fullScreen;
  });
}


function startWork(win) {
  ipcMain.on("start-work", (e, workTimeGap: number) => {
    hideApp(win)
    if (timer) {
      clearTimeout(timer)
    }
    timer = setTimeout(() => {
      // 工作结束 强制休息
      win?.webContents.send('close-work')
    }, workTimeGap)
  });
}

function startRest(win) {
  ipcMain.on("start-rest", (e, restTimeGap: number) => {
    focusAppToTop(win)
    if (timer) {
      clearTimeout(timer)
    }
    timer = setTimeout(() => {
      // 休息完之后可以工作操作电脑了
      hideApp(win)
      win?.webContents.send('close-rest')
    }, restTimeGap)
  });
}



function getStore() {
  ipcMain.on("get-store", (e, key: any) => {
    e.returnValue = store.get(key)
  });

}
function setStore() {
  ipcMain.on("set-store", (e, key: any, value: any) => {
    if (key === 'multi-field') {
      e.returnValue = store.set(value)
    } else {
      e.returnValue = store.set(key, value)
    }
  });
}

function clearStore() {
  ipcMain.on("clear-store", (e) => {
    store.clear()
    e.returnValue = '清空成功'
  });
}

export default {
  max,
  startWork,
  startRest,
  getStore,
  setStore,
  clearStore
}

import { app, BrowserWindow, shell, ipcMain, dialog, globalShortcut, Tray, nativeImage } from 'electron'
import path from 'node:path'

let tray: any = null


interface AttrsType {
  win?: any
}

export default function createTray() {
  const icon = path.join(app.getAppPath(), 'public/logo.png')
  tray = new Tray(icon)
  tray.setToolTip('Electron-setToolTip')
  tray.setTitle('Electron-setTitle')
}

export function trayEvents(name, attrs: AttrsType) {
  switch (name) {
    case 'click':
      trayClickEvent(attrs)
      break
  }

}

function trayClickEvent({ win }: AttrsType) {
  tray.on('click', () => {
    // 这里仅仅打开应用界面，不调用 focusAppToTop()，不然屏幕无法点击
    win.show()
  })
}

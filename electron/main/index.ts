import { app, BrowserWindow, shell, ipcMain, dialog, globalShortcut, Tray, Menu, nativeImage, crashReporter } from 'electron'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import ElectronStore from 'electron-store'
import { readFileList, readJsonFileContent } from './utils/common.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

process.env.APP_ROOT = path.join(__dirname, '../..')

export const MAIN_DIST = path.join(process.env.APP_ROOT, 'dist-electron')
export const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist')
export const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL
  ? path.join(process.env.APP_ROOT, 'public')
  : RENDERER_DIST

let store = new ElectronStore()

let win: BrowserWindow | null = null
const preload = path.join(__dirname, '../preload/index.mjs')
const indexHtml = path.join(RENDERER_DIST, 'index.html')

let timer = null
let tray = null
let poetDataPathList = null
const icon = path.join(process.env.VITE_PUBLIC, 'logo.png')


export function focusAppToTop() {
  win?.setAlwaysOnTop(true, "screen-saver")
  win?.setFullScreen(true)
  win?.show()
  win?.focus();
}

export function hideApp() {
  win?.setAlwaysOnTop(false)
  win?.hide();
}

export function exitApp() {
  const allWindows = BrowserWindow.getAllWindows()
  if (allWindows.length > 0) {
    for (let window of allWindows) {
      if (window && !window.isDestroyed()) {
        win.removeAllListeners()
        window.destroy()
        window = null
      }
    }
  }
  globalShortcut.unregisterAll();
  tray?.destroy();
  app.removeAllListeners()
  app.exit()
}

crashReporter.start({ submitURL: '', uploadToServer: false })

// Disable GPU Acceleration for Windows 7
if (os.release().startsWith('6.1')) app.disableHardwareAcceleration()

// Set application name for Windows 10+ notifications
if (process.platform === 'win32') app.setAppUserModelId(app.getName())

if (!app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
}

async function createWindow() {
  win = new BrowserWindow({
    title: 'Main window',
    icon: path.join(process.env.VITE_PUBLIC, 'favicon.ico'),
    transparent: true,
    resizable: false,
    frame: false,
    fullscreenable: true,

    webPreferences: {
      preload,
      devTools: true,
    },
  })

  if (VITE_DEV_SERVER_URL) { // #298
    win.loadURL(VITE_DEV_SERVER_URL)
    // Open devTool if the app is not packaged
    win.webContents.openDevTools()
  } else {
    win.loadFile(indexHtml)
  }
  ipcMain.on("quit-app", (e, fullScreen: string) => {
    exitApp()
  });
  ipcMain.on("max", (e, fullScreen: boolean) => {
    win!.setFullScreen(fullScreen);
    e.returnValue = fullScreen;
  });
  ipcMain.on("set-startup", (e, isStartup: boolean) => {
    //注意：非开发环境
    if (!VITE_DEV_SERVER_URL) {
      if (process.platform === "darwin") {
        app.setLoginItemSettings({
          openAtLogin: isStartup,//是否开机启动
          openAsHidden: false//是否隐藏主窗体，保留托盘位置
        });
      } else {
        app.setLoginItemSettings({
          openAtLogin: isStartup,
          openAsHidden: false,
        });
      }
    }

    app.setLoginItemSettings({
      openAtLogin: isStartup,
      // 如果应用以管理员身份运行，设置此选项为true可避免UAC（用户账户控制）对话框在Windows上弹出。
      openAsHidden: false, // macOS特有的，当设置为true时，应用会隐藏式启动
    })
  });
  ipcMain.on("poet-data", (e, fullScreen: boolean) => {
    // 获取诗词数据，用于首页展示
    poetDataPathList = readFileList(path.join(process.env.VITE_PUBLIC, '/宋词/'), ['.json'])
    let randomFile = poetDataPathList[Math.floor(Math.random() * poetDataPathList.length)]
    let randomPoetData = readJsonFileContent(randomFile)
    e.returnValue = randomPoetData;
  });
  ipcMain.on("hide-app", (e) => {
    hideApp()
  });
  ipcMain.on("start-work", (e, workTimeGap: number) => {
    hideApp()
    if (timer) {
      clearTimeout(timer)
    }
    timer = setTimeout(() => {
      // 工作结束 强制休息
      win?.webContents.send('close-work')
    }, workTimeGap)
  });
  ipcMain.on("start-rest", (e, restTimeGap: number) => {
    focusAppToTop()
    if (timer) {
      clearTimeout(timer)
    }
    timer = setTimeout(() => {
      // 休息完之后可以工作操作电脑了
      hideApp()
      win?.webContents.send('close-rest')
    }, restTimeGap)
  });
  ipcMain.on("get-store", (e, key: any) => {
    e.returnValue = store.get(key)
  });
  ipcMain.on("set-store", (e, key: any, value: any) => {
    if (key === 'multi-field') {
      e.returnValue = store.set(value)
    } else {
      e.returnValue = store.set(key, value)
    }
  });
  ipcMain.on("clear-store", (e) => {
    store.clear()
    e.returnValue = '清空成功'
  });

  tray = new Tray(icon)
  tray.setToolTip('Electron-setToolTip')
  tray.setTitle('Electron-setTitle')
  const contextMenu = Menu.buildFromTemplate([
    {
      label: '隐藏应用', click: () => {
        if (win) {
          hideApp()
        }
      }
    },
    {
      label: '打开应用', click: () => {
        if (win) {
          win.show()
        }
      }
    },
  ])
  tray.setContextMenu(contextMenu)

  tray.on('double-click', () => {
    // 这里仅仅打开应用界面，不调用 focusAppToTop()，不然屏幕无法点击
    win.show()
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:')) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('did-finish-load', () => {
    win?.webContents.send('main-process-message', new Date().toLocaleString())
    focusAppToTop()
  })
  win.on('close', e => {
    e.preventDefault(); //先阻止一下默认行为，不然直接关了，提示框只会闪一下
    win.webContents.send('before-close')
  });
}

app.whenReady().then(createWindow)

app.on('window-all-closed', (e) => {
  e.preventDefault(); //先阻止一下默认行为，不然直接关了，提示框只会闪一下
  app?.exit()
})

app.on('second-instance', () => {
  if (win) {
    // Focus on the main window if the user tried to open another
    if (win.isMinimized()) win.restore()
    win.focus()
  }
})

app.on('activate', () => {
  const allWindows = BrowserWindow.getAllWindows()
  if (allWindows.length > 0) {
    allWindows[0].focus()
  } else {
    createWindow()
  }
})

// New window example arg: new windows url
ipcMain.handle('open-win', (_, arg) => {
  const childWindow = new BrowserWindow({
    webPreferences: {
      preload,
      nodeIntegration: true,
      contextIsolation: false,
    },
  })

  if (VITE_DEV_SERVER_URL) {
    childWindow.loadURL(`${VITE_DEV_SERVER_URL}#${arg}`)
  } else {
    childWindow.loadFile(indexHtml, { hash: arg })
  }
})

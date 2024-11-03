import { ref } from "vue"

export default function useSetting() {
  // 强制解锁屏幕限制（即可以玩电脑）
  const storeForceWorkTimes = window.ipcRenderer.sendSync('get-store', 'forceWorkTimes') || 0
  const storeTodayForceWorkTimes = window.ipcRenderer.sendSync('get-store', 'todayForceWorkTimes') || 0
  // 其他设置
  const storeAppInnerColor = window.ipcRenderer.sendSync('get-store', 'appInnerColor') || '#ffffff'
  const storeAppBgColor = window.ipcRenderer.sendSync('get-store', 'appBgColor') || '#d4d4d4'

  // 同步设置到缓存
  window.ipcRenderer.sendSync('set-store', 'forceWorkTimes', storeForceWorkTimes);
  window.ipcRenderer.sendSync('set-store', 'todayForceWorkTimes', storeTodayForceWorkTimes);
  window.ipcRenderer.sendSync('set-store', 'appInnerColor', storeAppInnerColor);
  window.ipcRenderer.sendSync('set-store', 'appBgColor', storeAppBgColor);

  // 引用设置
  const forceWorkTimes = ref(window.ipcRenderer.sendSync('get-store', 'forceWorkTimes'))
  const todayForceWorkTimes = ref(window.ipcRenderer.sendSync('get-store', 'todayForceWorkTimes'))
  const appInnerColor = ref(window.ipcRenderer.sendSync('get-store', 'appInnerColor') || '#ffffff')
  const appBgColor = ref(window.ipcRenderer.sendSync('get-store', 'appBgColor') || '#d4d4d4')

  function setForceWorkTimes(value: number) {
    forceWorkTimes.value = value
    window.ipcRenderer.sendSync('set-store', 'forceWorkTimes', value)
  }

  function setTodayForceWorkTimes (value: number) {
    todayForceWorkTimes.value = value
    window.ipcRenderer.sendSync('set-store', 'todayForceWorkTimes', value)
  }

  function setAppInnerColor (value: string) {
    appInnerColor.value = value
    window.ipcRenderer.sendSync('set-store', 'appInnerColor', value)
  }

  function setAppBgColor (value: string) {
    console.warn(value)
    appBgColor.value = value
    window.ipcRenderer.sendSync('set-store', 'appBgColor', value)
  }

  return {
    forceWorkTimes,
    todayForceWorkTimes,
    setForceWorkTimes,
    setTodayForceWorkTimes,
    appInnerColor,
    appBgColor,
    setAppInnerColor,
    setAppBgColor
  }
}
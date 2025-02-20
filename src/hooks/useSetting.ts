import { ref } from "vue"
import moment from 'moment'

export default function useSetting() {
  // 强制解锁屏幕限制（即可以玩电脑）
  const storeForceWorkTimes = window.ipcRenderer.sendSync('get-store', 'forceWorkTimes') || 0
  let storeTodayForceWorkTimes = window.ipcRenderer.sendSync('get-store', 'todayForceWorkTimes')
  if (typeof storeTodayForceWorkTimes !== 'object') {
    storeTodayForceWorkTimes = {
      today: moment().format('YYYY/MM/DD'),
      times: storeTodayForceWorkTimes || 0,
    }
  } else {
    const today = moment().format('YYYY/MM/DD')
    if (storeTodayForceWorkTimes.today !== today) {
      storeTodayForceWorkTimes = {
        today: moment().format('YYYY/MM/DD'),
        times: storeForceWorkTimes || 0,
      }
    }
  }
  // 其他设置
  const storeAppInnerColor = window.ipcRenderer.sendSync('get-store', 'appInnerColor') || '#ffffff'
  const storeAppBgColor = window.ipcRenderer.sendSync('get-store', 'appBgColor') || '#d4d4d4'
  // 系统设置
  const storeIsStartup = window.ipcRenderer.sendSync('get-store', 'isStartup') || false

  // 同步设置到缓存
  window.ipcRenderer.sendSync('set-store', 'forceWorkTimes', storeForceWorkTimes);
  window.ipcRenderer.sendSync('set-store', 'todayForceWorkTimes', storeTodayForceWorkTimes);
  window.ipcRenderer.sendSync('set-store', 'appInnerColor', storeAppInnerColor);
  window.ipcRenderer.sendSync('set-store', 'appBgColor', storeAppBgColor);
  window.ipcRenderer.sendSync('set-store', 'isStartup', storeIsStartup)

  // 引用设置
  const forceWorkTimes = ref(window.ipcRenderer.sendSync('get-store', 'forceWorkTimes'))
  const todayForceWorkTimes = ref(window.ipcRenderer.sendSync('get-store', 'todayForceWorkTimes'))
  const appInnerColor = ref(window.ipcRenderer.sendSync('get-store', 'appInnerColor') || '#ffffff')
  const appBgColor = ref(window.ipcRenderer.sendSync('get-store', 'appBgColor') || '#d4d4d4')
  const isStartup = ref(window.ipcRenderer.sendSync('get-store', 'isStartup') || false)
  const restBg = ref(window.ipcRenderer.sendSync('get-store', 'restBg') || '1')
  const globalFont = ref(window.ipcRenderer.sendSync('get-store', 'globalFont') || '')

  function setForceWorkTimes(value: number) {
    forceWorkTimes.value = value
    window.ipcRenderer.sendSync('set-store', 'forceWorkTimes', value)
  }

  function setTodayForceWorkTimes (value: number) {
    const t = {
      today: moment().format('YYYY/MM/DD'),
      times: value
    }
    todayForceWorkTimes.value = t
    window.ipcRenderer.sendSync('set-store', 'todayForceWorkTimes', t)
  }

  function setAppInnerColor (value: string) {
    appInnerColor.value = value
    window.ipcRenderer.sendSync('set-store', 'appInnerColor', value)
  }

  function setIsStartup (value: boolean) {
    isStartup.value = value
    window.ipcRenderer.sendSync('set-store', 'isStartup', value)
    window.ipcRenderer.send('set-startup', value)
  }

  function setAppBgColor (value: string) {
    console.warn(value)
    appBgColor.value = value
    window.ipcRenderer.sendSync('set-store', 'appBgColor', value)
  }

  // 休息时的背景选择
  const restBgOps = [
    { label: '模拟Windows更新', value: '1'},
    { label: 'vscode代码背景', value: '2'},
  ]
  function setRestBg (value: string) {
    console.log(value, 'setRestBg')
    restBg.value = value
    window.ipcRenderer.sendSync('set-store', 'restBg', value)
  }

  // 全局字体设置
  const globalFontOps = [
    { label: 'Basteleur Bold', value: 'Basteleur Bold'},
    { label: 'Chill Pixels Mono', value: 'Chill Pixels Mono'},
    { label: '鼎猎珠海体', value: '鼎猎珠海体'},
    { label: 'Norican', value: 'Norican'},
    { label: '系统字体', value: ''},
  ]
  function setGlobalFont (value: string) {
    globalFont.value = value
    window.ipcRenderer.sendSync('set-store', 'globalFont', value)
    document.documentElement.style.setProperty('--jianli-global-font', value);
  }

  return {
    globalFont,
    setGlobalFont,
    globalFontOps,
    restBg,
    restBgOps,
    setRestBg,
    isStartup,
    forceWorkTimes,
    todayForceWorkTimes,
    setForceWorkTimes,
    setTodayForceWorkTimes,
    appInnerColor,
    appBgColor,
    setAppInnerColor,
    setAppBgColor,
    setIsStartup,
  }
}
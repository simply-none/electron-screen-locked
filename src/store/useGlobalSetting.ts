import { onMounted, ref } from "vue";
import type { Ref } from "vue";
import { defineStore } from "pinia";
import { getStore, sendSync, setStore } from "../utils/common";
import moment from "moment";

type defaultField = {
  field: string,
  default: any,
  map: Ref<any>,
}

interface Status {
  label?: string;
  value?: string;
}

type modeOps =  {
  [key: string]: any
}

export default defineStore("global-setting", () => {
  // 当前的状态
  const curStatus = ref<Status>({})
  function updateCurStatus(status: Status) {
    curStatus.value = status;
    setStore("curStatus", status)
  }

  // 强制解锁屏幕限制（即可以玩电脑）
  const forceWorkTimes = ref()
  const todayForceWorkTimes = ref()

  function setForceWorkTimes(value: number) {
    forceWorkTimes.value = value;
    setStore("forceWorkTimes", value);
  }

  function setTodayForceWorkTimes(value: number) {
    const t = {
      today: moment().format('YYYY/MM/DD'),
      times: value,
    }
    todayForceWorkTimes.value = t;
    setStore("todayForceWorkTimes", t);
  }

  // 是否开机启动
  const isStartup = ref()

  function setIsStartup(value: boolean) {
    isStartup.value = value;
    setStore("isStartup", value);
    sendSync("set-startup", value)
  }

  // 系统样式布局设置
  // 应用内颜色
  const appInnerColor = ref()
  // 应用背景颜色
  const appBgColor = ref()
  // 应用全局字体
  const globalFont = ref()
  const globalFontOps = ref<Status[]>([])

  function setAppInnerColor(value: string) {
    appInnerColor.value = value;
    setStore("appInnerColor", value);
  }

  function setAppBgColor(value: string) {
    appBgColor.value = value;
    setStore("appBgColor", value);
  }

  function setGlobalFont(value: string) {
    globalFont.value = value;
    setStore("globalFont", value);
    document.documentElement.style.setProperty('--jianli-global-font', value)
  }

  function setGlobalFontOps(value: Status[]) {
    globalFontOps.value = value;
    setStore("globalFontOps", value);
  }

  // 应用强制锁定（即休息时）设置存储思路：
  // 1. 包含多套方案
  // 2. 每套方案包含一种或多种属性
  const forceLockMode = ref()
  const homeModeOps = ref<modeOps[]>([])

  function setForceLockMode(value: string) {
    forceLockMode.value = value;
    setStore("forceLockMode", value);
  }

  function setHomeModeOps(value: modeOps[]) {
    homeModeOps.value = value;
    setStore("homeModeOps", value);
  }

  // pinia状态初始化
  function init() {
    // 布尔值变量
    const boolVars = [
      { field: 'isStartup', default: false, map: isStartup },
    ]
    // 数字值变量
    const numberVars = [
      { field: 'forceWorkTimes', default: 3, map: forceWorkTimes },
      { field: 'forceLockMode', default: 1, map: forceLockMode },
    ]
    // 字符串值变量
    const stringVars: defaultField[] = []
    // 颜色值变量
    const colorVars = [
      { field: 'appInnerColor', default: '#ffffff', map: appInnerColor },
      { field: 'appBgColor', default: '#d4d4d4', map: appBgColor },
    ]
    // 字体值变量
    const fontVars = [
      { field: 'globalFont', default: '', map: globalFont },
    ]
    // 对象值变量
    const objectVars = [
      {
        field: 'curStatus', default: {
          label: '正在工作',
          value: 'work',
          // 匹配当前主页的模式
          mode: '',
        }, map: curStatus
      },
      {
        field: 'todayForceWorkTimes', default: {
          today: moment().format('YYYY/MM/DD'),
          times: 0,
        }, map: todayForceWorkTimes
      },
      {
        field: 'globalFontOps', default: [
          { label: 'Basteleur Bold', value: 'Basteleur Bold' },
          { label: 'Chill Pixels Mono', value: 'Chill Pixels Mono' },
          { label: '鼎猎珠海体', value: '鼎猎珠海体' },
          { label: 'Norican', value: 'Norican' },
          { label: '系统字体', value: '' },
        ], map: globalFontOps
      },
      {
        field: 'homeModeOps', default: [
          {
            label: "透明诗词板",
            value: "0", 
            primaryColor: "#ffffff",
            secondaryColor: "#000000",
            opacity: 0.8,
          },
          {
            label: "模拟Windows更新",
            value: "1",
            primaryColor: "#000000",
            secondaryColor: "#ffffff",
            opacity: 0.8,
          },
          {
            label: "vscode代码背景",
            value: "2",
            primaryColor: "#000000",
            secondaryColor: "#ffffff",
            opacity: 0.8,
          },
        ], map: homeModeOps
      },

    ]

    // 所有的变量集合
    const allVars: defaultField[] = [
      ...boolVars,
      ...numberVars,
      ...stringVars,
      ...colorVars,
      ...fontVars,
      ...objectVars,
    ]

    // 默认值赋值
    allVars.forEach((item) => {
      const { field, default: defaultValue, map } = item;
      assignDefaultValue(field, defaultValue, map);
    })
  }

  // 变量默认值赋值操作：
  // 1. 先从store中获取数据
  // 2. 如果store中没有数据，则从默认值中获取数据
  // 3. 将数据赋值给该变量
  function assignDefaultValue<T>(key: string, defaultValue: T, map: Ref<any>): void {
    const storeValue = getStore(key);
    map.value = storeValue || defaultValue;
    if (storeValue === undefined) {
      setStore(key, defaultValue);
    }
  }

  function $reset() {
    init()
  }

  onMounted(() => {
    init()
  })

  return {
    // 变量
    curStatus,
    forceWorkTimes,
    todayForceWorkTimes,
    isStartup,
    appInnerColor,
    appBgColor,
    globalFont,
    globalFontOps,
    forceLockMode,
    homeModeOps,
    // 方法
    updateCurStatus,
    setForceWorkTimes,
    setTodayForceWorkTimes,
    setIsStartup,
    setAppInnerColor,
    setAppBgColor,
    setGlobalFont,
    setGlobalFontOps,
    setForceLockMode,
    setHomeModeOps,

  };
});
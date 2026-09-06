// 节流函数
export function throttle(fn: Function, delay: number) {
  let timer: null | number | NodeJS.Timeout = null;
  return function (this: any, ...args: any[]) {
    if (timer) {
      return;
    }
    timer = setTimeout(() => {
      fn.apply(this, args);
      timer = null;
    }, delay);
  };
}

// 防抖函数
export function debounce(fn: Function, delay: number) {
  let timer: null | number | NodeJS.Timeout = null;
  return function (this: any, ...args: any[]) {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      fn.apply(this, args);
    }, delay);
  };
}

// 是否是对象，包括数组、对象
export function isObjectOrArray(obj: any) {
  // 优化一下上述代码
  const typeArr = ["[object Object]", "[object Array]"];
  return typeArr.includes(Object.prototype.toString.call(obj));
}

// 是否是对象
export function isObject(obj: any) {
  return Object.prototype.toString.call(obj) === "[object Object]";
}

// 判断两个对象是否含有相同的字段
export function isSameKey(obj1: any, obj2: any) {
  const obj1Keys = Object.keys(obj1);
  const obj2Keys = Object.keys(obj2);
  return obj1Keys.every((key) => obj2Keys.includes(key));
}

// 是否是数组
export function isArray(obj: any) {
  return Object.prototype.toString.call(obj) === "[object Array]";
}

// 比较新旧两个对象，非破坏性合并：以 newObj(store) 为准，oldObj(default) 仅补齐缺失的内置 key。
// 例如后加的 idle 状态若 store 中缺失，则用 default.idle 兜底，避免落成 undefined 或被整体覆盖。
export function getCompositeObj(oldObj: any, newObj: any) {
  const isObjectType = isObject(oldObj);
  // 旧值非对象：直接采用新值（保持原行为）
  if (!isObjectType) {
    return {
      obj: newObj,
      isSame: true,
    };
  }
  // 新值非对象（如历史 null/undefined 残留）：整体回退 default，避免写回 undefined 抹掉旧配置
  if (!isObject(newObj)) {
    return {
      obj: oldObj,
      isSame: false,
    };
  }
  // store 优先：newObj 覆盖 oldObj 同名 key；oldObj 中独有的 key（如后加的内置状态）用 default 补齐
  const merged = {
    ...oldObj,
    ...newObj,
  };
  // 双向 key 集合一致才算完全同构；否则标记需写回，杜绝「缺键即被覆盖 / 多键被丢弃」
  const oldKeys = Object.keys(oldObj);
  const newKeys = Object.keys(newObj);
  const isSame =
    oldKeys.length === newKeys.length &&
    oldKeys.every((k) => k in newObj) &&
    newKeys.every((k) => k in oldObj);
  return {
    obj: merged,
    isSame,
  };
}

// 新旧两个对象数组的字段增加
export function getCompositeObjArr(
  oldArr: any,
  newArr: any,
  key: string = "id"
) {
  let isSame = true;
  const isArrayType = isArray(oldArr);
  // 如果不数组类型
  if (!isArrayType || oldArr.length === 0) {
    return {
      arr: newArr,
      isSame: false,
    };
  }
  // 遍历旧数组，进行每项的字段比较
  const newOldCopy = oldArr.map((item: any) => {
    const newItem = newArr.find((newItem: any) => newItem[key] === item[key]);
    // 如果新数组中没有，则返回旧数组中的项
    if (!newItem) {
      return item;
    }
    // 否则，参照getCompositeObj函数进行字段比较
    const { obj, isSame: isSm } = getCompositeObj(item, newItem);
    isSame = isSm
    return obj;
  });
  return {
    arr: newOldCopy,
    isSame,
  };
}

// 合并两个对象数组，根据key合并
export const mergeShortcuts = (origin: ObjectType[], current: ObjectType[]) => {
  return origin.map(item => {
    const cur = current.find(c => c.key === item.key)
    return cur ? cur : item
  })
}

// 路由名称 → Lucide 图标名称映射
export const iconMap: Record<string, string> = {
  setting: 'Settings',
  newTips: 'BellRing',
  systemInfo: 'Monitor',
  routeSetting: 'Settings',
  homeMode: 'House',
  windowMode: 'Monitor',
  pomodoroRecord: 'Timer',
  appCache: 'FolderOpen',
  backup: 'HardDriveDownload',
  fileRela: 'Plug2',
  resourceManage: 'Files',
  clipboard: 'FileText',
  notebookApp: 'Notebook',
  categorizableNotes: 'LibraryBig',
  themeConversation: 'MessagesSquare',
  registerShortcut: 'Lightbulb',
  safetyProtection: 'Lock',
  sync: 'RefreshCw',
  netRequest: 'MapPin',
  highPerfSql: 'Database',
  flow: 'Share2',
  function: 'Wrench',
  weather: 'CloudSun',
  about: 'Info',
  browser: 'Globe',
  todoList: 'CircleCheckBig',
  ttsTest: 'AudioLines',
  ebookReader: 'BookOpenText',
  screenshot: 'Camera',
  accounting: 'Wallet',
  stock: 'TrendingUp',
  habit: 'AlarmClockCheck',
  countdown: 'Timer',
  downloader: 'Download',
  colorPalette: 'Palette',
  dataAcquisition: 'Radar',
  devToolbox: 'Wrench',
  resume: 'FileUser',
  qrCode: 'QrCode',
  twoFactor: 'KeyRound',
  pdfTools: 'FileBox',
  fileTransfer: 'ArrowLeftRight',
};

export { getLightColor, getDarkColor } from './color';
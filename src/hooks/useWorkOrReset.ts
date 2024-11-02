import { ref, reactive, watch, onMounted, onBeforeUnmount } from 'vue';
import { sysNotify, appNotify } from '../utils/notify'

import useSetting from './useSetting';

export default function useWorkOrRest() {
  const { forceWorkTimes, todayForceWorkTimes, setForceWorkTimes, setTodayForceWorkTimes } = useSetting();

  let startTimer = ref<NodeJS.Timeout | string | number | undefined>(undefined)

  const storeLastWorkTime = window.ipcRenderer.sendSync('get-store', 'closeWorkTime') || Date.now();
  const storeCurrentWorkTimeOrigin = window.ipcRenderer.sendSync('get-store', 'startWorkTime')
  const storeCurrentWorkTime = storeCurrentWorkTimeOrigin || Date.now();
  const storeWorkTimeGap = window.ipcRenderer.sendSync('get-store', 'workTimeGap') || 35;
  const storeRestTimeGap = window.ipcRenderer.sendSync('get-store', 'restTimeGap') || 5;
  const storeWorkTimeGapUnit = window.ipcRenderer.sendSync('get-store', 'workTimeGapUnit') || 60 * 1000;
  const storeRestTimeGapUnit = window.ipcRenderer.sendSync('get-store', 'restTimeGapUnit') || 60 * 1000;

  const status = ref('work');
  console.warn(storeCurrentWorkTimeOrigin, 'storeLastWorkTime')
  if (!storeCurrentWorkTimeOrigin) {
    status.value = ''
  }

  // 初始化数据
  const initData = ({
    closeWorkTime: storeLastWorkTime,
    startWorkTime: storeCurrentWorkTime,
    workTimeGap: storeWorkTimeGap,
    restTimeGap: storeRestTimeGap,
    workTimeGapUnit: storeWorkTimeGapUnit,
    restTimeGapUnit: storeRestTimeGapUnit,
  })
  window.ipcRenderer.sendSync('set-store', 'multi-field', initData);

  const closeWorkTime = ref(window.ipcRenderer.sendSync('get-store', 'closeWorkTime'))
  const startWorkTime = ref(window.ipcRenderer.sendSync('get-store', 'startWorkTime'));
  const workTimeGap = ref(window.ipcRenderer.sendSync('get-store', 'workTimeGap'));
  const restTimeGap = ref(window.ipcRenderer.sendSync('get-store', 'restTimeGap'));
  const workTimeGapUnit = ref(window.ipcRenderer.sendSync('get-store', 'workTimeGapUnit'));
  const restTimeGapUnit = ref(window.ipcRenderer.sendSync('get-store', 'restTimeGapUnit'));

  watch(closeWorkTime, () => {
    console.warn(closeWorkTime.value, 'closeWorkTime')
    window.ipcRenderer.send('set-store', 'closeWorkTime', closeWorkTime.value);
  })

  watch(startWorkTime, () => {
    console.warn(startWorkTime.value, 'startWorkTime')
    window.ipcRenderer.send('set-store', 'startWorkTime', startWorkTime.value);
  })

  watch(workTimeGap, () => {
    console.warn(workTimeGap.value, 'workTimeGap')
    window.ipcRenderer.send('set-store', 'workTimeGap', workTimeGap.value);
  })

  watch(restTimeGap, () => {
    console.warn(restTimeGap.value, 'restTimeGap')
    window.ipcRenderer.send('set-store', 'restTimeGap', restTimeGap.value);
  })

  watch(workTimeGapUnit, () => {
    console.warn(workTimeGapUnit.value, 'workTimeGapUnit')
    window.ipcRenderer.send('set-store', 'workTimeGapUnit', workTimeGapUnit.value);
  })

  watch(restTimeGapUnit, () => {
    console.warn(restTimeGapUnit.value, 'restTimeGapUnit')
    window.ipcRenderer.send('set-store', 'restTimeGapUnit', restTimeGapUnit.value);
  })

  onMounted(() => {
    window.ipcRenderer.on('before-close', (e, data) => {
      console.warn('before-close', e, data)
    });

    window.ipcRenderer.on('close-work', (e, data) => {
      closeWorkTime.value = Date.now()
      console.warn(new Date(closeWorkTime.value), 'closeWorkTime')
      startRestFn()
    });

    window.ipcRenderer.on('close-rest', (e, data) => {
      startForceWorkFn()
    });
  })

  onBeforeUnmount(() => {
    window.ipcRenderer.removeAllListeners('before-close');
    window.ipcRenderer.removeAllListeners('close-work');
    window.ipcRenderer.removeAllListeners('close-rest');
  })

  // 软件初始化
  function initFn() {
    // 上一次工作时间到现在时间的间隔，如果小于
    const currentTime = Date.now()

    if (status.value === '') {
      // 第一次启动，开始工作
      startForceWorkFn(workTimeGap.value, '应用启动中，开始工作！', true)
      return;
    }

    if (currentTime - startWorkTime.value < workTimeGap.value) {
      startForceWorkFn(workTimeGap.value - (currentTime - startWorkTime.value), '人为修改应用设置，继续工作', true)
      return
    }
    if (currentTime - closeWorkTime.value < restTimeGap.value) {
      startRestFn(restTimeGap.value - (currentTime - closeWorkTime.value), '人为修改应用设置，继续休息', true)
      return
    }

    // 第一次启动，开始工作2
    startForceWorkFn(workTimeGap.value, '应用启动中，开始工作。', true)
  }

  // 改动立刻生效
  function changeEffectFn() {
    console.warn('改动立刻生效', status.value, 1)
    if (status.value === 'work') {
      startWorkFn()
    }
    if (status.value === 'rest') {
      // 上一次工作结束时间开始计算
      const diffDate = restTimeGap.value - (Date.now() - closeWorkTime.value)
      startRestFn(diffDate)
    }

    startWorkFn()
  }

  function startWorkFn(gap?: number, msg?: string) {
    const current = Date.now()
    let timeSpace = current - Number(closeWorkTime.value)
    if (timeSpace < Number(restTimeGap.value)) {
      appNotify('提示', '正在休息中');
      return
    }
    startForceWorkFn(gap || workTimeGap.value, msg)
  }

  function startForceWorkFn(gap?: number, msg?: string, notTimeout?: boolean) {
    if (startTimer.value) clearTimeout(startTimer.value);
    status.value = 'work'
    startWorkTime.value = Date.now()
    console.warn(new Date(startWorkTime.value), 'startWorkTime')
    sysNotify('提示', '3秒后' + (msg || '开始工作'), '')
    console.warn((gap || workTimeGap.value) * workTimeGapUnit.value, 'workTimeGapUnit 工作时间间隔')
    if (!notTimeout) {
      startTimer.value = setTimeout(() => {
        window.ipcRenderer.send('start-work', (gap || workTimeGap.value) * workTimeGapUnit.value);
      }, 3000);
    } else {
      window.ipcRenderer.send('start-work', (gap || workTimeGap.value) * workTimeGapUnit.value);
    }
  }

  function forceWorkWithTimes () {
    if (todayForceWorkTimes.value > forceWorkTimes.value) {
      appNotify('提示', '太累了，您不能再继续强制工作');
      sysNotify('提示', '太累了，您不能再继续强制工作', '');
      return
    }
    setTodayForceWorkTimes(todayForceWorkTimes.value + 1)
    startForceWorkFn()
  }

  function startRestFn(gap?: number, msg?: string, notTimeout?: boolean) {
    if (startTimer.value) clearTimeout(startTimer.value);
    sysNotify('提示', '3秒后' + (msg || '开始休息'), '')
    status.value = 'rest'
    console.warn((gap || restTimeGap.value) * restTimeGapUnit.value, 'restTimeGapUnit 休息时间间隔')
    if (!notTimeout) {
      startTimer.value = setTimeout(() => {
        window.ipcRenderer.send('start-rest', (gap || restTimeGap.value) * restTimeGapUnit.value);
      }, 3000);
    } else {
      window.ipcRenderer.send('start-rest', (gap || restTimeGap.value) * restTimeGapUnit.value);
    }
  }

  return {
    startApp: initFn,
    startWorkFn,
    startForceWorkFn,
    forceWorkWithTimes,
    startRestFn,
    changeEffectFn,
    workTimeGap,
    restTimeGap,
    workTimeGapUnit,
    restTimeGapUnit,
    closeWorkTime,
    startWorkTime,

  }
}


import { ref, reactive, computed, watch, onMounted, onBeforeUnmount } from 'vue';
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
      startRestFn({ isUpdateCloseTime: true })
    });

    window.ipcRenderer.on('close-rest', (e, data) => {
      startForceWorkFn({ isUpdateStartTime: true })
    });
  })

  onBeforeUnmount(() => {
    window.ipcRenderer.removeAllListeners('before-close');
    window.ipcRenderer.removeAllListeners('close-work');
    window.ipcRenderer.removeAllListeners('close-rest');
  })

  const nextWorkTime = computed(() => {
    let next = 0
    if (startWorkTime.value >= closeWorkTime.value) {
      // 当前正在工作
      next = Number(startWorkTime.value) + Number(workTimeGap.value) * Number(workTimeGapUnit.value) + Number(restTimeGap.value) * Number(restTimeGapUnit.value)
    } else {
      // 当前正在休息
      next = Number(closeWorkTime.value) + Number(restTimeGap.value) * Number(restTimeGapUnit.value)
    }
    return new Date(Number(next)).toLocaleString('zh', {
      hour12: false,
    })
  })

  const nextRestTime = computed(() => {
    let next = 0
    if (startWorkTime.value >= closeWorkTime.value) {
      // 当前正在工作
      next = Number(startWorkTime.value) + Number(workTimeGap.value) * Number(workTimeGapUnit.value)
    } else {
      // 当前正在休息
      next = Number(closeWorkTime.value) + Number(restTimeGap.value) * Number(restTimeGapUnit.value) + Number(workTimeGap.value) * Number(workTimeGapUnit.value)
    }
    return new Date(Number(next)).toLocaleString('zh', {
      hour12: false,
    })
  })

  const curStatus = computed(() => {
    if (startWorkTime.value >= closeWorkTime.value) {
      return {
        label: '正在工作',
        value: 'work',
      };
    } else {
      return {
        label: '正在休息',
        value: 'rest',
      };
    }
  })

  // 软件初始化
  function initFn() {
    // 上一次工作时间到现在时间的间隔，如果小于
    const currentTime = Date.now()
    console.warn(status.value, 'status')
    console.warn(currentTime - startWorkTime.value, workTimeGap.value * workTimeGapUnit.value, 'work')
    console.warn(currentTime - closeWorkTime.value, restTimeGap.value * restTimeGapUnit.value, 'rest')


    if (status.value === '') {
      // 第一次启动，开始工作
      startForceWorkFn({ gap: workTimeGap.value * workTimeGapUnit.value, msg: '应用启动中，30s后您将开始进入工作状态。', notTimeout: true, msgShowTime: 30000, isInitApp: true })
      console.warn('应用启动中，开始工作1')
      return;
    }

    if (currentTime - startWorkTime.value < workTimeGap.value * workTimeGapUnit.value) {
      startForceWorkFn({ gap: workTimeGap.value * workTimeGapUnit.value - (currentTime - startWorkTime.value), msg: '应用启动中，由于人为破坏应用运行机制，30s后您将开始进入工作状态。', notTimeout: false, msgShowTime: 30000 })
      console.warn('人为修改应用设置，继续工作1')
      return
    }
    if (currentTime - closeWorkTime.value < restTimeGap.value * restTimeGapUnit.value) {
      startRestFn({ gap: restTimeGap.value * restTimeGapUnit.value - (currentTime - closeWorkTime.value), msg: '应用启动中，由于人为破坏应用运行机制，您应当继续开始进入休息状态', notTimeout: true })
      console.warn('人为修改应用设置，继续休息1')
      return
    }

    // 第一次启动，开始工作2
    startForceWorkFn({ gap: workTimeGap.value * workTimeGapUnit.value, msg: '应用启动中，上一个应用运行机制已结束，30s后您将开始进入工作状态。', notTimeout: false, msgShowTime: 30000, isInitApp: true })
    console.warn('应用启动中，开始工作2')
  }

  // 改动立刻生效
  function changeEffectFn() {
    console.warn('改动立刻生效', status.value, 1)
    if (status.value === 'work') {
      startWorkFn()
    }
    if (status.value === 'rest') {
      // 上一次工作结束时间开始计算
      const diffDate = restTimeGap.value * restTimeGapUnit.value - (Date.now() - closeWorkTime.value)
      startRestFn({ gap: diffDate })
    }

    startWorkFn()
  }

  function startWorkFn(gap?: number, msg?: string) {
    if (curStatus.value.value === 'rest') {
      appNotify('提示', '正在休息中');
      return
    }
    startForceWorkFn({ gap: gap || (workTimeGap.value * workTimeGapUnit.value), msg })
  }

  function startForceWorkFn({ gap, msg, notTimeout, msgShowTime, isInitApp, isUpdateStartTime }: { gap?: number, msg?: string, notTimeout?: boolean, msgShowTime?: number, isInitApp?: boolean, isUpdateStartTime?: boolean } = {}) {
    if (startTimer.value) clearTimeout(startTimer.value);
    console.warn(new Date(startWorkTime.value), 'startWorkTime')
    sysNotify('提示', msg || `${(msgShowTime || 3000) / 1000}秒后开始进入工作状态`, '')
    appNotify('提示', msg || `${(msgShowTime || 3000) / 1000}秒后开始进入工作状态`, msgShowTime);
    console.warn(gap || (workTimeGap.value) * workTimeGapUnit.value, 'workTimeGapUnit 工作时间间隔')
    if (!notTimeout) {
      startTimer.value = setTimeout(() => {
        // 有这个标志，代表首次启动应用
        if (isInitApp || isUpdateStartTime) {
          startWorkTime.value = Date.now()
        }
        status.value = 'work'
        window.ipcRenderer.send('start-work', gap || (workTimeGap.value) * workTimeGapUnit.value);
      }, msgShowTime || 3000);
    } else {
      // 有这个标志，代表首次启动应用
      if (isInitApp || isUpdateStartTime) {
        startWorkTime.value = Date.now()
      }
      status.value = 'work'
      window.ipcRenderer.send('start-work', gap || (workTimeGap.value) * workTimeGapUnit.value);
    }
  }

  function forceWorkWithTimes() {
    if (todayForceWorkTimes.value > forceWorkTimes.value) {
      appNotify('提示', '太累了，您不能再继续强制工作');
      sysNotify('提示', '太累了，您不能再继续强制工作', '');
      return
    }
    setTodayForceWorkTimes(todayForceWorkTimes.value + 1)
    startForceWorkFn()
  }

  function startRestFn({ gap, msg, notTimeout, isUpdateCloseTime }: { gap?: number, msg?: string, notTimeout?: boolean, isUpdateCloseTime?: boolean } = {}) {
    if (startTimer.value) clearTimeout(startTimer.value);
    sysNotify('提示', msg || '3秒后开始进入休息状态', '')
    appNotify('提示', msg || '3秒后开始进入休息状态');
    console.warn(gap || (restTimeGap.value) * restTimeGapUnit.value, 'restTimeGapUnit 休息时间间隔')
    if (!notTimeout) {
      startTimer.value = setTimeout(() => {
        // 有这个标志，代表首次启动应用
        if (isUpdateCloseTime) {
          closeWorkTime.value = Date.now()
        }
        status.value = 'rest'
        window.ipcRenderer.send('start-rest', gap || (restTimeGap.value) * restTimeGapUnit.value);
      }, 3000);
    } else {
      // 有这个标志，代表首次启动应用
      if (isUpdateCloseTime) {
        closeWorkTime.value = Date.now()
      }
      status.value = 'rest'
      window.ipcRenderer.send('start-rest', gap || (restTimeGap.value) * restTimeGapUnit.value);
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
    nextWorkTime,
    nextRestTime,
    curStatus,
  }
}


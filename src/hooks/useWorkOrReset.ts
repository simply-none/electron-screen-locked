import { ref, reactive, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import { storeToRefs, defineStore } from 'pinia';
import { sysNotify, appNotify } from '../utils/notify'

import useGlobalSetting from '../store/useGlobalSetting';
import useWorkOrRestStore from '../store/useWorkOrReset'
import moment from 'moment';

export function useWorkOrRest() {
  const { setForceWorkTimes, setTodayForceWorkTimes } = useGlobalSetting();
  const { forceWorkTimes, todayForceWorkTimes, curStatus } = storeToRefs(useGlobalSetting())
  const { workTimeGap, restTimeGap, workTimeGapUnit, restTimeGapUnit, closeWorkTime, startWorkTime } = storeToRefs(useWorkOrRestStore())

  let startTimer = ref<NodeJS.Timeout | string | number | undefined>(undefined)

  let firstWaitTime = 30 * 1000
  if (process.env.NODE_ENV === 'development') {
    firstWaitTime = 1 * 1000;
  }

  const waitTime = 3 * 1000

  watch(closeWorkTime, () => {
    console.warn(closeWorkTime.value, 'closeWorkTime')
    window.ipcRenderer.send('set-store', 'closeWorkTime', closeWorkTime.value);
    updStatus()
  })

  watch(startWorkTime, () => {
    console.warn(startWorkTime.value, 'startWorkTime')
    window.ipcRenderer.send('set-store', 'startWorkTime', startWorkTime.value);
    updStatus()
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

  function updStatus(updByStatus = '') {
    // 通过status更新
    if (updByStatus) {
      return curStatus.value = updByStatus == 'work' ? {
        label: '正在工作',
        value: 'work',
      } : updByStatus == 'rest' ? {
        label: '正在休息',
        value: 'rest',
      } : {}
    }
    if (startWorkTime.value >= closeWorkTime.value) {
      curStatus.value = {
        label: '正在工作',
        value: 'work',
      }
    } else {
      curStatus.value = {
        label: '正在休息',
        value: 'rest',
      }
    }
  }

  // 软件初始化
  function initFn() {
    // 上一次工作时间到现在时间的间隔，如果小于
    const currentTime = Date.now()
    console.warn(curStatus.value, 'curStatus')
    console.warn(currentTime - startWorkTime.value, workTimeGap.value * workTimeGapUnit.value, 'work')
    console.warn(currentTime - closeWorkTime.value, restTimeGap.value * restTimeGapUnit.value, 'rest')


    if (!curStatus.value || curStatus.value.value === '') {
      // 第一次启动，开始工作
      startForceWorkFn({ gap: workTimeGap.value * workTimeGapUnit.value, msg: '应用启动中，30s后您将开始进入工作状态。', notTimeout: true, msgShowTime: firstWaitTime, isInitApp: true })
      console.warn('应用启动中，开始工作1')
      return;
    }

    if (currentTime - startWorkTime.value < workTimeGap.value * workTimeGapUnit.value) {
      startForceWorkFn({ gap: workTimeGap.value * workTimeGapUnit.value - (currentTime - startWorkTime.value), msg: '应用启动中，由于人为破坏应用运行机制，30s后您将开始进入工作状态。', notTimeout: false, msgShowTime: firstWaitTime })
      console.warn('人为修改应用设置，继续工作1')
      return
    }
    if (currentTime - closeWorkTime.value < restTimeGap.value * restTimeGapUnit.value) {
      startRestFn({ gap: restTimeGap.value * restTimeGapUnit.value - (currentTime - closeWorkTime.value), msg: '应用启动中，由于人为破坏应用运行机制，您应当继续开始进入休息状态', notTimeout: true })
      console.warn('人为修改应用设置，继续休息1')
      return
    }

    // 第一次启动，开始工作2
    console.log('应用启动中，开始工作2')
    startForceWorkFn({ gap: workTimeGap.value * workTimeGapUnit.value, msg: '应用启动中，上一个应用运行机制已结束，30s后您将开始进入工作状态。', notTimeout: false, msgShowTime: firstWaitTime, isInitApp: true })
    console.warn('应用启动中，开始工作2')
  }

  // 改动立刻生效
  function changeEffectFn() {
    console.warn('改动立刻生效', curStatus.value, 1)
    if (curStatus.value && curStatus.value.value === 'work') {
      startWorkFn()
    }
    if (curStatus.value && curStatus.value.value === 'rest') {
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
    sysNotify('提示', msg || `${(msgShowTime || waitTime) / 1000}秒后开始进入工作状态`, '')
    appNotify('提示', msg || `${(msgShowTime || waitTime) / 1000}秒后开始进入工作状态`, msgShowTime);
    console.warn(gap || (workTimeGap.value) * workTimeGapUnit.value, 'workTimeGapUnit 工作时间间隔')
    if (!notTimeout) {
      startTimer.value = setTimeout(() => {
        // 有这个标志，代表首次启动应用
        if (isInitApp || isUpdateStartTime) {
          startWorkTime.value = Date.now()
        }
        updStatus('work')
        window.ipcRenderer.send('start-work', gap || (workTimeGap.value) * workTimeGapUnit.value);
      }, msgShowTime || waitTime);
    } else {
      // 有这个标志，代表首次启动应用
      if (isInitApp || isUpdateStartTime) {
        startWorkTime.value = Date.now()
      }
      updStatus('work')
      window.ipcRenderer.send('start-work', gap || (workTimeGap.value) * workTimeGapUnit.value);
    }
  }

  function forceWorkWithTimes() {
    if (todayForceWorkTimes.value?.times > forceWorkTimes.value) {
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
    // 判断当前时间是否在11:50-13:30之间
    let isNoonRestTime = false
    let noonRestTimeGap = 0
    if (moment().isBetween(moment('11:50', 'HH:mm'), moment('13:30', 'HH:mm'))) {
      console.warn('当前处于11:50-13:30之间', moment().format('HH:mm'))
      isNoonRestTime = true
      // 计算当前时间距离13:30的时间差(毫秒级)
      noonRestTimeGap = moment().diff(moment('13:30', 'HH:mm'), 'seconds', true) * 1000
      console.warn('当前时间距离13:30的时间差', noonRestTimeGap, '毫秒')
    }

    if (!notTimeout) {
      startTimer.value = setTimeout(() => {
        // 有这个标志，代表首次启动应用
        if (isUpdateCloseTime) {
          closeWorkTime.value = Date.now()
        }
        updStatus('rest')
        window.ipcRenderer.send('start-rest', isNoonRestTime ? noonRestTimeGap : (gap || (restTimeGap.value) * restTimeGapUnit.value));
      }, waitTime);
    } else {
      // 有这个标志，代表首次启动应用
      if (isUpdateCloseTime) {
        closeWorkTime.value = Date.now()
      }
      updStatus('rest')
      window.ipcRenderer.send('start-rest', isNoonRestTime ? noonRestTimeGap : (gap || (restTimeGap.value) * restTimeGapUnit.value));
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

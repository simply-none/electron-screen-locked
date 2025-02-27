import { ref, reactive, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import { storeToRefs, defineStore } from 'pinia';
import { sysNotify, appNotify } from '../utils/notify'

import useGlobalSetting from '../store/useGlobalSetting';
import useWorkOrRestStore from '../store/useWorkOrReset'
import moment from 'moment';

export function useWorkOrRest() {
  const { setForceWorkTimes, setTodayForceWorkTimes, setCurStatus } = useGlobalSetting();
  const { forceWorkTimesC, todayForceWorkTimesC, curStatusC } = storeToRefs(useGlobalSetting())
  const { setStartWorkTime, setCloseWorkTime } = useWorkOrRestStore();
  const { workTimeGapC, restTimeGapC, workTimeGapUnitC, restTimeGapUnitC, closeWorkTimeC, startWorkTimeC } = storeToRefs(useWorkOrRestStore())

  let startTimer = ref<NodeJS.Timeout | string | number | undefined>(undefined)

  let firstWaitTime = 30 * 1000
  if (process.env.NODE_ENV === 'development') {
    firstWaitTime = 1 * 1000;
  }

  const waitTime = 3 * 1000

  onMounted(() => {
    window.ipcRenderer.on('before-close', (e, data) => {
      console.warn('before-close', e, data)
    });

    window.ipcRenderer.on('close-work', (e, data) => {
      startRestFn({ isUpdateCloseTime: true })
    });

    window.ipcRenderer.on('close-rest', (e, data) => {
      alert('结束休息')
      startForceWorkFn({ isUpdateStartTime: true })
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
    console.warn(curStatusC.value, 'curStatusC')
    console.warn(currentTime - startWorkTimeC.value, workTimeGapC.value * workTimeGapUnitC.value, 'work')
    console.warn(currentTime - closeWorkTimeC.value, restTimeGapC.value * restTimeGapUnitC.value, 'rest')


    if (!curStatusC.value || curStatusC.value.value === undefined) {
      // 第一次启动，开始工作
      startForceWorkFn({ gap: workTimeGapC.value * workTimeGapUnitC.value, msg: '应用启动中，30s后您将开始进入工作状态。', notTimeout: true, msgShowTime: firstWaitTime, isInitApp: true })
      console.warn('应用启动中，开始工作1')
      return;
    }

    if (currentTime - startWorkTimeC.value < workTimeGapC.value * workTimeGapUnitC.value) {
      startForceWorkFn({ gap: workTimeGapC.value * workTimeGapUnitC.value - (currentTime - startWorkTimeC.value), msg: '应用启动中，由于人为破坏应用运行机制，30s后您将开始进入工作状态。', notTimeout: false, msgShowTime: firstWaitTime })
      console.warn('人为修改应用设置，继续工作1')
      return
    }
    if (currentTime - closeWorkTimeC.value < restTimeGapC.value * restTimeGapUnitC.value) {
      startRestFn({ gap: restTimeGapC.value * restTimeGapUnitC.value - (currentTime - closeWorkTimeC.value), msg: '应用启动中，由于人为破坏应用运行机制，您应当继续开始进入休息状态', notTimeout: true })
      console.warn('人为修改应用设置，继续休息1')
      return
    }

    // 第一次启动，开始工作2
    console.log('应用启动中，开始工作2')
    startForceWorkFn({ gap: workTimeGapC.value * workTimeGapUnitC.value, msg: '应用启动中，上一个应用运行机制已结束，30s后您将开始进入工作状态。', notTimeout: false, msgShowTime: firstWaitTime, isInitApp: true })
    console.warn('应用启动中，开始工作2')
  }

  // 改动立刻生效
  function changeEffectFn() {
    console.warn('改动立刻生效', curStatusC.value, 1)
    if (curStatusC.value && curStatusC.value.value === 'work') {
      startWorkFn()
    }
    if (curStatusC.value && curStatusC.value.value === 'rest') {
      // 上一次工作结束时间开始计算
      const diffDate = restTimeGapC.value * restTimeGapUnitC.value - (Date.now() - closeWorkTimeC.value)
      startRestFn({ gap: diffDate })
    }

    startWorkFn()
  }

  function startWorkFn(gap?: number, msg?: string) {
    if (curStatusC.value.value === 'rest') {
      appNotify('提示', '正在休息中');
      return
    }
    startForceWorkFn({ gap: gap || (workTimeGapC.value * workTimeGapUnitC.value), msg })
  }

  function startForceWorkFn({ gap, msg, notTimeout, msgShowTime, isInitApp, isUpdateStartTime }: { gap?: number, msg?: string, notTimeout?: boolean, msgShowTime?: number, isInitApp?: boolean, isUpdateStartTime?: boolean } = {}) {
    if (startTimer.value) clearTimeout(startTimer.value);
    console.warn(new Date(startWorkTimeC.value), 'startWorkTimeC')
    sysNotify('提示', msg || `${(msgShowTime || waitTime) / 1000}秒后开始进入工作状态`, '')
    appNotify('提示', msg || `${(msgShowTime || waitTime) / 1000}秒后开始进入工作状态`, msgShowTime);
    console.warn(gap || (workTimeGapC.value) * workTimeGapUnitC.value, 'workTimeGapUnitC 工作时间间隔')
    if (!notTimeout) {
      startTimer.value = setTimeout(() => {
        // 有这个标志，代表首次启动应用
        if (isInitApp || isUpdateStartTime) {
          setStartWorkTime(Date.now())
          setCurStatus()
        }
        setCurStatus({
          label: '正在工作',
          value: 'work',
        })
        window.ipcRenderer.send('start-work', gap || (workTimeGapC.value) * workTimeGapUnitC.value);
      }, msgShowTime || waitTime);
    } else {
      // 有这个标志，代表首次启动应用
      if (isInitApp || isUpdateStartTime) {
        setStartWorkTime(Date.now())
        setCurStatus()
      }
      setCurStatus({
        label: '正在工作',
        value: 'work',
      })
      window.ipcRenderer.send('start-work', gap || (workTimeGapC.value) * workTimeGapUnitC.value);
    }
  }

  function forceWorkWithTimes() {
    if (todayForceWorkTimesC.value?.times > forceWorkTimesC.value) {
      appNotify('提示', '太累了，您不能再继续强制工作');
      sysNotify('提示', '太累了，您不能再继续强制工作', '');
      return
    }
    setTodayForceWorkTimes(todayForceWorkTimesC.value + 1)
    startForceWorkFn()
  }

  function startRestFn({ gap, msg, notTimeout, isUpdateCloseTime }: { gap?: number, msg?: string, notTimeout?: boolean, isUpdateCloseTime?: boolean } = {}) {
    if (startTimer.value) clearTimeout(startTimer.value);
    sysNotify('提示', msg || '3秒后开始进入休息状态', '')
    appNotify('提示', msg || '3秒后开始进入休息状态');
    console.warn(gap || (restTimeGapC.value) * restTimeGapUnitC.value, 'restTimeGapUnitC 休息时间间隔')
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
          setCloseWorkTime(Date.now())
          setCurStatus()
        }
        setCurStatus({
          label: '正在休息',
          value: 'rest',
        })
        window.ipcRenderer.send('start-rest', isNoonRestTime ? noonRestTimeGap : (gap || (restTimeGapC.value) * restTimeGapUnitC.value));
      }, waitTime);
    } else {
      // 有这个标志，代表首次启动应用
      if (isUpdateCloseTime) {
        setCloseWorkTime(Date.now())
        setCurStatus()
      }
      setCurStatus({
        label: '正在休息',
        value: 'rest',
      })
      window.ipcRenderer.send('start-rest', isNoonRestTime ? noonRestTimeGap : (gap || (restTimeGapC.value) * restTimeGapUnitC.value));
    }
  }

  return {
    startApp: initFn,
    startWorkFn,
    startForceWorkFn,
    forceWorkWithTimes,
    startRestFn,
    changeEffectFn,
    workTimeGapC,
    restTimeGapC,
    workTimeGapUnitC,
    restTimeGapUnitC,
    closeWorkTimeC,
    startWorkTimeC,
  }
}

import { ref, reactive, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import type { Ref } from 'vue';
import { storeToRefs, defineStore } from 'pinia';
import { getStore, sendSync, setStore } from "../utils/common";

import useGlobalSetting from '../store/useGlobalSetting';

type defaultField = {
  field: string,
  default: any,
  map: Ref<any>,
}

const useWorkOrRestStore = defineStore('workOrRest', () => {
  const closeWorkTime = ref()
  const startWorkTime = ref();
  const workTimeGap = ref();
  const restTimeGap = ref();
  const workTimeGapUnit = ref();
  const restTimeGapUnit = ref();

  // pinia状态初始化
  function init() {
    // 布尔值变量
    const boolVars: defaultField[] = []
    // 数字值变量
    const numberVars = [
      { field: 'closeWorkTime', default: Date.now(), map: closeWorkTime },
      { field: 'startWorkTime', default: Date.now(), map: startWorkTime },
      { field: 'workTimeGap', default: 35, map: workTimeGap },
      { field: 'restTimeGap', default: 5, map: restTimeGap },
      { field: 'workTimeGapUnit', default: 60 * 1000, map: workTimeGapUnit },
      { field:'restTimeGapUnit', default: 60 * 1000, map: restTimeGapUnit },
    ]
    // 字符串值变量
    const stringVars: defaultField[] = []
    // 颜色值变量
    const colorVars: defaultField[] = []
    // 字体值变量
    const fontVars: defaultField[] = []
    // 对象值变量
    const objectVars: defaultField[] = []

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
    workTimeGap,
    restTimeGap,
    workTimeGapUnit,
    restTimeGapUnit,
    closeWorkTime,
    startWorkTime,
  }
})

export default useWorkOrRestStore

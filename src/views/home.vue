<template>
  <div>
    <div class="item">
      <div class="label">
        下次工作时间
      </div>
      <div class="value">
        {{ nextWorkTime }}
      </div>
    </div>
    <div class="setting">

      <el-image :src="SettingSvg" @click="toSetting"></el-image>
    </div>
  </div>
</template>

<script setup>
import SettingSvg from '../assets/set.svg'
import { ref, reactive, watch, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import HeaderNav from '../components/header.vue';
import useWorkOrReset from '../hooks/useWorkOrReset';
import useClearStore from '../hooks/useClearStore';
import useSetting from '../hooks/useSetting';
import { timeUnit } from '../utils/time';

onMounted(() => {

  console.log('进入首页');
  startApp();
});

const router = useRouter();
const { startApp } = useWorkOrReset();

const { clearStore } = useClearStore();
const {
  workTimeGap,
  restTimeGap,
  workTimeGapUnit,
  restTimeGapUnit,
  startWorkTime,
  closeWorkTime,
  startWorkFn,
  startRestFn,
  changeEffectFn,
  forceWorkWithTimes,
} = useWorkOrReset();
const { forceWorkTimes, setForceWorkTimes, todayForceWorkTimes, appBgColor, appInnerColor, setAppBgColor, setAppInnerColor } = useSetting();

function toSetting() {
  router.push('/setting');
}

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



</script>

<style lang="scss" scoped>
.item {
  display: flex;
  align-items: center;
  flex-direction: column;
  width: 100%;
  height: 100%;
  justify-content: center;
  .label {
    font-size: 24px;
    color: gray;
  }
  .value {
    font-size: 28px;
    font-weight: 900;
  }
}

.el-image {
  position: fixed;
  width: 24px;
  height: 24px;
  padding: 12px;
  top: 0;
  right: 0;
  cursor: pointer;

  &:hover {
    box-shadow: 0px 0px 15px #818181;
    border-radius: 50%;
  }
}
</style>
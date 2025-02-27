<template>
  <div class="home-rest">
    <div class="home-rest-body">
      <cus-loading class="home-rest-loading" />
      <div class="home-rest-text">正在进行更新{{ percentage }}%</div>
      <div class="home-rest-text">请不要关闭电脑，完成此操作需要一定的时间。</div>
    </div>
    <div class="home-rest-bottom">
      你的电脑将重启若干次。
    </div>
  </div>

</template>

<script setup>
import { ref, reactive, watch, computed, onMounted, onUnmounted } from 'vue';
import { storeToRefs } from 'pinia';

import CusLoading from '@/components/loading.vue';
import useGlobalSetting from '@/store/useGlobalSetting';
import useWorkOrRestStore from '@/store/useWorkOrReset';

const showContent = ref({ error: true });
const timer = ref(null);
const toNextWorkTime = ref('00:00:00');
const toNextRestTime = ref('00:00:00');
const percentage = ref(1);

const {
  nextRestTime,
  nextWorkTime,
} = storeToRefs(useWorkOrRestStore());
const { homeModeOpsC, curStatusC } = storeToRefs(useGlobalSetting());

onMounted(() => {
  toNext();
  timer.value = setInterval(() => {
    if (curStatusC.value.value === 'work') {
      console.log(countDown(nextRestTime.value), 'countDown', nextRestTime.value)
      toNextRestTime.value = countDown(nextRestTime.value);
    } else if (curStatusC.value.value === 'rest') {
      console.log(countDown(nextWorkTime.value), 'countDown', nextWorkTime.value)
      toNextWorkTime.value = countDown(nextWorkTime.value);
      let isAdd = 1
      if (percentage.value < 60) {
        isAdd = Math.random() > 0.6 ? percentage.value + 1 : percentage.value;
      } else {
        isAdd = Math.random() > percentage.value * 0.01 ? percentage.value + 1 : percentage.value;
      }
      percentage.value = isAdd > 97 ? 97 : isAdd;
    }
  }, 1000);
});

onUnmounted(() => {
  clearInterval(timer.value);
});

function toNext() {
  const poetData = window.ipcRenderer.sendSync('poet-data')
  showContent.value = poetData || { error: true }
  console.log('poetData', poetData);
}

function toggleComponent(status) {
  switch (status) {
    case 'work':
      return 'work'
    case 'rest':
      return 'rest'
  }
}

watch(() => curStatusC.value.value, () => {
  console.log(curStatusC.value, 'curStatusC')
  percentage.value = 1;
  // 首页展示组件模式变更
  toggleComponent(curStatusC.value.value)
}, { immediate: true, deep: true })

// 写一个倒计时函数，用来计算当前时间距离下次工作时间的时间差，格式是00:00:00
function countDown(time) {
  const now = (new Date()).getTime();
  const diff = (new Date(time)).getTime() - now;
  if (diff < 0) return '00:00:00';
  let h = Math.floor(diff / 1000 / 60 / 60);
  let m = Math.floor((diff / 1000 / 60) % 60);
  let s = Math.floor((diff / 1000) % 60);
  return `${h < 10 ? '0' + h : h}:${m < 10 ? '0' + m : m}:${s < 10 ? '0' + s : s}`;
}
</script>

<style lang="scss" scoped>
.home-rest {
  height: 100%;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  align-items: center;
  background: #0077d7;
  color: #ddd;
  cursor: none;

  &-body {
    flex: 1;
    display: flex;
    flex-direction: column;
    justify-content: flex-start;
    align-items: center;
    gap: 6px;
    padding-top: 30vh;
    font-size: 28px;
    color: #ddd;
  }

  &-bottom {
    font-size: 24px;
    padding-bottom: 12px;
  }

  &-loading {
    padding-bottom: 24px;
  }
}
</style>
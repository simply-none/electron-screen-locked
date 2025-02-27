<template>
  <div class="home">
    <div class="content-show" v-if="showContent && !showContent.error">
      <div class="content-inner" v-if="showContent.author">
        <div class="rhythmic">{{ showContent.rhythmic }}</div>
        <div class="author">{{ showContent.author }}</div>
        <div class="content">
          <div v-for="paragraphs in showContent.paragraphs" :key="paragraphs">
            {{ paragraphs }}
          </div>
        </div>
      </div>
      <div class="content-inner" v-if="showContent.name">
        <div class="author">{{ showContent.name }}</div>
        <div class="content">
          <div>
            {{ showContent.description }}
          </div>
        </div>
      </div>
      <div class="content-toggle">
        <el-button type="primary" @click="toNext">下一个</el-button>
      </div>
    </div>
    <div class="cur-status">
      <div class="item">
        <div class="label">
          当前状态
        </div>
        <div class="value">
          {{ curStatusC.label }}
        </div>
      </div>
      <div class="item" v-if="curStatusC.value === 'rest'">
        <div class="label">
          下次工作时间
        </div>
        <div class="value">
          {{ nextWorkTime }}
        </div>
        <div class="value">
          倒计时：{{ toNextWorkTime }}
        </div>
      </div>
      <div class="item" v-else-if="curStatusC.value === 'work'">
        <div class="label">
          下次休息时间
        </div>
        <div class="value">
          {{ nextRestTime }}
        </div>
        <div class="value">
          倒计时：{{ toNextRestTime }}
        </div>
      </div>
    </div>
  </div>

</template>

<script setup>
import { ref, reactive, watch, computed, onMounted, onUnmounted } from 'vue';
import { storeToRefs } from 'pinia';

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
.home {
  height: 100%;
  display: flex;
  flex-direction: column;
  justify-content: center;
  color: #696969;
}

.content {
  display: flex;
  flex-direction: column;
  align-items: center;
  max-height: 160px;
  padding: 12px 24px;

}

.content-show {
  display: flex;
  flex-direction: column;
  align-items: center;
}

.content-toggle {
  text-align: center;
  margin: 20px;

  .el-button {
    backdrop-filter: blur(6px);
    color: #696969;
    background: #d9d9d9;
    border-color: #cfcfcf;
  }
}

.content-inner {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 50%;
  max-width: 600px;
  backdrop-filter: blur(6px);
  overflow: auto;

  /*隐藏垂直滚动条*/
  &::-webkit-scrollbar {
    width: 0;
    height: 0;
  }
}

.cur-status {
  display: flex;
  justify-content: space-around;

  .item {
    display: flex;
    align-items: center;
    flex-direction: column;
    justify-content: center;
    backdrop-filter: blur(6px);
    padding: 12px 24px;

    .label {
      font-size: 24px;
      color: gray;
    }

    .value {
      font-size: 28px;
      font-weight: 900;
      color: #696969;
    }
  }
}


.setting .el-image {
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
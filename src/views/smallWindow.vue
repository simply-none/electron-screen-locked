<template>
  <div class="home">
    <div class="cur-status">
      <div class="item" v-if="curStatus.value === 'rest'">
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
      <div class="item" v-else-if="curStatus.value === 'work'">
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
  <div class="setting">
    <el-image :src="SettingSvg" @click="toSetting"></el-image>
  </div>
</template>

<script setup>
import SettingSvg from '@/assets/set.svg'
import { ref, reactive, watch, computed, onMounted, onUnmounted } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import useWorkOrResetStore from '@/store/useWorkOrReset';
import { storeToRefs } from 'pinia';

const showContent = ref({ error: true });
const timer = ref(null);
const toNextWorkTime = ref('00:00:00');
const toNextRestTime = ref('00:00:00');


onMounted(() => {
  toNext();
  timer.value = setInterval(() => {
    if (curStatus.value.value === 'work') {
      console.log(countDown(nextRestTime.value), 'countDown', nextRestTime.value)
      toNextRestTime.value = countDown(nextRestTime.value);
    } else if (curStatus.value.value === 'rest') {
      console.log(countDown(nextWorkTime.value), 'countDown', nextWorkTime.value)
      toNextWorkTime.value = countDown(nextWorkTime.value);
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

const router = useRouter();

const {
  nextRestTime,
  nextWorkTime,
  startWorkTime,
  closeWorkTime,
  curStatus,
} = storeToRefs(useWorkOrResetStore());

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

function toSetting() {
  router.push('/setting');
}
</script>

<style lang="scss" scoped>
.home {
  height: 100%;
  display: flex;
  flex-direction: column;
  justify-content: center;
  color: #696969;
  // 无窗拖拽
  -webkit-app-region: drag;
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
      font-size: 12px;
      color: gray;
    }

    .value {
      font-size: 16px;
      font-weight: 900;
      color: #696969;
    }
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
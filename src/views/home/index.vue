<template>
  <div class="home" v-if="curStatus.value != 'rest'">
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
          {{ curStatus.label }}
        </div>
      </div>
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
  <template v-else>
    <template v-for="item in restBgOps" :key="item.value">
      <div class="home-rest" v-if="item.value == '1' && restBgColor == '1'">
        <div class="home-rest-body">
          <cus-loading class="home-rest-loading" />
          <div class="home-rest-text">正在进行更新{{ percentage }}%</div>
          <div class="home-rest-text">请不要关闭电脑，完成此操作需要一定的时间。</div>
        </div>
        <div class="home-rest-bottom">
          你的电脑将重启若干次。
        </div>
      </div>
      <div class="home-rest2" v-if="item.value == '2' && restBgColor == '2'">
        <el-image :src="RestBg"></el-image>
        <div class="home-rest2-text">{{ toNextWorkTime || '00:00:00' }}</div>
      </div>
    </template>
  </template>

  <div class="setting">
    <el-image :src="SettingSvg" @click="toSetting"></el-image>
  </div>
</template>

<script setup>
import CusLoading from '../../components/loading.vue';
import SettingSvg from '../../assets/set.svg'
import RestBg from '../../assets/rest-bg.png'
import { ref, reactive, watch, computed, onMounted, onUnmounted } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import useWorkOrReset from '../../hooks/useWorkOrReset';
import useSetting from '../../hooks/useSetting';

const showContent = ref({ error: true });
const timer = ref(null);
const toNextWorkTime = ref('00:00:00');
const toNextRestTime = ref('00:00:00');
const percentage = ref(1);

const { restBgOps, setRestBg } = useSetting();

const restBgColor = ref(window.ipcRenderer.sendSync('get-store', 'restBg') || restBgOps[0].value);

onMounted(() => {
  toNext();
  timer.value = setInterval(() => {
    if (curStatus.value.value === 'work') {
      console.log(countDown(nextRestTime.value), 'countDown', nextRestTime.value)
      toNextRestTime.value = countDown(nextRestTime.value);
    } else if (curStatus.value.value === 'rest') {
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

const router = useRouter();

const {
  nextRestTime,
  nextWorkTime,
  curStatus,
} = useWorkOrReset();

watch(() => curStatus.value.value, () => {
  percentage.value = 1;
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

.home-rest2 {
  width: 100%;
  height: 100%;
  position: relative;

  .el-image {
    width: 100%;
    height: 100%;
  }

  .home-rest2-text {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    padding: 10px 20px;
    color: #8686861f;
    font-size: 20em;
  }
}
</style>
<template>
  <div class="header">
    <header-nav title="设置"></header-nav>
    <el-form class="setting-form" label-width="108" label-position="left" :style="{
      backgroundColor: appInnerColor,
    }">
      <el-form-item>
        <template #label>
          <div class="setting-title">基础数据</div>
        </template>
      </el-form-item>
      <el-form-item label="当前状态">
        <div :class="['cur-status', curStatus === '正在休息' ? 'cur-status-rest' : 'cur-status-work']">
          {{ curStatus }}
        </div>
      </el-form-item>
      <el-form-item label="下次工作时间">
        <div>
          {{ nextWorkTime }}
        </div>
      </el-form-item>
      <el-form-item label="下次休息时间">
        <div>
          {{ nextRestTime }}
        </div>
      </el-form-item>
      <el-form-item label="工作时间">
        <el-input v-model="workTimeGap" placeholder="Please input">
          <template #append>
            <el-select v-model="workTimeGapUnit" placeholder="Select" style="width: 115px">
              <el-option v-for="value in timeUnit" :key="value.times" :label="value.label" :value="value.times" />
            </el-select>
          </template>
        </el-input>
      </el-form-item>
      <el-form-item label="休息时间">
        <el-input v-model="restTimeGap" placeholder="Please input">
          <template #append>
            <el-select v-model="restTimeGapUnit" placeholder="Select" style="width: 115px">
              <el-option v-for="value in timeUnit" :key="value.times" :label="value.label" :value="value.times" />
            </el-select>
          </template>
        </el-input>
      </el-form-item>

      <el-form-item label="">
        <el-button type="primary" @click="() => changeEffectFn()">立即生效</el-button>
      </el-form-item>

      <!-- 分割线 -->
      <el-divider></el-divider>
      <el-form-item>
        <template #label>
          <div class="setting-title">强制设置</div>
        </template>
      </el-form-item>
      <el-form-item label="强制工作次数">
        <el-radio-group v-model="forceWorkTimes" @change="changeForceWorkTimes">
          <el-radio v-for="i in 4" :key="i" :value="i - 1" border>{{ i - 1 }} 次</el-radio>
        </el-radio-group>

      </el-form-item>
      <el-form-item label="立刻强制工作">
        <el-button type="primary" @click="() => forceWorkWithTimes()">强制开始工作</el-button>
        <span style="margin-left: 1em;">今日剩余 {{ forceWorkTimes - todayForceWorkTimes }} 次</span>
      </el-form-item>

      <!-- 分割线 -->
      <el-divider></el-divider>
      <el-form-item>
        <template #label>
          <div class="setting-title">样式美化</div>
        </template>
      </el-form-item>
      <el-form-item label="应用背景颜色">
        <el-color-picker v-model="appBgColor" show-alpha @change="changeAppBgColor" />
      </el-form-item>
      <el-form-item label="页面背景颜色">
        <el-color-picker v-model="appInnerColor" show-alpha @change="changeAppInnerColor" />
      </el-form-item>

      <!-- 分割线 -->
      <el-divider></el-divider>
      <el-form-item>
        <template #label>
          <div class="setting-title">其他设置</div>
        </template>
      </el-form-item>

      <el-form-item label="是否开始工作">
        <el-button type="primary" @click="() => startWorkFn()">开始工作</el-button>

      </el-form-item>
      <el-form-item label="是否开始休息">
        <el-button type="primary" @click="() => startRestFn()">开始休息</el-button>
      </el-form-item>
      <el-form-item label="清空系统数据">
        <el-button type="primary" @click="clearStore">清空数据</el-button>
      </el-form-item>
      <el-form-item label="退出应用">
        <el-button type="primary" @click="quitApp">点击退出应用</el-button>
      </el-form-item>
    </el-form>

  </div>
</template>

<script setup lang="ts">
import { ref, reactive, watch, computed } from 'vue';
import { useRouter } from 'vue-router';
import HeaderNav from '../components/header.vue';
import useWorkOrReset from '../hooks/useWorkOrReset';
import useClearStore from '../hooks/useClearStore';
import useSetting from '../hooks/useSetting';
import { timeUnit } from '../utils/time';
import confirmDialog from '../utils/confirmDialog';

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

const router = useRouter();

const curStatus = computed(() => {
  if (startWorkTime.value >= closeWorkTime.value) {
    return '正在工作';
  } else {
    return '正在休息';
  }
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

function quitApp() {
  confirmDialog.open('确定要退出应用吗？', () => {
    window.ipcRenderer.send('quit-app');
  });
}

function changeForceWorkTimes(value: number) {
  setForceWorkTimes(Number(value));
}

function changeAppBgColor(value: string) {
  setAppBgColor(value);
}

function changeAppInnerColor(value: string) {
  setAppInnerColor(value);
}


function toHome() {
  router.push('/');
}

</script>

<style scoped lang="scss">
.header {}

.setting-title {
  padding-left: 3px;
  border-bottom: 6px solid #6d6d6d;
  width: 100%;
  font-weight: 600;
}

.cur-status {
  &-work {
    &::before {
      content: '•';
      color: #00ffbf;
      display: inline-block;
    }

    &::rest {
      content: '•';
      color: #ff0303;
      display: inline-block;
    }
  }
}

.setting-form {
  padding: 12px;
  background-color: #8c8c8c;
}
</style>
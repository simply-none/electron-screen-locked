<template>
  <layout-vue>
    <template #top>
      <header-nav title="设置" @back="toHome"></header-nav>
    </template>
    <template #main>
      <el-form class="setting-form" label-width="108" label-position="left" :style="{
        backgroundColor: appInnerColor,
      }">
        <el-form-item>
          <template #label>
            <div class="setting-title">基础数据</div>
          </template>
        </el-form-item>
        <el-form-item label="当前状态">
          <div :class="['cur-status', curStatus.value === 'rest' ? 'cur-status-rest' : 'cur-status-work']">
            {{ curStatus.label }}
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
          <span style="margin-left: 1em;">今日剩余 {{ forceWorkTimes - todayForceWorkTimes?.times }} 次</span>
        </el-form-item>

        <!-- 分割线 -->
        <el-divider></el-divider>
        <el-form-item>
          <template #label>
            <div class="setting-title">样式美化</div>
          </template>
        </el-form-item>
        <el-form-item label="应用背景颜色">
          <el-color-picker v-model="appBgColor" show-alpha @change="changeAppBgColor" /><span>{{ appBgColor }}</span>
        </el-form-item>
        <el-form-item label="页面背景颜色">
          <el-color-picker v-model="appInnerColor" show-alpha @change="changeAppInnerColor" /><span>{{ appInnerColor
          }}</span>
        </el-form-item>

        <!-- 分割线 -->
        <el-divider></el-divider>
        <el-form-item>
          <template #label>
            <div class="setting-title">选项设置</div>
          </template>
        </el-form-item>
        <el-form-item label="主页模式" class="mode-wrapper">
          <el-select v-model="activeHomeModeOps" value-key="value" placeholder="Select" style="width: 115px">
            <el-option v-for="item in homeModeOps" :key="item.value" :label="item.label" :value="item" />
          </el-select>
          <div class="mode-ops">
            <el-form-item class="mode-item" v-for="(item, key, index) in activeHomeModeOps" :label="key">
              <!-- <span class="mode-label">{{ key }}</span> -->
              <el-input v-model="activeHomeModeOps[key]" placeholder="请输入" />
            </el-form-item>
          </div>
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
        <el-form-item label="全局字体设置">
          <el-select v-model="globalFont" placeholder="请选择" style="width: 300px" @change="setGlobalFont">
            <el-option v-for="value in globalFontOps" :key="value.value" :label="value.label" :value="value.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="休息背景设置">
          <el-select v-model="restBgColor" placeholder="请选择" style="width: 300px" @change="setForceLockMode">
            <el-option v-for="value in homeModeOps" :key="value.value" :label="value.label" :value="value.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="开机自启动">
          <el-switch v-model="isStartup" inline-prompt active-text="是" inactive-text="否" @change="changeIsStartup" />
        </el-form-item>
        <el-form-item label="退出应用">
          <el-button type="primary" @click="quitApp">点击退出应用</el-button>
        </el-form-item>
      </el-form>
    </template>
  </layout-vue>

</template>

<script setup lang="ts">
import { ref, reactive, watch, computed, toRaw } from 'vue';
import { useRouter } from 'vue-router';

import HeaderNav from '@/components/header.vue';
import useWorkOrResetStore from '@/store/useWorkOrReset'
import { useWorkOrRest } from '@/hooks/useWorkOrReset';
import useClearStore from '@/hooks/useClearStore';
import useGlobalSetting from '@/store/useGlobalSetting';
import { storeToRefs } from 'pinia';
import { timeUnit } from '@/utils/time';
import confirmDialog from '@/utils/confirmDialog';
import LayoutVue from '@/components/layout.vue';

const router = useRouter();

const { clearStore } = useClearStore();
const {
  startWorkFn,
  startRestFn,
  changeEffectFn,
  forceWorkWithTimes,
  nextRestTime,
  nextWorkTime,
} = useWorkOrRest();
const {
  workTimeGap,
  restTimeGap,
  workTimeGapUnit,
  restTimeGapUnit,
  startWorkTime,
  closeWorkTime,
} = storeToRefs(useWorkOrResetStore());
const { setForceWorkTimes, setAppBgColor, setAppInnerColor, setIsStartup, setForceLockMode, setGlobalFont, curStatus } = useGlobalSetting();
const { isStartup, forceWorkTimes, todayForceWorkTimes, appBgColor, appInnerColor, globalFont, globalFontOps, homeModeOps } = storeToRefs(useGlobalSetting());

const activeHomeModeOps = ref(toRaw(homeModeOps.value[0]))

const restBgColor = ref(window.ipcRenderer.sendSync('get-store', 'forceLockMode') || homeModeOps.value[0].value);
console.log(setForceLockMode, 'setForceLockMode',)

setForceLockMode(restBgColor.value)

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

function changeIsStartup(value: boolean) {
  setIsStartup(value);
}

function changeAppInnerColor(value: string) {
  setAppInnerColor(value);
}


function toHome() {
  router.push({
    path: '/',
    query: {
      from: 'setting',
    },
  });
}

</script>

<style scoped lang="scss">
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
  width: 100%;
  height: 100%;
  box-sizing: border-box;
  padding: 12px;
  background-color: #8c8c8c;
}

// 主页模式
:deep(.mode-wrapper) {
  .el-form-item__content {
    flex-direction: column;
    align-items: flex-start;
  }
}
.mode-ops {
  width: 100%;
  padding-top: 12px;
  .mode-item {
    display: flex;
    margin-bottom: 10px;
  }
  .mode-label {
    width: 150px;
  }
}
</style>
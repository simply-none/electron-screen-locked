<template>
  <layout-vue isPadding>
    <template #top>
      <header-nav title="设置" @back="toHome"></header-nav>
    </template>
    <template #main>
      <el-form class="setting-form" label-width="108" label-position="left" :style="{
        // backgroundColor: appInnerColorCc,
      }">
        <el-form-item>
          <template #label>
            <div class="setting-title">基础数据</div>
          </template>
        </el-form-item>
        <el-form-item label="当前状态">
          <div :class="['cur-status', curStatusC.value === 'rest' ? 'cur-status-rest' : 'cur-status-work']">
            {{ curStatusC.label }}
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
          <el-radio-group v-model="forceWorkTimesC" @change="changeForceWorkTimes">
            <el-radio v-for="i in 4" :key="i" :value="i - 1" border>{{ i - 1 }} 次</el-radio>
          </el-radio-group>

        </el-form-item>
        <el-form-item label="立刻强制工作">
          <el-button type="primary" @click="() => forceWorkWithTimes({ isUpdateStartTime: true })">强制开始工作</el-button>
          <span style="margin-left: 1em;">今日剩余 {{ forceWorkTimesC - todayForceWorkTimesC?.times }} 次</span>
        </el-form-item>

        <!-- 分割线 -->
        <el-divider></el-divider>
        <el-form-item>
          <template #label>
            <div class="setting-title">样式美化</div>
          </template>
        </el-form-item>
        <el-form-item label="应用背景颜色">
          <el-color-picker v-model="appBgColorCc" show-alpha @change="changeAppBgColor" /><span>{{ appBgColorCc
            }}</span>
        </el-form-item>
        <el-form-item label="页面背景颜色">
          <el-color-picker v-model="appInnerColorCc" show-alpha @change="changeAppInnerColor" /><span>{{ appInnerColorCc
          }}</span>
        </el-form-item>

        <!-- 分割线 -->
        <el-divider></el-divider>
        <homeMode />

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
          <el-button type="primary" @click="() => startRestFn({ isUpdateCloseTime: true})">开始休息</el-button>
        </el-form-item>
        <el-form-item label="清空系统数据">
          <el-button type="primary" @click="clearStore">清空数据</el-button>
        </el-form-item>
        <el-form-item label="全局字体设置">
          <el-select v-model="globalFontC" placeholder="请选择" style="width: 300px" @change="setGlobalFont">
            <el-option v-for="value in globalFontOpsC" :key="value.value" :label="value.label" :value="value.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="休息背景设置">
          <el-select v-model="restBgColor" placeholder="请选择" style="width: 300px" @change="setHomeMode">
            <el-option v-for="value in homeModeOpsC" :key="value.value" :label="value.label" :value="value.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="开机自启动">
          <el-switch v-model="isStartupC" inline-prompt active-text="是" inactive-text="否" @change="changeIsStartup" />
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

import LayoutVue from '@/components/layout.vue';
import HeaderNav from '@/components/header.vue';
import homeMode from '@/views/setting/homeMode.vue';
import useWorkOrResetStore from '@/store/useWorkOrReset'
import { useWorkOrRest } from '@/hooks/useWorkOrReset';
import useClearStore from '@/hooks/useClearStore';
import useGlobalSetting from '@/store/useGlobalSetting';
import { storeToRefs } from 'pinia';
import { timeUnit } from '@/utils/time';
import confirmDialog from '@/utils/confirmDialog';

const router = useRouter();

const { clearStore } = useClearStore();
const {
  startWorkFn,
  startRestFn,
  changeEffectFn,
  forceWorkWithTimes,
} = useWorkOrRest();
const {
  workTimeGap,
  restTimeGap,
  workTimeGapUnit,
  restTimeGapUnit,
  startWorkTime,
  closeWorkTime,
  nextRestTime,
  nextWorkTime,
} = storeToRefs(useWorkOrResetStore());
const { setForceWorkTimes, setAppBgColor, setAppInnerColor, setIsStartup, setHomeMode, setGlobalFont, setHomeModeOps } = useGlobalSetting();
const { isStartupC, forceWorkTimesC, todayForceWorkTimesC, appBgColorC, appInnerColorC, globalFontC, globalFontOpsC, homeModeOpsC, curStatusC } = storeToRefs(useGlobalSetting());

const appBgColorCc = ref(JSON.parse(JSON.stringify(appBgColorC.value)))
const appInnerColorCc = ref(JSON.parse(JSON.stringify(appInnerColorC.value)))
const homeModeOpsCc = ref(JSON.parse(JSON.stringify(homeModeOpsC.value)))
const activeHomeModeOps = ref(toRaw(homeModeOpsCc.value[0]))

watch(() => homeModeOpsC.value, (n) => {
  homeModeOpsCc.value = JSON.parse(JSON.stringify(n));
}, {
  immediate: true,
  deep: true,
})

function changeModeOps() {
  const findIndex = homeModeOpsCc.value.findIndex((item: any) => item.value === activeHomeModeOps.value.value);
  homeModeOpsCc.value.splice(findIndex, 1, activeHomeModeOps.value);
  setHomeModeOps(homeModeOpsCc.value);
}

const restBgColor = ref();

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
  box-sizing: border-box;
  padding: 12px;
  background-color: #ffffff;
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
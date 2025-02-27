<template>
  <el-form class="setting-home-mode-form" label-width="108" label-position="left">
    <el-form-item>
      <template #label>
        <div class="setting-title">主页模式</div>
      </template>
    </el-form-item>
    <el-form-item label="日常模式" class="mode-wrapper">
      <el-select v-model="homeModeCc.work.value" value-key="value" placeholder="Select" style="width: 226px" @change="changeHomeMode('work')">
        <el-option v-for="item in homeModeOpsCc" :key="item.value" :label="item.label" :value="item.value" />
      </el-select>
    </el-form-item>
    <el-form-item label="锁定模式" class="mode-wrapper">
      <el-select v-model="homeModeCc.rest.value" value-key="value" placeholder="Select" style="width: 226px" @change="changeHomeMode('rest')">
        <el-option v-for="item in homeModeOpsCc" :key="item.value" :label="item.label" :value="item.value" />
      </el-select>
    </el-form-item>
    <el-form-item label="屏保模式" class="mode-wrapper">
      <el-select v-model="homeModeCc.screen.value" value-key="value" placeholder="Select" style="width: 226px" @change="changeHomeMode('screen')">
        <el-option v-for="item in homeModeOpsCc" :key="item.value" :label="item.label" :value="item.value" />
      </el-select>
    </el-form-item>
    <el-form-item label="属性修改" class="mode-wrapper">
      <div class="mode-ops">
        <div>修改前：</div>
        <el-form-item class="mode-item" v-for="(item, key, index) in (homeModeCc[activeHomeMode] as unknown as object)"
          :label="key">
          <!-- <span class="mode-label">{{ key }}</span> -->
          <el-color-picker v-if="(key as unknown as string).endsWith('Color')" v-model="activeHomeModeOps[key]"
            show-alpha @change="changeModeOps" />
          <el-input v-else v-model="activeHomeModeOps[key]" placeholder="请输入"
            :disabled="['label', 'value'].includes(key as unknown as string)" @change="changeModeOps" />
        </el-form-item>
      </div>
      <div>修改后：</div>
      <div class="mode-ops">
        <el-form-item class="mode-item" v-for="(item, key, index) in (activeHomeModeOps as unknown as object)"
          :label="key">
          <!-- <span class="mode-label">{{ key }}</span> -->
          <el-color-picker v-if="(key as unknown as string).endsWith('Color')" v-model="activeHomeModeOps[key]"
            show-alpha @change="changeModeOps" />
          <el-input v-else v-model="activeHomeModeOps[key]" placeholder="请输入"
            :disabled="['label', 'value'].includes(key as unknown as string)" @change="changeModeOps" />
        </el-form-item>
      </div>
      
    </el-form-item>

  </el-form>

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
import type { StatusMode, CommonObj } from '@/store/useGlobalSetting'

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
const { isStartupC, forceWorkTimesC, todayForceWorkTimesC, appBgColorC, appInnerColorC, globalFontC, globalFontOpsC, homeModeOpsC, curStatusC, homeModeC } = storeToRefs(useGlobalSetting());

const appBgColorCc = ref(JSON.parse(JSON.stringify(appBgColorC.value)))
const appInnerColorCc = ref(JSON.parse(JSON.stringify(appInnerColorC.value)))
const homeModeCc = ref<Record<StatusMode, CommonObj>>(JSON.parse(JSON.stringify(homeModeC.value)))
const homeModeOpsCc = ref(JSON.parse(JSON.stringify(homeModeOpsC.value)))
const activeHomeModeOps = ref(toRaw(homeModeOpsCc.value[0]))
const activeHomeMode = ref<StatusMode>('work');
watch(() => homeModeOpsC.value, (n) => {
  homeModeOpsCc.value = JSON.parse(JSON.stringify(n));
}, {
  immediate: true,
  deep: true,
})
watch(() => homeModeC.value, (n) => {
  homeModeCc.value = JSON.parse(JSON.stringify(n)); 
}, { deep: true })

function changeModeOps() {
  changeHomeMode(activeHomeMode.value);
}

function changeHomeMode(key: StatusMode) {
  const find = homeModeOpsCc.value.find((item: any) => item.value === homeModeCc.value[key].value);
  homeModeCc.value[key] = find;
  activeHomeModeOps.value = find;
  setHomeMode(homeModeCc.value); 
  activeHomeMode.value = key;
}

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

  .mode-item {
    display: flex;
    margin-bottom: 10px;
  }

  .mode-label {
    width: 150px;
  }
}
</style>
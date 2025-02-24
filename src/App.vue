<script setup lang="ts">
import { watch, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { storeToRefs } from 'pinia';
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import electronConfig from './electron-builder.json5'
import useWorkOrResetStore from '@/store/useWorkOrReset'
import { useWorkOrRest } from '@/hooks/useWorkOrReset';
import useGlobalSetting from '@/store/useGlobalSetting';

const { appBgColor, appInnerColor, forceLockMode } = storeToRefs(useGlobalSetting());
const { curStatus } = storeToRefs(useGlobalSetting());
const { startApp, nextRestTime, nextWorkTime } = useWorkOrRest(); 

onMounted(() => {
  console.log(window.location.href)
  if (window.location.href.includes('isSecondWindow=true')) {
    return true;
  }
  startApp();
});
console.log('appBgColor', appBgColor);
let bgColor = ref(appBgColor)
const innerColor = ref(appInnerColor)

watch(() => curStatus.value.value, (n) => {
  console.log('curStatus', n);
  if (n == 'rest') {
    if (forceLockMode.value == '2') {
      bgColor.value = '#000c18';
      innerColor.value = '#000c18';
    }
    else {
      bgColor.value = '#0077d7';
      innerColor.value = '#0077d7';
    }
  } else {
    bgColor.value = appBgColor.value;
    innerColor.value = appInnerColor.value;
  }
}, { immediate: true, deep: true })


watch(appInnerColor, (n, o) => {
  console.log('appInnerColor', n, o);
});

document.title = electronConfig.productName;

</script>

<template>
  <router-view v-slot="{ Component }">
    <el-config-provider :locale="zhCn">
      <transition>
        <component :is="Component" />
      </transition>
    </el-config-provider>
  </router-view>
</template>

<style lang="scss">
html,
body,
#app {
  margin: 0;
  padding: 0;
  width: 100%;
  height: 100%;
}

.page {
  width: 100%;
  height: 100%;
  padding: 12px;
  background-color: v-bind('bgColor');
  box-sizing: border-box;

  &-container {
    width: 100%;
    height: 100%;
    padding: 12px;
    background-color: v-bind('innerColor');
    overflow-y: auto;
    box-sizing: border-box;
  }
}

.flex-center {
  display: flex;
  align-items: center;
  justify-content: center;
}

.logo {
  height: 6em;
  padding: 1.5em;
  will-change: filter;
  transition: filter 300ms;
}
</style>

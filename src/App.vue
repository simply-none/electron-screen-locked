<script setup lang="ts">
import { watch, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { storeToRefs } from 'pinia';
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import electronConfig from './electron-builder.json5'
import useWorkOrResetStore from '@/store/useWorkOrReset'
import { useWorkOrRest } from '@/hooks/useWorkOrReset';
import useGlobalSetting from '@/store/useGlobalSetting';

const { setAppBgColor, setAppInnerColor } = useGlobalSetting()
const { appBgColorC, appInnerColorC, curStatusC } = storeToRefs(useGlobalSetting());
const { nextRestTime, nextWorkTime } = storeToRefs((useWorkOrResetStore()))
const { startApp } = useWorkOrRest();

onMounted(() => {
  console.log(window.location.href)
  if (window.location.href.includes('isSecondWindow=true')) {
    return true;
  }
  startApp();
});
console.log('appBgColorC', appBgColorC);
let bgColor = ref(appBgColorC)
const innerColor = ref(appInnerColorC)

watch(() => curStatusC.value.value, (n) => {
  console.log('curStatusC', n);
  if (n == 'rest') {
    // TODO: 设置背景色
  }
}, { immediate: true, deep: true })


watch(appInnerColorC, (n, o) => {
  console.log('appInnerColorC', n, o);
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

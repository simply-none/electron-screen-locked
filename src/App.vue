<script setup lang="ts">
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import useSetting from './hooks/useSetting';

const { appBgColor, appInnerColor } = useSetting();

</script>

<template>
  <router-view class="page-container" v-slot="{ Component }">
    <el-config-provider :locale="zhCn">
      <transition>
      <div class="page">
        <component :is="Component" />
      </div>
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
  background-color: v-bind('appBgColor');
  box-sizing: border-box;
  &-container {
    width: 100%;
    height: 100%;
    padding: 12px;
    background-color: v-bind('appInnerColor');
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

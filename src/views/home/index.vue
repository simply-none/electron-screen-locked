<template>
  <layout-vue>
    <template #main>
      <component :is="curComponent" />
      <div class="setting">
        <el-image :src="SettingSvg" @click="toSetting"></el-image>
      </div>
    </template>
  </layout-vue>

</template>

<script setup>
import { ref, reactive, watch, computed, onMounted, onUnmounted } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { storeToRefs } from 'pinia';

import ShowImage from '@/views/home/showImage.vue';
import TranslucentPoemDisplay from '@/views/home/translucentPoemDisplay.vue';
import ImitationWindowsUpdate from '@/views/home/imitationWindowsUpdate.vue';
import LayoutVue from '@/components/layout.vue';
import SettingSvg from '@/assets/set.svg'
import useGlobalSetting from '@/store/useGlobalSetting';

const router = useRouter();

const { homeModeC, curStatusC } = storeToRefs(useGlobalSetting());

const curComponent = ref(TranslucentPoemDisplay)

watch(() => homeModeC.value[curStatusC.value.value], (n, o) => {
  console.log(n, o, 'homeModeC')
  switch (n.value) {
    case '0':
      curComponent.value = TranslucentPoemDisplay
      break;
    case '1':
      curComponent.value = ImitationWindowsUpdate
      break;
    case '2':
      curComponent.value = ShowImage
      break;
  }
}, { immediate: true, deep: true })

function toggleComponent(status) {
  switch (status) {
    case 'work':
      return 'work'
    case 'rest':
      return 'rest'
  }
}

watch(() => curStatusC.value.value, () => {
  // 首页展示组件模式变更
  toggleComponent(curStatusC.value.value)
}, { immediate: true, deep: true })

function toSetting() {
  router.push('/setting');
}
</script>

<style lang="scss" scoped>
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
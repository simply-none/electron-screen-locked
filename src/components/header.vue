<template>
  <el-page-header :icon="ArrowLeft" @back="back">
    <template #content>
      <span class="text-large font-600 mr-3">{{ title }}</span>
    </template>
  </el-page-header>
</template>

<script lang="ts" setup>
import { ArrowLeft } from '@element-plus/icons-vue'

const props = defineProps({
  title: {
    type: String,
    default: '',
  },
  hideBack: {
    type: Boolean,
    default: false,
  },
})

const emit = defineEmits(['back'])

function back () {
  emit('back')
}
</script>
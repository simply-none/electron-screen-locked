<template>
  <!-- 导出对话框：集合（Postman / OpenAPI）与环境变量（Postman Env）三选一 -->
  <el-dialog v-model="visible" title="导出接口" width="420px" :close-on-click-modal="false">
    <el-form label-width="80px">
      <el-form-item label="导出格式">
        <el-radio-group v-model="format">
          <el-radio-button value="postman">Postman Collection</el-radio-button>
          <el-radio-button value="openapi">OpenAPI 3.0</el-radio-button>
          <el-radio-button value="env">Postman 环境</el-radio-button>
        </el-radio-group>
      </el-form-item>
      <!-- 环境格式时选择具体环境 -->
      <el-form-item v-if="format === 'env'" label="环境">
        <el-select v-model="envId" placeholder="选择要导出的环境" style="width: 100%">
          <el-option v-for="env in envs" :key="env.id" :label="env.name" :value="env.id" />
        </el-select>
      </el-form-item>
      <p class="export-tip">{{ formatTip }}</p>
    </el-form>
    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button type="primary" :loading="exporting" @click="onExport">导出</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
/**
 * 导出接口对话框
 * ------------------------------------------------------------------
 * 职责：把集合树导出为 Postman Collection v2.1 / OpenAPI 3.0，
 * 或把环境变量导出为 Postman Environment v2.1。
 * 生成 JSON 后走主进程 net-request:save-file 弹出系统保存对话框写盘。
 */
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import type { CollectionNode, Environment } from '../../types'
import {
  buildOpenApi,
  buildPostmanCollection,
  buildPostmanEnvironments,
} from '../../composables/useExport'
import { exportTextToCache } from '@/utils/exportToFile'

/** 弹窗可见性（v-model） */
const visible = defineModel<boolean>({ default: false })

/** 组件 props 定义 */
const props = defineProps<{
  /** 集合树（Postman/OpenAPI 导出来源） */
  tree: CollectionNode[];
  /** 环境列表（Postman 环境导出来源） */
  envs: Environment[];
}>()

/** 导出格式 */
const format = ref<'postman' | 'openapi' | 'env'>('postman')
/** 环境格式时选中的环境 id */
const envId = ref<number>(0)
/** 导出中标记 */
const exporting = ref(false)

/** 格式说明文案 */
const formatTip = computed(() => {
  if (format.value === 'postman') return '导出为 Postman Collection v2.1，可在 Postman/Apifox 中导入'
  if (format.value === 'openapi') return '导出为 OpenAPI 3.0 文档，可在 Swagger/Apifox 中导入'
  return '导出为 Postman Environment v2.1，包含所选环境的全部变量'
})

// 弹窗打开时默认选中第一个环境
watch(visible, (val) => {
  if (val && !envId.value && props.envs.length) {
    envId.value = props.envs[0].id
  }
})

/**
 * 执行导出：生成 JSON → 走主进程保存对话框写盘
 * @throws 集合为空 / 未选环境时提示；写盘失败显式报错
 */
async function onExport(): Promise<void> {
  let text = ''
  let defaultName = ''
  if (format.value === 'postman') {
    if (!props.tree.length) {
      ElMessage.warning('集合为空，无可导出的接口')
      return
    }
    text = buildPostmanCollection(props.tree)
    defaultName = `netrequest_collection_${Date.now()}.postman_collection.json`
  } else if (format.value === 'openapi') {
    if (!props.tree.length) {
      ElMessage.warning('集合为空，无可导出的接口')
      return
    }
    text = buildOpenApi(props.tree)
    defaultName = `netrequest_collection_${Date.now()}.openapi.json`
  } else {
    const env = props.envs.find((e) => e.id === envId.value)
    if (!env) {
      ElMessage.warning('请选择要导出的环境')
      return
    }
    text = buildPostmanEnvironments([env])
    defaultName = `${env.name || 'environment'}.postman_environment.json`
  }
  exporting.value = true
  try {
    // 统一导出工具：直写缓存目录、不弹保存框，成功用 fileNotify 提示
    const res = exportTextToCache(text, defaultName, { title: '接口已导出' })
    if (res.success) {
      visible.value = false
    } else {
      ElMessage.error('导出失败：' + (res.message || '未知错误'))
    }
  } finally {
    exporting.value = false
  }
}
</script>

<style scoped lang="scss">
.export-tip {
  margin: 0 0 4px 80px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  line-height: 1.5;
}
</style>

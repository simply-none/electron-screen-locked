<template>
  <div class="response-actions">
    <!-- 复制 cURL -->
    <el-button size="small" text type="primary" @click="copyCurl">
      <LucideIcon name="Code" :size="13" />
      复制 cURL
    </el-button>
    <!-- 复制响应体 -->
    <el-button size="small" text type="primary" @click="copyBody">
      <LucideIcon name="Copy" :size="13" />
      复制响应
    </el-button>
    <!-- 保存响应到本地（二进制走 base64，文本直接写文件） -->
    <el-button size="small" text type="primary" @click="saveResponse">
      <LucideIcon name="Download" :size="13" />
      保存响应
    </el-button>
    <!-- 存入笔记 -->
    <el-button size="small" text type="primary" @click="emit('saveNote')">
      <LucideIcon name="NotebookPen" :size="13" />
      存入笔记
    </el-button>
  </div>
</template>

<script setup lang="ts">
/**
 * 响应操作条：复制 cURL / 复制响应体 / 保存响应到本地 / 存入笔记
 * 保存响应走主进程 net-request:save-file（系统保存对话框）：
 * - 文本类响应（json/text/xml/html 等）直接写文本；
 * - 二进制响应（图片/文件等）走主进程返回的 base64 还原写入。
 */
import { ElMessage } from 'element-plus'
import type { ResponseRecord } from '../../types'
import { copyAsCurl } from '../../composables/useRequest'
import { exportTextToCache, exportBufferToCache } from '@/utils/exportToFile'

/** 组件 props 定义 */
const props = defineProps<{
  /** 响应记录 */
  record: ResponseRecord | null;
}>()

/** 事件：存入笔记（由父组件打开笔记对话框） */
const emit = defineEmits<{
  (e: 'saveNote'): void
}>()

/**
 * 复制最近一次请求的 cURL 命令
 */
function copyCurl(): void {
  const curl = copyAsCurl()
  if (!curl) {
    ElMessage.warning('请先发送一次请求')
    return
  }
  window.ipcRenderer.clipboard.writeText(curl)
  ElMessage.success('已复制 cURL 命令')
}

/**
 * 复制响应体文本（JSON 会格式化后复制）
 */
function copyBody(): void {
  if (!props.record) return
  const text =
    typeof props.record.body === 'object'
      ? JSON.stringify(props.record.body, null, 2)
      : String(props.record.body ?? '')
  window.ipcRenderer.clipboard.writeText(text)
  ElMessage.success('已复制响应内容')
}

/**
 * 根据 content-type 推断保存的文件扩展名
 * @param contentType 响应 content-type
 * @param isTextish 是否为文本类响应
 * @returns 扩展名（不含点）
 */
function extFromContentType(contentType: string, isTextish: boolean): string {
  const ct = contentType.toLowerCase()
  if (ct.includes('json')) return 'json'
  if (ct.includes('html')) return 'html'
  if (ct.includes('xml')) return 'xml'
  if (ct.includes('csv')) return 'csv'
  if (ct.includes('javascript')) return 'js'
  if (ct.includes('image/png')) return 'png'
  if (ct.includes('image/jpeg')) return 'jpg'
  if (ct.includes('image/gif')) return 'gif'
  if (ct.includes('image/webp')) return 'webp'
  if (ct.includes('image/svg')) return 'svg'
  if (ct.includes('image/')) return 'img'
  if (ct.includes('pdf')) return 'pdf'
  if (ct.includes('zip')) return 'zip'
  if (ct.includes('gzip')) return 'gz'
  if (ct.includes('audio/')) return 'audio'
  if (ct.includes('video/')) return 'video'
  if (ct.includes('octet-stream')) return 'bin'
  return isTextish ? 'txt' : 'bin'
}

/**
 * 保存响应体到本地文件
 * @throws 无 base64 的二进制响应提示不支持
 */
async function saveResponse(): Promise<void> {
  if (!props.record) return
  const record = props.record
  const isTextish = /json|text|xml|html|javascript|csv|urlencoded/i.test(record.contentType)
  if (!isTextish && !record.base64) {
    ElMessage.warning('该响应无法保存为文件')
    return
  }
  const ext = extFromContentType(record.contentType, isTextish)
  const fileName = `response_${Date.now()}.${ext}`
  // 统一导出规范：直写缓存目录、不弹保存框，成功用 fileNotify 提示
  const res = isTextish
    ? exportTextToCache(
        typeof record.body === 'object'
          ? JSON.stringify(record.body, null, 2)
          : String(record.body ?? ''),
        fileName,
        { title: '响应已保存' },
      )
    : exportBufferToCache(record.base64 || '', fileName, { title: '响应已保存' })
  if (!res.success) {
    ElMessage.error('保存失败：' + (res.message || '未知错误'))
  }
}
</script>

<style scoped lang="scss">
.response-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}
</style>

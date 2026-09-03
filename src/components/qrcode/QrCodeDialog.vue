<template>
  <AppDialog
    :model-value="modelValue"
    :title="title"
    width="420px"
    @update:model-value="(v: boolean) => emit('update:modelValue', v)"
  >
    <div class="qr-dialog">
      <QrCodeView
        ref="viewRef"
        :content="content"
        :style-options="styleOptions"
        :size="size"
        :auto-render="autoRender"
      />

      <div class="qr-dialog-actions">
        <button class="qr-act" @click="onDownload">
          <LucideIcon name="Download" :size="15" /> 下载图片
        </button>
        <button class="qr-act" @click="onCopy">
          <LucideIcon name="Copy" :size="15" /> 复制
        </button>
        <button class="qr-act qr-act-ghost" @click="onSaveText">
          <LucideIcon name="FileText" :size="15" /> 存文本
        </button>
      </div>
    </div>
  </AppDialog>
</template>

<script setup lang="ts">
/**
 * 二维码弹窗（L2 复用组件，模板内使用）
 * 组合 QrCodeView + 三个动作（下载 / 复制 / 存文本）。
 * 下载/复制/存文本均走主进程 IPC（磁盘与剪贴板禁止在渲染端触碰）。
 */
import { ref } from 'vue';
import { ElMessage } from 'element-plus';
import AppDialog from '@/components/AppDialog.vue';
import LucideIcon from '@/components/LucideIcon.vue';
import QrCodeView from './QrCodeView.vue';
import {
  copyQrImage,
  saveQrText,
  buildQrFileName,
} from '@/utils/qrcode';
import { fileNotify } from '@/utils/fileNotify';
import { exportBufferToCache } from '@/utils/exportToFile';
import type { QrStyleOptions } from '@/utils/qrcode';

const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    /** 二维码原始文本 */
    content: string;
    styleOptions?: QrStyleOptions | null;
    title?: string;
    /** 建议文件名（不含扩展名），默认 qrcode */
    defaultName?: string;
    size?: number;
    autoRender?: boolean;
  }>(),
  {
    styleOptions: null,
    title: '二维码',
    defaultName: 'qrcode',
    size: 320,
    autoRender: true,
  },
);

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void;
  (e: 'saved'): void;
}>();

const viewRef = ref<InstanceType<typeof QrCodeView> | null>(null);

async function onDownload() {
  const dataUrl = viewRef.value?.getDataUrl();
  if (!dataUrl) {
    ElMessage.warning('二维码尚未生成');
    return;
  }
  const base64 = dataUrl.split(',')[1];
  if (!base64) {
    ElMessage.error('二维码数据无效');
    return;
  }
  // 统一导出规范：直写缓存目录、不弹保存框，成功用 fileNotify 提示
  const res = exportBufferToCache(base64, `${buildQrFileName(props.content || props.defaultName)}.png`, {
    title: '二维码已保存',
  });
  if (res.success) {
    emit('saved');
  } else {
    ElMessage.error('保存失败：' + (res.message || '未知错误'));
  }
}

async function onCopy() {
  const dataUrl = viewRef.value?.getDataUrl();
  if (!dataUrl) {
    ElMessage.warning('二维码尚未生成');
    return;
  }
  const res = await copyQrImage({ dataUrl });
  if (res?.ok) ElMessage.success('已复制到剪贴板');
  else ElMessage.error('复制失败：' + (res?.error || '未知错误'));
}

async function onSaveText() {
  if (!props.content) {
    ElMessage.warning('内容为空');
    return;
  }
  const res = await saveQrText({
    text: props.content,
    defaultName: buildQrFileName(props.content || props.defaultName),
  });
  if (res?.canceled) return;
  if (res?.ok) {
    fileNotify({ title: '文本已保存', filePath: res.path });
  } else {
    ElMessage.error('保存失败：' + (res?.error || '未知错误'));
  }
}
</script>

<style scoped lang="scss">
.qr-dialog {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  padding: 4px;
}

.qr-dialog-actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  justify-content: center;
}

.qr-act {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 14px;
  font-size: 13px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-btn, 8px);
  background: var(--bg-card);
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.15s;

  &:hover {
    border-color: var(--color-primary);
    color: var(--color-primary);
    background: var(--color-primary-light, rgba(99, 102, 241, 0.08));
  }
}

.qr-act-ghost {
  margin-left: auto;
}
</style>

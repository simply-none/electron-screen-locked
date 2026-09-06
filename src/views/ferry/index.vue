<template>
  <div class="ferry-page">
    <div class="ferry-header">
      <LucideIcon name="ScanQrCode" :size="30" class="ferry-logo" />
      <div class="ferry-title">
        <h2>隔空互传</h2>
        <p>无需局域网，屏幕二维码直传</p>
      </div>
    </div>

    <div class="ferry-card">
      <p class="ferry-desc">
        把文件编码成屏幕上滚动的动态二维码，对方用摄像头扫描即可接收。全程<strong>不经过服务器、不经过局域网</strong>（屏幕
        → 摄像头直传），适合在没有 Wi-Fi 的场景快速把小文件从电脑传手机、或手机传电脑。
      </p>

      <el-alert type="warning" :closable="false" show-icon class="ferry-note">
        <template #title>
          仅适合 ≤10MB 的小文件（文档 / 图片 / 短文本）。大文件会因逐帧扫描而非常缓慢。
        </template>
      </el-alert>

      <el-button type="primary" size="large" :loading="opening" @click="openFerry">
        <LucideIcon name="ScanQrCode" :size="18" />
        <span>打开隔空互传</span>
      </el-button>

      <p v-if="error" class="ferry-error">{{ error }}</p>

      <ul class="ferry-tips">
        <li>发送端：在本窗口选择文件，屏幕会显示动态二维码。</li>
        <li>接收端：用另一台设备（手机/电脑）的摄像头对准该二维码即可接收。</li>
        <li>首次使用请允许浏览器/系统访问摄像头。</li>
      </ul>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import LucideIcon from '@/components/LucideIcon.vue';

const opening = ref(false);
const error = ref('');

async function openFerry() {
  opening.value = true;
  error.value = '';
  try {
    const res = await window.ipcRenderer.handlePromise('ferry:open', {});
    if (!res || !res.success) {
      error.value = '打开失败：' + ((res && res.error) || '未知错误');
    }
  } catch (e) {
    error.value = '打开失败：' + String(e);
  } finally {
    opening.value = false;
  }
}
</script>

<style scoped lang="scss">
.ferry-page {
  width: 100%;
  height: 100%;
  box-sizing: border-box;
  padding: 24px;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.ferry-header {
  display: flex;
  align-items: center;
  gap: 14px;

  .ferry-logo {
    color: var(--color-primary);
  }

  .ferry-title {
    h2 {
      margin: 0;
      font-size: 22px;
      font-weight: 700;
      color: var(--text-primary);
    }

    p {
      margin: 4px 0 0;
      font-size: 13px;
      color: var(--text-muted);
    }
  }
}

.ferry-card {
  background: var(--bg-card);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-card);
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 16px;

  .ferry-desc {
    margin: 0;
    font-size: 14px;
    line-height: 1.7;
    color: var(--text-secondary);
  }

  .ferry-note {
    margin: 0;
  }

  .el-button {
    align-self: flex-start;
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }

  .ferry-error {
    margin: 0;
    font-size: 13px;
    color: var(--el-color-danger, #f56c6c);
  }

  .ferry-tips {
    margin: 0;
    padding-left: 18px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 13px;
    color: var(--text-muted);
    line-height: 1.6;
  }
}
</style>

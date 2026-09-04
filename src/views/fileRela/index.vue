<template>
  <div class="file-rela-container">
    <!-- <div class="page-header">
      <h2 class="page-title">文件管理</h2>
    </div> -->

    <div class="cards-grid">
      <div class="file-card">
        <div class="card-header">
          <h3 class="card-title">
            <el-icon><LucideIcon name="UploadCloud" /></el-icon>
            文件上传测试
          </h3>
        </div>
        <div class="card-body">
          <upload-vue :limit="1" @update-data="updateDataFn" />
        </div>
      </div>

      <FileTransferVue></FileTransferVue>

      <FileDeleteVue></FileDeleteVue>

      <FileScanVue :defaultAppPaths="defaultAppPaths"></FileScanVue>

      <FileRenameVue></FileRenameVue>

      <ShellMenuManagerVue></ShellMenuManagerVue>

      <div class="file-card">
        <div class="card-header">
          <h3 class="card-title">
            <el-icon><LucideIcon name="GamepadDirectional" /></el-icon>
            默认应用
          </h3>
        </div>
        <div class="card-body">
          <DefaultApp @updateDefaultAppPaths="updateDefaultAppPaths"></DefaultApp>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import LucideIcon from '@/components/LucideIcon.vue';
import UploadVue from '@/components/upload.vue';
import FileScanVue from './fileScan.vue';
import FileRenameVue from './fileRename.vue';
import ShellMenuManagerVue from './ShellMenuManager.vue';
import FileTransferVue from './fileTransfer.vue';
import FileDeleteVue from './fileDelete.vue';
import DefaultApp from './defaultApp.vue';

const defaultAppPaths = ref<Record<string, ObjectType>>({});
const updateDefaultAppPaths = (list: Record<string, ObjectType>) => {
  defaultAppPaths.value = list;
};

function updateDataFn(data: any, data2: any) {
  console.log(data, data2);
}
</script>

<style scoped lang="scss">
.file-rela-container {
  // padding: 24px;
  box-sizing: border-box;
  min-height: 100%;
}

.page-header {
  margin-bottom: 24px;
}

.page-title {
  font-size: 24px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0;
}

.cards-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 20px;
}

.file-card {
  background: var(--bg-card);
  border-radius: 12px;
  box-shadow: var(--shadow-card);
  overflow: hidden;
}

.card-header {
  padding: 16px 20px;
  border-bottom: 1px solid var(--border-subtle);
}

.card-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
}

.card-body {
  padding: 20px;
}
</style>

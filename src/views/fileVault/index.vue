<template>
  <div class="fv">
    <!-- 未建库：首次设置口令 -->
    <UnlockView v-if="!store.hasVault" v-model="showUnlock" mode="create" @done="onUnlocked" />

    <!-- 已建库未解锁 -->
    <UnlockView
      v-else-if="store.hasVault && !store.isUnlocked"
      v-model="showUnlock"
      mode="unlock"
      @done="onUnlocked"
    />

    <!-- 已解锁：工具栏 + 文件列表 -->
    <template v-else>
      <div class="fv-toolbar">
        <div class="fv-toolbar__title">
          <LucideIcon name="LockKeyhole" :size="20" />
          <span>私密文件保险箱</span>
          <span class="fv-count">{{ store.files.length }} 个文件</span>
        </div>
        <div class="fv-toolbar__actions">
          <div class="fv-autolock">
            <span class="fv-autolock__label">自动锁定</span>
            <select v-model.number="idleMinutes" class="fv-autolock__select" @change="onIdleChange">
              <option :value="1">1 分钟</option>
              <option :value="5">5 分钟</option>
              <option :value="10">10 分钟</option>
              <option :value="15">15 分钟</option>
              <option :value="30">30 分钟</option>
            </select>
          </div>
          <button class="fv-btn" @click="openDecryptDialog">
            <LucideIcon name="FileBox" :size="16" /> 导入解密
          </button>
          <button class="fv-btn fv-btn--primary" @click="openImportDialog">
            <LucideIcon name="Upload" :size="16" /> 导入加密
          </button>
          <button class="fv-btn" @click="lockNow">
            <LucideIcon name="Lock" :size="16" /> 锁定
          </button>
        </div>
      </div>

      <div v-if="store.files.length" class="fv-gridwrap">
        <FileGrid :files="store.files" @preview="onPreview" @export="onExport" @delete="onDelete" />
      </div>
      <div v-else class="fv-empty">
        <LucideIcon name="FileBox" :size="40" />
        <p>保险箱是空的，点击「导入加密」添加敏感文件</p>
      </div>
    </template>

    <ImportDialog v-model="showImport" :initial-files="importInitialFiles" @done="onImported" />
    <PreviewDialog v-model="showPreview" :file="previewFile" @export="onExport" @closed="onPreviewClosed" />
    <DecryptImportDialog v-model="showDecrypt" :initial-files="decryptInitialFiles" />
  </div>
</template>

<script setup lang="ts">
/**
 * 私密文件保险箱主视图
 * - 未建库：引导设置口令；
 * - 已建库未解锁：引导解锁；
 * - 已解锁：导入 / 列表 / 预览 / 导出 / 删除 / 锁定。
 * 所有密钥与文件加解密均在主进程完成，渲染端不持有明文与密钥。
 */
import { ref, watch, onMounted, onUnmounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { fileNotify } from '@/utils/fileNotify';
import LucideIcon from '@/components/LucideIcon.vue';
import { useAutoLock, suspendAutoLockForNative, resumeAutoLockForNative } from '@/composables/useAutoLock';
import useFileVault from './store/useFileVault';
import { fileVaultApi } from './api/fileVaultApi';
import UnlockView from './components/UnlockView.vue';
import FileGrid from './components/FileGrid.vue';
import ImportDialog from './components/ImportDialog.vue';
import PreviewDialog from './components/PreviewDialog.vue';
import DecryptImportDialog from './components/DecryptImportDialog.vue';
import type { VaultFileMeta } from './types';

const store = useFileVault();
const showImport = ref(false);
const showPreview = ref(false);
const showDecrypt = ref(false);
const previewFile = ref<VaultFileMeta | null>(null);
/** 解锁门（创建/解锁弹窗）显隐：锁定态显示、解锁态隐藏；由 isUnlocked 同步 */
const showUnlock = ref(true);
/** 右键菜单预填文件（encrypt 走 ImportDialog，decrypt 走 DecryptImportDialog）；消费后由对应对话框清空 */
const importInitialFiles = ref<string[]>([]);
const decryptInitialFiles = ref<string[]>([]);
/** 右键任务需要「先解锁再执行」时，暂存解锁后的打开动作 */
const pendingAfterUnlock = ref<null | (() => void)>(null);

/** 自动锁定：空闲阈值（分钟），解锁后启用；切换原生对话框时暂停避免误锁 */
const idleMinutes = ref(5);
const autoLock = useAutoLock({
  idleMinutes,
  onLock: () => onAutoLock(),
});

/** 解锁态变化：进入解锁即启动自动锁定监听并收起解锁门，回到锁定态即停止并显示解锁门 */
watch(
  () => store.isUnlocked,
  (unlocked) => {
    showUnlock.value = !unlocked;
    if (unlocked) autoLock.start();
    else autoLock.stop();
  },
  { immediate: true },
);

/** 打开原生文件对话框（导入/导出/导入解密）前暂停，关闭后恢复，避免失焦误触发锁定 */
watch([showImport, showPreview, showDecrypt], ([imp, prev, dec]) => {
  if (imp || prev || dec) autoLock.pause();
  else autoLock.resume();
});

onMounted(async () => {
  try {
    await store.init();
    if (store.isUnlocked) autoLock.start();
    // 资源管理器右键带文件启动：进入本页面后消费待处理项（此时 isUnlocked 已准确）
    if (store.pendingCli) applyPending();
  } catch (e: any) {
    // 状态查询失败不应让页面崩溃，给出可读提示
    ElMessage.error(e?.message || '保险箱状态加载失败');
  }
});

/** 已在页面上时，右键再次触发（App.vue 重写 pendingCli）→ 立即消费 */
watch(
  () => store.pendingCli,
  (v) => {
    if (v) applyPending();
  },
);
onUnmounted(() => {
  // 离开页面清理预览/导入解密临时文件与自动锁定监听（锁定态另有主进程清理）
  store.cleanupTemp();
  store.cleanupImportDecryptTemp();
  autoLock.stop();
});

function onUnlocked() {
  // 状态已由子组件写入 store，watch 会据此收起解锁门并（若解锁）启动自动锁定
  // 若右键任务需「先解锁再执行」，在此触发暂存的打开动作
  if (pendingAfterUnlock.value) {
    const fn = pendingAfterUnlock.value;
    pendingAfterUnlock.value = null;
    fn();
  }
}

/** 工具栏「导入加密」：清空右键预填，打开原生多选导入 */
function openImportDialog() {
  importInitialFiles.value = [];
  showImport.value = true;
}

/** 工具栏「导入解密」：清空右键预填，打开解密对话框 */
function openDecryptDialog() {
  decryptInitialFiles.value = [];
  showDecrypt.value = true;
}

/**
 * 消费右键待处理项：
 * - secure-delete：无需解锁，弹确认后调用主进程碎纸机；
 * - encrypt / decrypt：已解锁直接打开对应对话框并预填文件；未解锁先弹解锁门，解锁完成后自动打开。
 */
function applyPending() {
  const item = store.pendingCli;
  if (!item) return;
  store.clearPendingCli();
  if (item.action === 'secure-delete') {
    runSecureDelete(item.files);
    return;
  }
  const open = () => {
    if (item.action === 'encrypt') {
      importInitialFiles.value = item.files;
      showImport.value = true;
    } else if (item.action === 'decrypt') {
      decryptInitialFiles.value = item.files;
      showDecrypt.value = true;
    }
  };
  if (store.isUnlocked) open();
  else {
    pendingAfterUnlock.value = open;
    showUnlock.value = true; // 解锁门已隐藏时重新弹出
  }
}

/** 安全删除（碎纸机）：确认后调用主进程 file-vault:secure-delete，无需解锁 */
async function runSecureDelete(files: string[]) {
  try {
    await ElMessageBox.confirm(
      `确定彻底删除（安全擦除）选中的 ${files.length} 个文件？此操作不可恢复。`,
      '安全删除',
      { type: 'warning' },
    );
  } catch {
    return;
  }
  const res = await store.secureDeleteFiles(files);
  if (res.ok) ElMessage.success(`已安全删除 ${res.deleted} 个文件`);
  else ElMessage.error(res.error || '安全删除失败');
}

async function onImported() {
  await store.refresh();
}

function onPreviewClosed() {
  // 预览关闭即清理临时解密文件，避免磁盘残留明文
  store.cleanupTemp();
}

function onIdleChange() {
  // idleMinutes 为响应式 ref，useAutoLock 下次 start()/checkIdle() 会读取最新值
  ElMessage.success(`自动锁定已设为 ${idleMinutes.value} 分钟无操作`);
}

async function onAutoLock() {
  await store.lock();
  ElMessage.warning('保险箱已自动锁定（失焦/隐藏/空闲超时）');
}

async function lockNow() {
  autoLock.stop();
  await store.lock();
  ElMessage.success('已锁定（内存中的密钥已清空）');
}

function onPreview(file: VaultFileMeta) {
  previewFile.value = file;
  showPreview.value = true;
}

async function onExport(file: VaultFileMeta | null) {
  if (!file) return;
  // 原生文件夹选择器会让渲染窗口失焦，挂起自动锁定避免误触发（从卡片或预览导出都覆盖）
  suspendAutoLockForNative();
  try {
    const dir = await fileVaultApi.pickExportDir();
    if (!dir) return;
    const ok = await store.exportFile(file.id, dir);
    if (ok) {
      // 保留用户选择的导出目录，仅把成功提示改为可点击定位的 fileNotify
      fileNotify({ title: '已导出解密文件', filePath: dir });
    } else ElMessage.error(store.error || '导出失败');
  } finally {
    resumeAutoLockForNative();
  }
}

async function onDelete(file: VaultFileMeta) {
  try {
    await ElMessageBox.confirm(`确定删除「${file.name}」？密文将永久移除，不可恢复。`, '删除确认', {
      type: 'warning',
    });
  } catch {
    return;
  }
  const ok = await store.deleteFile(file.id);
  if (ok) ElMessage.success('已删除');
  else ElMessage.error(store.error || '删除失败');
}
</script>

<style scoped lang="scss">
.fv {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 20px;
  box-sizing: border-box;
  overflow: hidden;
}

/* 工具栏 */
.fv-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 14px;
  flex-wrap: wrap;
}
.fv-toolbar__title {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
}
.fv-count {
  font-size: 12px;
  font-weight: 400;
  color: var(--text-muted);
  padding: 2px 8px;
  background: var(--bg-hover, rgba(0, 0, 0, 0.05));
  border-radius: 999px;
}
.fv-toolbar__actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

/* 自动锁定选择器 */
.fv-autolock {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 0 10px;
  height: 36px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-btn, 8px);
  background: var(--bg-card);
  color: var(--text-secondary);
}
.fv-autolock__label {
  font-size: 13px;
}
.fv-autolock__select {
  border: none;
  outline: none;
  background: transparent;
  color: var(--text-primary);
  font-size: 13px;
  cursor: pointer;
  padding: 2px 0;
}

.fv-gridwrap {
  flex: 1;
  min-height: 0;
}

/* 空态 */
.fv-empty {
  margin: auto;
  text-align: center;
  color: var(--text-muted);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  p {
    margin: 0;
    font-size: 13px;
  }
}

/* 按钮 */
.fv-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px;
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
  }
  &--primary {
    color: #fff;
    background: var(--color-primary);
    border-color: var(--color-primary);
    &:hover {
      color: #fff;
      filter: brightness(1.05);
    }
  }
}
</style>

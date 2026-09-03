<template>
  <!-- 未解锁时弹出解锁门（创建/解锁），解锁成功后继续执行右键操作 -->
  <UnlockView v-if="showUnlock" v-model="showUnlock" :mode="unlockMode" @done="onUnlocked" />

  <!-- 已解锁时直接弹出对应对话框，不跳转到保险箱页面 -->
  <ImportDialog v-model="showImport" :initial-files="importFiles" @done="onImported" />
  <DecryptImportDialog v-model="showDecrypt" :initial-files="decryptFiles" />
</template>

<script setup lang="ts">
/**
 * 资源管理器右键菜单全局处理器（常驻 App.vue，不依赖保险箱路由页面）。
 * - secure-delete：无需解锁，直接弹确认后执行（不跳转、不弹解锁门）；
 * - encrypt / decrypt：已解锁则直接弹对应对话框并预填文件；未解锁（或首次创建）
 *   先弹解锁门，解锁成功后自动继续原操作。
 * 这样右键任意文件即可直接执行保险箱功能，不再强制跳转到保险箱列表页。
 */
import { ref, watch, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import useFileVault, { type CliPendingItem } from '../store/useFileVault';
import UnlockView from './UnlockView.vue';
import ImportDialog from './ImportDialog.vue';
import DecryptImportDialog from './DecryptImportDialog.vue';

const store = useFileVault();
const showUnlock = ref(false);
const unlockMode = ref<'create' | 'unlock'>('unlock');
const showImport = ref(false);
const showDecrypt = ref(false);
const importFiles = ref<string[]>([]);
const decryptFiles = ref<string[]>([]);
/** 先解锁再执行的动作（解锁成功后自动调用） */
let pendingAfterUnlock: (() => void) | null = null;

onMounted(async () => {
  // 同步保险箱最新状态（未初始化时 isUnlocked=false，等价于未解锁，安全）
  try {
    await store.refreshStatus();
  } catch {
    /* 状态查询失败不影响右键入口，下次操作会重试 */
  }
});

/** 消费右键待处理项（来自 App.vue 写入的 store.pendingCli） */
watch(
  () => store.pendingCli,
  (item) => {
    if (item) handle(item);
  },
);

function handle(item: CliPendingItem) {
  store.clearPendingCli();
  if (item.action === 'secure-delete') {
    runSecureDelete(item.files);
    return;
  }
  const open = () => {
    if (item.action === 'encrypt') {
      importFiles.value = item.files;
      showImport.value = true;
    } else if (item.action === 'decrypt') {
      decryptFiles.value = item.files;
      showDecrypt.value = true;
    }
  };
  if (store.isUnlocked) {
    open();
  } else {
    // 未解锁（或从未创建）：先弹解锁门，解锁成功后继续原操作
    pendingAfterUnlock = open;
    unlockMode.value = store.hasVault ? 'unlock' : 'create';
    showUnlock.value = true;
  }
}

/** 解锁/创建成功后：执行原先挂起的操作 */
function onUnlocked() {
  const fn = pendingAfterUnlock;
  pendingAfterUnlock = null;
  if (fn) fn();
}

async function onImported() {
  await store.refresh();
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
</script>

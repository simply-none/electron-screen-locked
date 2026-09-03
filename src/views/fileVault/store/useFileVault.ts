/**
 * 私密文件保险箱 store（Pinia）
 * ------------------------------------------------------------------
 * 状态：是否已建库、是否解锁、文件元数据列表、加载/错误态。
 * 所有密钥相关操作都委托主进程（fileVaultApi），渲染端不持有明文与密钥。
 */
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { fileVaultApi } from '../api/fileVaultApi';
import type { VaultFileMeta } from '../types';

/** 资源管理器右键启动参数（与 shellMenu.ts 的 CliItem 对齐；渲染端本地定义避免引入主进程模块/electron） */
export interface CliPendingItem {
  action: 'encrypt' | 'decrypt' | 'secure-delete';
  files: string[];
}

export default defineStore('file-vault', () => {
  const hasVault = ref(false);
  const isUnlocked = ref(false);
  const files = ref<VaultFileMeta[]>([]);
  const loading = ref(false);
  const error = ref('');
  /** 右键菜单待处理项（App.vue 接收 app:cli-open 后写入，index.vue 挂载/监听后消费） */
  const pendingCli = ref<CliPendingItem | null>(null);

  /** 拉取状态（不拉列表） */
  async function refreshStatus(): Promise<void> {
    const res = await fileVaultApi.status();
    hasVault.value = !!res.hasVault;
    isUnlocked.value = !!res.isUnlocked;
  }

  /** 拉取状态 + 文件列表（解锁后才有列表） */
  async function refresh(): Promise<void> {
    await refreshStatus();
    if (isUnlocked.value) {
      const res = await fileVaultApi.list();
      files.value = res.files || [];
    } else {
      files.value = [];
    }
  }

  /** 初始化（进入页面时调用） */
  async function init(): Promise<void> {
    await refresh();
  }

  /** 首次设置口令 */
  async function setPassword(password: string): Promise<boolean> {
    loading.value = true;
    error.value = '';
    try {
      const res = await fileVaultApi.setPassword(password);
      if (!res.ok) {
        error.value = res.error || '设置失败';
        return false;
      }
      await refresh();
      return true;
    } catch (e: any) {
      error.value = e?.message || '设置失败';
      return false;
    } finally {
      loading.value = false;
    }
  }

  /** 解锁 */
  async function unlock(password: string): Promise<boolean> {
    loading.value = true;
    error.value = '';
    try {
      const res = await fileVaultApi.unlock(password);
      if (!res.ok) {
        error.value = res.error || '解锁失败';
        return false;
      }
      await refresh();
      return true;
    } catch (e: any) {
      error.value = e?.message || '解锁失败';
      return false;
    } finally {
      loading.value = false;
    }
  }

  /** 锁定：清空主进程内存密钥与本地状态 */
  async function lock(): Promise<void> {
    await fileVaultApi.lock();
    await refresh();
  }

  /** 批量加密导入（原生多选 → 逐文件导入）；deleteSource=true 时安全删除原文件 */
  async function importFiles(paths: string[], deleteSource = true): Promise<{ ok: number; fail: number; deleted: number }> {
    let ok = 0;
    let fail = 0;
    let deleted = 0;
    for (const p of paths) {
      const res = await fileVaultApi.importFile(p, undefined, deleteSource);
      if (res.ok) {
        ok++;
        if (res.sourceDeleted) deleted++;
      } else fail++;
    }
    if (ok) await refresh();
    return { ok, fail, deleted };
  }

  /** 解密导出到目标目录 */
  async function exportFile(id: string, destDir: string): Promise<boolean> {
    const res = await fileVaultApi.exportFile(id, destDir);
    if (!res.ok) {
      error.value = res.error || '导出失败';
      return false;
    }
    return true;
  }

  /** 删除文件 */
  async function deleteFile(id: string): Promise<boolean> {
    const res = await fileVaultApi.deleteFile(id);
    if (!res.ok) {
      error.value = res.error || '删除失败';
      return false;
    }
    await refresh();
    return true;
  }

  /** 解密到临时目录（预览用） */
  async function decryptTemp(id: string) {
    return await fileVaultApi.decryptTemp(id);
  }

  /** 清理预览临时目录 */
  async function cleanupTemp() {
    await fileVaultApi.cleanupTemp();
  }

  /** 导入解密：逐文件解密 .jlv 到临时目录（要求已解锁）；返回每个文件的结果 */
  async function decryptImportFiles(paths: string[]): Promise<{
    ok: number;
    fail: number;
    items: { source: string; tempPath?: string; ext?: string; name?: string; error?: string }[];
  }> {
    let ok = 0;
    let fail = 0;
    const items: { source: string; tempPath?: string; ext?: string; name?: string; error?: string }[] = [];
    for (const p of paths) {
      const res = await fileVaultApi.importDecrypt(p);
      if (res.ok && res.tempPath) {
        ok++;
        // .jlv 内嵌了原始文件名则用之；旧格式回退到文件名的去扩展名（去 .jlv）
        const fallback = p.split(/[\\/]/).pop()?.replace(/\.jlv$/i, '') || '';
        items.push({ source: p, tempPath: res.tempPath, ext: res.ext, name: res.name || fallback });
      } else {
        fail++;
        items.push({ source: p, error: res.error || '解密失败' });
      }
    }
    return { ok, fail, items };
  }

  /** 导入解密（字节通道）：渲染端已读文件字节，主进程解密写临时文件；用于无法获取本地路径的环境 */
  async function decryptImportBytes(items: { name: string; buffer: ArrayBuffer }[]): Promise<{
    ok: number;
    fail: number;
    items: { source: string; tempPath?: string; ext?: string; name?: string; error?: string }[];
  }> {
    let ok = 0;
    let fail = 0;
    const out: { source: string; tempPath?: string; ext?: string; name?: string; error?: string }[] = [];
    for (const it of items) {
      const res = await fileVaultApi.importDecryptBytes(it.name, it.buffer);
      if (res.ok && res.tempPath) {
        ok++;
        out.push({ source: it.name, tempPath: res.tempPath, ext: res.ext, name: res.name || it.name });
      } else {
        fail++;
        out.push({ source: it.name, error: res.error || '解密失败' });
      }
    }
    return { ok, fail, items: out };
  }

  /** 把解密后的临时明文另存到目标目录 */
  async function savePlainFile(tempPath: string, destDir: string, name: string): Promise<boolean> {
    const res = await fileVaultApi.savePlain(tempPath, destDir, name);
    if (!res.ok) {
      error.value = res.error || '保存失败';
      return false;
    }
    return true;
  }

  /** 清理导入解密临时目录 */
  async function cleanupImportDecryptTemp() {
    await fileVaultApi.cleanupImportDecrypt();
  }

  /** 写入右键待处理项（App.vue 在 app:cli-open 时调用） */
  function setPendingCli(item: CliPendingItem) {
    pendingCli.value = item;
  }
  /** 清空右键待处理项（消费后调用，避免重复触发） */
  function clearPendingCli() {
    pendingCli.value = null;
  }

  /** 安全删除（碎纸机）：调用主进程 file-vault:secure-delete，无需解锁 */
  async function secureDeleteFiles(paths: string[]) {
    return await fileVaultApi.secureDelete(paths);
  }

  return {
    hasVault,
    isUnlocked,
    files,
    loading,
    error,
    pendingCli,
    refresh,
    refreshStatus,
    init,
    setPassword,
    unlock,
    lock,
    importFiles,
    exportFile,
    deleteFile,
    decryptTemp,
    cleanupTemp,
    decryptImportFiles,
    decryptImportBytes,
    savePlainFile,
    cleanupImportDecryptTemp,
    setPendingCli,
    clearPendingCli,
    secureDeleteFiles,
  };
});

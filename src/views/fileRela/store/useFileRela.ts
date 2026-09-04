/**
 * 文件关联 store（Pinia）
 * ------------------------------------------------------------------
 * 维护「右键菜单 → 批量重命名」等外部拉起场景下，从资源管理器传入的待处理文件列表。
 * 渲染端不持有文件系统能力，仅保存路径字符串，交由具体功能组件消费。
 */
import { defineStore } from 'pinia';
import { ref } from 'vue';

export const useFileRela = defineStore('file-rela', () => {
  /** 右键「批量重命名」外部打开：预载的文件路径列表（App.vue 写入，fileRename.vue 消费后清空） */
  const pendingRenameFiles = ref<string[]>([]);

  /** 写入外部传入的待重命名文件 */
  function setPendingRenameFiles(files: string[]): void {
    pendingRenameFiles.value = Array.isArray(files) ? files.filter(Boolean) : [];
  }
  /** 取走外部预载文件并清空（fileRename.vue 挂载时调用） */
  function consumePendingRenameFiles(): string[] {
    const f = pendingRenameFiles.value;
    pendingRenameFiles.value = [];
    return f;
  }

  return { pendingRenameFiles, setPendingRenameFiles, consumePendingRenameFiles };
});

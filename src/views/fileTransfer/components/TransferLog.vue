<!--
  传输记录（原子组件）：纯展示历史，不持有逻辑。
  props: history 文件互传历史数组（created_at 倒序）
-->
<template>
  <div class="transfer-log">
    <div v-if="!history.length" class="transfer-log__empty">暂无传输记录。</div>
    <div v-for="item in history" :key="item.key" class="transfer-log__item">
      <div class="transfer-log__icon" :class="`is-${item.direction}`">
        <LucideIcon :name="item.direction === 'send' ? 'Upload' : 'Download'" :size="16" />
      </div>
      <div class="transfer-log__meta">
        <div class="transfer-log__name">
          {{ item.file_name }}
          <span class="transfer-log__size">{{ formatSize(item.size) }}</span>
        </div>
        <div class="transfer-log__sub">
          {{ item.direction === "send" ? "发送到" : "来自" }}
          {{ item.peer_name || item.peer_ip }} · {{ item.created_at }}
        </div>
        <div v-if="item.status !== 'done' && item.error" class="transfer-log__error">
          {{ item.error }}
        </div>
        <div v-if="hasPath(item)" class="transfer-log__actions">
          <span class="transfer-log__link" @click="store.openFile(item.path)">打开文件</span>
          <span class="transfer-log__link" @click="store.openFolder(item.path)">打开所在文件夹</span>
        </div>
      </div>
      <div class="transfer-log__status" :class="`is-${item.status}`">
        {{ statusText(item.status) }}
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import LucideIcon from "@/components/LucideIcon.vue";
import { useFileTransfer } from "@/store/useFileTransfer";
import type { TransferHistoryItem } from "../types";

defineProps<{
  history: TransferHistoryItem[];
}>();

const store = useFileTransfer();

function statusText(status: TransferHistoryItem["status"]): string {
  if (status === "done") return "成功";
  if (status === "failed") return "失败";
  if (status === "canceled") return "已取消";
  return status;
}

/** 仅成功记录且路径非空时才提供打开操作 */
function hasPath(item: TransferHistoryItem): boolean {
  return item.status === "done" && !!item.path;
}

function formatSize(bytes: number): string {
  if (!bytes || bytes <= 0) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let v = bytes;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v.toFixed(1)} ${units[u]}`;
}
</script>

<style scoped lang="scss">
.transfer-log {
  display: flex;
  flex-direction: column;
  gap: 8px;

  &__empty {
    padding: 16px 0;
    text-align: center;
    font-size: 12px;
    opacity: 0.6;
  }

  &__item {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 10px;
    border-radius: 10px;
    background: color-mix(in srgb, currentColor 4%, transparent);
  }

  &__icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: 30px;
    border-radius: 8px;
    flex-shrink: 0;

    &.is-send {
      background: color-mix(in srgb, var(--el-color-primary) 14%, transparent);
      color: var(--el-color-primary);
    }

    &.is-receive {
      background: color-mix(in srgb, #22c55e 14%, transparent);
      color: #22c55e;
    }
  }

  &__meta {
    flex: 1;
    min-width: 0;
  }

  &__name {
    font-size: 13px;
    font-weight: 600;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  &__size {
    font-weight: 400;
    font-size: 11px;
    opacity: 0.55;
  }

  &__sub {
    margin-top: 2px;
    font-size: 11px;
    opacity: 0.55;
  }

  &__error {
    margin-top: 2px;
    font-size: 11px;
    color: #ef4444;
    opacity: 0.85;
    word-break: break-all;
  }

  &__actions {
    margin-top: 4px;
    display: flex;
    gap: 12px;
  }

  &__link {
    font-size: 11px;
    color: var(--el-color-primary);
    cursor: pointer;
    user-select: none;

    &:hover {
      text-decoration: underline;
    }
  }

  &__status {
    font-size: 12px;
    font-weight: 600;
    flex-shrink: 0;

    &.is-done {
      color: #22c55e;
    }

    &.is-failed {
      color: #ef4444;
    }

    &.is-canceled {
      color: var(--text-muted);
    }
  }
}
</style>

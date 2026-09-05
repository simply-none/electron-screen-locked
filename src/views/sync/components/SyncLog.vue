<!--
  同步日志（原子组件）：时间 + 消息 + 级别着色，纯展示。
-->
<template>
  <div class="sync-log">
    <div v-if="!logs.length" class="sync-log__empty">暂无同步记录</div>
    <div
      v-for="(item, i) in logs"
      :key="`${item.time}-${i}`"
      class="sync-log__item"
      :class="`is-${item.level}`"
    >
      <span class="sync-log__time">{{ item.time }}</span>
      <span class="sync-log__msg">{{ item.msg }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { SyncLogItem } from "../types";

defineProps<{
  logs: SyncLogItem[];
}>();
</script>

<style scoped lang="scss">
.sync-log {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 260px;
  overflow: auto;
  font-size: 12px;

  &__empty {
    padding: 8px 0;
    text-align: center;
    opacity: 0.5;
  }

  &__item {
    display: flex;
    gap: 10px;
    line-height: 1.6;
  }

  &__time {
    flex-shrink: 0;
    opacity: 0.5;
    font-family: monospace;
  }

  &__msg {
    word-break: break-all;
  }

  .is-ok &__msg {
    color: var(--el-color-success);
  }

  .is-error &__msg {
    color: var(--el-color-danger);
  }
}
</style>

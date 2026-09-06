<!--
  设备列表（原子组件）：纯展示 + 事件上抛，不持有传输逻辑。
  props: peers 设备数组 / busy 发送进行中 / activeIp 当前选中设备 ip
  emits: select 选中设备 / send 向该设备发送已选文件
-->
<template>
  <div class="device-list">
    <div v-if="!peers.length" class="device-list__empty">
      暂无设备：手机与 PC 连同一 Wi-Fi 后点「扫描」；模拟器请在下方手动填 IP。
    </div>
    <div
      v-for="peer in peers"
      :key="peer.ip"
      class="device-list__item"
      :class="{ 'is-active': peer.ip === activeIp }"
      @click="emit('select', peer.ip)"
    >
      <div class="device-list__icon">
        <LucideIcon name="Smartphone" :size="18" />
      </div>
      <div class="device-list__meta">
        <div class="device-list__name">{{ peer.name }}</div>
        <div class="device-list__ip">{{ peer.ip }} · {{ peer.platform }}</div>
      </div>
      <div class="device-list__actions" @click.stop>
        <el-button size="small" type="primary" :disabled="busy" @click="emit('send', peer.ip)">
          发送
        </el-button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import LucideIcon from "@/components/LucideIcon.vue";
import type { TransferPeerDevice } from "../types";

defineProps<{
  peers: TransferPeerDevice[];
  busy: boolean;
  activeIp: string;
}>();

const emit = defineEmits<{
  (e: "select", ip: string): void;
  (e: "send", ip: string): void;
}>();
</script>

<style scoped lang="scss">
.device-list {
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
    padding: 10px 12px;
    border-radius: 10px;
    cursor: pointer;
    transition: background 0.15s;

    &:hover {
      background: color-mix(in srgb, currentColor 6%, transparent);
    }

    &.is-active {
      background: color-mix(in srgb, currentColor 10%, transparent);
    }
  }

  &__icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 34px;
    height: 34px;
    border-radius: 10px;
    background: color-mix(in srgb, currentColor 8%, transparent);
  }

  &__meta {
    flex: 1;
    min-width: 0;
  }

  &__name {
    font-size: 13px;
    font-weight: 600;
  }

  &__ip {
    margin-top: 2px;
    font-size: 11px;
    opacity: 0.55;
  }

  &__actions {
    display: flex;
    gap: 6px;
  }
}
</style>

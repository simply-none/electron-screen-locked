<!--
  局域网同步主页面（薄壳）。
  结构：本机状态条 → 设备列表（扫描/手动添加）→ 表选择 → 同步日志。
  状态与动作全部在 useSync store；三个子组件为纯展示原子组件。
-->
<template>
  <div class="sync-page">
    <!-- 本机状态条 -->
    <div class="sync-page__status">
      <LucideIcon name="RadioIcon" :size="16" />
      <span v-if="store.status">
        本机：<b>{{ store.status.name }}</b>
        （{{ store.status.platform }}）· 数据端口 {{ store.status.dataPort }} · 发现端口
        {{ store.status.discoveryPort }}
      </span>
      <span v-else>同步服务加载中…</span>
    </div>

    <!-- 设备区 -->
    <section class="sync-page__card">
      <div class="sync-page__card-head">
        <span>设备</span>
        <el-button size="small" :loading="store.scanning" @click="store.scan()">
          <LucideIcon name="RadarIcon" :size="14" style="margin-right: 4px" />
          扫描
        </el-button>
      </div>
      <DeviceList
        :peers="store.peers"
        :busy="store.busy"
        :active-ip="activeIp"
        @select="activeIp = $event"
        @push="onPush"
        @pull="onPull"
      />
      <div class="sync-page__manual">
        <el-input
          v-model="manualIp"
          size="small"
          placeholder="手动填 IP[:端口]（模拟器：adb forward 后填 127.0.0.1:47125）"
          @keyup.enter="addManual"
        />
        <el-button size="small" @click="addManual">添加</el-button>
      </div>
    </section>

    <!-- 表选择 -->
    <section class="sync-page__card">
      <div class="sync-page__card-head"><span>选择要同步的表</span></div>
      <TableSelector :tables="SYNC_TABLES" v-model:selected-tables="store.selectedTables" />
    </section>

    <!-- 日志 -->
    <section class="sync-page__card">
      <div class="sync-page__card-head">
        <span>同步日志</span>
        <el-button size="small" text @click="store.logs.splice(0)">清空</el-button>
      </div>
      <SyncLog :logs="store.logs" />
    </section>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from "vue";

import { useSync, SYNC_TABLES } from "@/store/useSync";
import DeviceList from "./components/DeviceList.vue";
import TableSelector from "./components/TableSelector.vue";
import SyncLog from "./components/SyncLog.vue";

const store = useSync();
const activeIp = ref("");
const manualIp = ref("");

onMounted(() => {
  store.loadStatus();
});

function addManual() {
  const ip = manualIp.value.trim();
  if (!ip) return;
  store.addManual(ip);
  manualIp.value = "";
  if (!activeIp.value) activeIp.value = ip;
}

function onPush(ip: string) {
  activeIp.value = ip;
  store.push(ip);
}

function onPull(ip: string) {
  activeIp.value = ip;
  store.pull(ip);
}
</script>

<style scoped lang="scss">
.sync-page {
  display: flex;
  flex-direction: column;
  gap: 12px;
  height: 100%;
  padding: 14px 16px;
  overflow: auto;

  &__status {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 12px;
    border-radius: 10px;
    font-size: 12px;
    background: color-mix(in srgb, var(--el-color-primary) 10%, transparent);
  }

  &__card {
    padding: 12px 14px;
    border-radius: 12px;
    border: 1px solid color-mix(in srgb, currentColor 10%, transparent);
  }

  &__card-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 10px;
    font-size: 13px;
    font-weight: 600;
  }

  &__manual {
    display: flex;
    gap: 8px;
    margin-top: 10px;
  }
}
</style>

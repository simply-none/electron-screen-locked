<!--
  文件互传主页面（薄壳）。
  结构：本机状态条 → 设备列表（扫描/手动 IP）→ 发送面板（选文件 + 进度）→ 传输记录。
  状态与动作全部在 useFileTransfer store；子组件为纯展示原子组件。
-->
<template>
  <div class="file-transfer-page">
    <!-- 本机状态条 -->
    <div class="file-transfer-page__status">
      <LucideIcon name="ArrowLeftRight" :size="16" />
      <span v-if="store.status">
        本机：<b>{{ store.status.name }}</b>
        （{{ store.status.platform }}）· 接收目录：{{ store.status.receiveDir }}
      </span>
      <span v-else>文件互传服务加载中…</span>
    </div>

    <!-- 设备区 -->
    <section class="file-transfer-page__card">
      <div class="file-transfer-page__card-head">
        <span>设备</span>
        <el-button size="small" :loading="store.scanning" @click="store.scan()">
          <LucideIcon name="Radar" :size="14" style="margin-right: 4px" />
          扫描
        </el-button>
      </div>
      <DeviceList
        :peers="store.peers"
        :busy="store.sending"
        :active-ip="store.selectedDeviceIp"
        @select="store.selectedDeviceIp = $event"
        @send="onSend"
      />
      <div class="file-transfer-page__manual">
        <el-input
          v-model="manualIp"
          size="small"
          placeholder="手动填 IP（模拟器填 10.0.2.2）"
          @keyup.enter="addManual"
        />
        <el-button size="small" @click="addManual">添加</el-button>
      </div>
    </section>

    <!-- 最近设备（#11：持久化记忆，离线也显示） -->
    <section class="file-transfer-page__card">
      <div class="file-transfer-page__card-head"><span>最近设备</span></div>
      <div v-if="!store.recentPeers.length" class="file-transfer-page__hint">
        暂无记忆的设备。扫描并成功收发后会自动记住，离线也能直接发送。
      </div>
      <div v-for="r in store.recentPeers" :key="r.ip" class="file-transfer-page__recent">
        <div class="file-transfer-page__recent-meta">
          <div class="file-transfer-page__recent-name">
            {{ r.name }} <span class="file-transfer-page__recent-ip">{{ r.ip }}</span>
          </div>
          <div class="file-transfer-page__recent-sub">上次 {{ formatAgo(r.lastSeen) }}</div>
        </div>
        <div class="file-transfer-page__recent-actions">
          <el-button size="small" type="primary" :disabled="store.sending" @click="onSend(r.ip)">
            发送
          </el-button>
          <el-button size="small" text @click="store.forgetPeer(r.ip)">忘记</el-button>
        </div>
      </div>
    </section>

    <!-- 发送面板 -->
    <section class="file-transfer-page__card">
      <div class="file-transfer-page__card-head"><span>发送文件</span></div>
      <TransferPanel />
    </section>

    <!-- 传输记录 -->
    <section class="file-transfer-page__card">
      <div class="file-transfer-page__card-head">
        <span>传输记录</span>
        <el-button size="small" text @click="store.loadHistory()">刷新</el-button>
      </div>
      <TransferLog :history="store.history" />
    </section>

    <!-- #15 接收端询问模式：关自动接收时弹窗等用户答复 -->
    <el-dialog
      v-model="askVisible"
      title="是否接收文件？"
      width="360px"
      :close-on-click-modal="false"
      :show-close="false"
    >
      <p class="file-transfer-page__ask">
        来自 <b>{{ store.incomingAsk?.name }}</b> 的请求：共
        {{ store.incomingAsk?.count }} 个文件（{{ formatSize(store.incomingAsk?.total || 0) }}）。
      </p>
      <template #footer>
        <el-button @click="store.answerAsk(false)">拒绝</el-button>
        <el-button type="primary" @click="store.answerAsk(true)">接收</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";

import { useFileTransfer } from "@/store/useFileTransfer";
import DeviceList from "./components/DeviceList.vue";
import TransferPanel from "./components/TransferPanel.vue";
import TransferLog from "./components/TransferLog.vue";

const store = useFileTransfer();
const manualIp = ref("");

/** #15 询问弹窗可见性 */
const askVisible = computed(() => !!store.incomingAsk);

onMounted(() => {
  store.loadStatus();
  store.scan();
  store.loadRecent();
  store.loadHistory();
  store.bindEvents();
});

onUnmounted(() => {
  store.unbindEvents();
});

function addManual() {
  const ip = manualIp.value.trim();
  if (!ip) return;
  store.addManual(ip);
  manualIp.value = "";
  if (!store.selectedDeviceIp) store.selectedDeviceIp = ip;
}

function onSend(ip: string) {
  store.selectedDeviceIp = ip;
  store.send(ip);
}

/** 大小格式化（与 TransferPanel 同款） */
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

/** 相对时间：上次见面的友好描述 */
function formatAgo(ts: number): string {
  if (!ts) return "未知";
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  return `${d} 天前`;
}
</script>

<style scoped lang="scss">
.file-transfer-page {
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

  &__hint {
    font-size: 12px;
    opacity: 0.55;
  }

  &__recent {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 8px 0;

    &-meta {
      min-width: 0;
    }

    &-name {
      font-size: 13px;
      font-weight: 600;
    }

    &-ip {
      font-weight: 400;
      font-size: 11px;
      opacity: 0.55;
      margin-left: 6px;
    }

    &-sub {
      margin-top: 2px;
      font-size: 11px;
      opacity: 0.55;
    }

    &-actions {
      display: flex;
      gap: 6px;
      flex-shrink: 0;
    }
  }

  &__ask {
    margin: 0;
    font-size: 13px;
    line-height: 1.6;
  }
}
</style>

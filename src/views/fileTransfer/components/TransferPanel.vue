<!--
  发送面板（原子组件）：选文件 / 选文件夹（两个独立按钮，规避 Windows 单对话框无法同时选文件+文件夹的限制）+ 选择结果勾选列表（多次累加、默认全选）→ 逐文件进度 → 批次总进度 → 自动接收开关 + 打开接收目录。
  状态与动作全部经 useFileTransfer store（发送目标取自 store.selectedDeviceIp）。
  注意：entries 是「文件/文件夹」混合的选择项，勾选后发送时由主进程递归拍平；files 是发送中由进度事件重建的拍平文件列表，仅用于进度条展示。
-->
<template>
  <div class="transfer-panel">
    <div class="transfer-panel__head">
      <el-button size="small" :disabled="store.sending" @click="store.pickFiles()">
        <LucideIcon name="FileText" :size="14" style="margin-right: 4px" />
        选择文件
      </el-button>
      <el-button size="small" :disabled="store.sending" @click="store.pickFolders()">
        <LucideIcon name="FolderOpen" :size="14" style="margin-right: 4px" />
        选择文件夹
      </el-button>
      <el-button
        size="small"
        text
        :disabled="!store.entries.length || store.sending"
        @click="store.clearEntries()"
      >
        清空
      </el-button>
    </div>

    <!-- 发送中：逐文件进度（files 由进度事件重建的拍平列表） -->
    <template v-if="store.sending">
      <ul v-if="store.files.length" class="transfer-panel__files">
        <li v-for="(f, i) in store.files" :key="f.path" class="transfer-panel__file">
          <div class="transfer-panel__file-meta">
            <span class="transfer-panel__file-name">{{ f.name }}</span>
            <span class="transfer-panel__file-size">{{ formatSize(f.size) }}</span>
          </div>
          <el-progress
            v-if="progressOf(i)"
            :percentage="percentOf(i)"
            :status="progressStatus(i)"
            :stroke-width="6"
          />
        </li>
      </ul>
      <div v-if="store.batchTotalBytes" class="transfer-panel__batch">
        <el-progress :percentage="store.batchPercent" :stroke-width="8" />
        <div class="transfer-panel__batch-meta">
          <span>{{ formatSize(store.batchSentBytes) }} / {{ formatSize(store.batchTotalBytes) }}</span>
          <span>{{ formatRate(store.batchRate) }}</span>
          <span v-if="store.batchEta">剩余 {{ formatEta(store.batchEta) }}</span>
        </div>
      </div>
    </template>

    <!-- 空闲：选择结果勾选列表（文件夹作为单独一行；多次选择累加；默认全选） -->
    <template v-else>
      <div v-if="!store.entries.length" class="transfer-panel__empty">
        还没选内容。点「选择文件」或「选择文件夹」可多次添加，文件与文件夹都支持，默认全部传送。
      </div>
      <div v-else class="transfer-panel__select">
        <div class="transfer-panel__select-head">
          <el-checkbox
            :model-value="store.allChecked"
            :indeterminate="store.someChecked"
            @change="(v: string | number | boolean) => store.toggleAll(!!v)"
          >
            全选
          </el-checkbox>
          <span class="transfer-panel__select-summary">
            已选 {{ store.entries.length }} 项 · 共 {{ store.totalFiles }} 个文件 ·
            {{ formatSize(store.totalBytes) }}
          </span>
        </div>
        <ul class="transfer-panel__entries">
          <li v-for="e in store.entries" :key="e.path" class="transfer-panel__entry">
            <el-checkbox
              :model-value="e.checked"
              @change="(v: string | number | boolean) => store.toggleEntry(e.path)"
            />
            <LucideIcon
              :name="e.isDir ? 'Folder' : 'FileText'"
              :size="15"
              class="transfer-panel__entry-icon"
            />
            <span class="transfer-panel__entry-name" :title="e.path">{{ e.name }}</span>
            <span class="transfer-panel__entry-meta">
              {{ e.isDir ? `${e.fileCount} 个文件 · ` : "" }}{{ formatSize(e.size) }}
            </span>
            <el-button
              size="small"
              text
              class="transfer-panel__entry-remove"
              @click="store.removeEntry(e.path)"
            >
              <LucideIcon name="X" :size="14" />
            </el-button>
          </li>
        </ul>
      </div>
    </template>

    <div class="transfer-panel__settings">
      <span class="transfer-panel__auto-label">自动接收</span>
      <el-switch
        :model-value="store.autoAccept"
        size="small"
        @change="(v: string | number | boolean) => store.setAutoAccept(!!v)"
      />
      <span class="transfer-panel__auto-label">重名覆盖</span>
      <el-switch
        :model-value="store.renameStrategy === 'overwrite'"
        size="small"
        @change="(v: string | number | boolean) => store.setRename(!!v ? 'overwrite' : 'rename')"
      />
      <span class="transfer-panel__auto-label">加密</span>
      <el-switch
        :model-value="store.enc"
        size="small"
        @change="(v: string | number | boolean) => store.setEnc(!!v)"
      />
    </div>

    <div class="transfer-panel__actions">
      <template v-if="store.sending">
        <el-button type="danger" plain @click="onCancel">取消发送</el-button>
        <span class="transfer-panel__sending">发送中…</span>
      </template>
      <el-button v-else type="primary" :disabled="!canSend" @click="onSend">
        发送到选中设备
      </el-button>
      <el-button size="small" text @click="store.openReceived()">打开接收目录</el-button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import LucideIcon from "@/components/LucideIcon.vue";
import { useFileTransfer } from "@/store/useFileTransfer";
import type { TransferProgress } from "../types";

const store = useFileTransfer();

const canSend = computed(
  () => !!store.selectedDeviceIp && store.checkedCount > 0 && !store.sending,
);

function progressOf(i: number): TransferProgress | undefined {
  if (!store.currentTid) return undefined;
  return store.progress[`${store.currentTid}|${i + 1}`];
}

function percentOf(i: number): number {
  const p = progressOf(i);
  if (!p || !p.total) return 0;
  return Math.min(100, Math.round((p.sent / p.total) * 100));
}

function progressStatus(i: number): "" | "success" | "exception" | "warning" {
  const p = progressOf(i);
  if (!p) return "";
  if (p.phase === "failed") return "exception";
  if (p.phase === "canceled") return "warning";
  if (p.phase === "done") return "success";
  return "";
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

/** 速率：字节/秒 → 带单位 */
function formatRate(bytesPerSec: number): string {
  if (!bytesPerSec || bytesPerSec <= 0) return "—";
  return `${formatSize(bytesPerSec)}/s`;
}

/** 剩余秒数 → 人类可读 */
function formatEta(sec: number): string {
  if (!sec || sec <= 0) return "—";
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return `${m}m${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}

function onSend() {
  if (canSend.value) store.send(store.selectedDeviceIp);
}

/** 取消：tid 由 progress 事件写入 currentTid，主进程中止流式上传并记 canceled */
function onCancel() {
  store.cancel();
}
</script>

<style scoped lang="scss">
.transfer-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;

  &__head {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  &__spacer {
    flex: 1;
  }

  &__settings {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px 10px;
  }

  &__auto-label {
    font-size: 12px;
    opacity: 0.7;
  }

  &__empty {
    padding: 12px 0;
    text-align: center;
    font-size: 12px;
    opacity: 0.55;
  }

  // 选择结果勾选列表
  &__select {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  &__select-head {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  &__select-summary {
    font-size: 11px;
    opacity: 0.6;
  }

  &__entries {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-height: 240px;
    overflow: auto;
  }

  &__entry {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 6px;
    border-radius: 8px;

    &:hover {
      background: color-mix(in srgb, currentColor 6%, transparent);
    }

    &-icon {
      flex-shrink: 0;
      opacity: 0.7;
    }

    &-name {
      flex: 1;
      min-width: 0;
      font-size: 12px;
      font-weight: 500;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    &-meta {
      flex-shrink: 0;
      font-size: 11px;
      opacity: 0.55;
    }

    &-remove {
      flex-shrink: 0;
    }
  }

  &__files {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
    max-height: 220px;
    overflow: auto;
  }

  &__file {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  &__file-meta {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 12px;
  }

  &__file-name {
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 70%;
  }

  &__file-size {
    opacity: 0.55;
    flex-shrink: 0;
  }

  &__actions {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  &__sending {
    font-size: 12px;
    opacity: 0.6;
  }

  &__batch {
    display: flex;
    flex-direction: column;
    gap: 4px;

    &-meta {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      font-size: 11px;
      opacity: 0.6;
    }
  }
}
</style>

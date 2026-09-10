<template>
  <el-dialog
    v-model="visible"
    title="传书"
    width="680px"
    :close-on-click-modal="false"
    append-to-body
  >
    <div class="transfer-dialog">
      <!-- 设备：扫描 / 手填 IP -->
      <div class="section">
        <div class="section-title">设备</div>
        <div class="peer-bar">
          <el-button size="small" :loading="scanning" @click="onScan">
            <LucideIcon name="RefreshCw" :size="14" />
            {{ scanning ? '扫描中…' : '扫描' }}
          </el-button>
          <el-input
            v-model="manualIp"
            size="small"
            placeholder="设备 IP（可手填，如 192.168.1.20）"
            style="width: 220px"
          />
          <el-button size="small" :disabled="!manualIp.trim()" @click="onAddManual">
            添加
          </el-button>
          <span class="hint">手机与电脑需在同一 WiFi</span>
        </div>
        <div v-if="peers.length === 0" class="empty">未发现设备，可扫描或手填 IP</div>
        <el-radio-group v-else v-model="peerIp" class="peer-list">
          <el-radio v-for="p in peers" :key="p.id || p.ip" :value="p.ip">
            {{ p.name }}（{{ p.ip }}）
          </el-radio>
        </el-radio-group>
      </div>

      <!-- 方向 -->
      <div class="section">
        <div class="section-title">方向</div>
        <el-radio-group v-model="direction" :disabled="!peerIp">
          <el-radio-button :value="0">从这台导入</el-radio-button>
          <el-radio-button :value="1">传到这台</el-radio-button>
        </el-radio-group>
      </div>

      <!-- 书目（多选） -->
      <div class="section">
        <div class="section-title">
          书目
          <span class="hint">（勾选多本后可一键传输）</span>
        </div>
        <el-table
          ref="tableRef"
          :data="rows"
          :row-key="rowKey"
          height="260"
          size="small"
          @selection-change="onSelectionChange"
        >
          <el-table-column type="selection" width="46" />
          <el-table-column prop="title" label="书名" min-width="220" show-overflow-tooltip />
          <el-table-column prop="format" label="格式" width="90">
            <template #default="{ row }">
              {{ (row.format || '').toUpperCase() }}
            </template>
          </el-table-column>
          <el-table-column label="大小" width="100">
            <template #default="{ row }">
              {{ row.size ? `${(row.size / 1024 / 1024).toFixed(1)} MB` : '-' }}
            </template>
          </el-table-column>
        </el-table>
        <div v-if="rows.length === 0" class="empty">
          {{ peerIp ? (direction === 0 ? '对端暂无可传输的书' : '本机暂无可传输的书') : '请先选择设备' }}
        </div>
      </div>
    </div>

    <template #footer>
      <div class="footer">
        <span class="hint">已选 {{ selected.length }} 本</span>
        <div class="footer-actions">
          <el-button size="small" @click="visible = false">关闭</el-button>
          <el-button
            type="primary"
            size="small"
            :loading="transferring"
            :disabled="!peerIp || selected.length === 0"
            @click="onTransfer"
          >
            {{ transferring ? '传输中…' : `传输选中（${selected.length}）` }}
          </el-button>
        </div>
      </div>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';

import LucideIcon from '@/components/LucideIcon.vue';

import {
  ebookTransferApi,
  type LocalEbookPick,
  type RemoteEbook,
  type TransferPeer,
} from '../api/ebookTransferApi';

/** 本机书架条目（父组件传入，字段与 ebookStore.bookshelf 一致） */
interface LocalBook {
  path: string;
  name?: string;
  title?: string;
  format?: string;
}

/** 表格行：把对端书与本地书归一成同一结构，便于多选 */
interface Row {
  key: string;
  title: string;
  format: string;
  size?: number;
  remote?: RemoteEbook;
  local?: LocalEbookPick;
}

const props = defineProps<{
  /** 弹窗可见性（v-model） */
  modelValue: boolean;
  /** 本机书架（用于「传到这台」） */
  books: LocalBook[];
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', val: boolean): void;
  /** 传输完成（无论成败均触发，父组件据此刷新书架） */
  (e: 'done'): void;
}>();

const visible = computed({
  get: () => props.modelValue,
  set: (v: boolean) => emit('update:modelValue', v),
});

const tableRef = ref<{ clearSelection: () => void } | null>(null);
const peers = ref<TransferPeer[]>([]);
const peerIp = ref('');
const direction = ref<0 | 1>(0); // 0=从对端导入（拉），1=传到对端（推）
const remoteBooks = ref<RemoteEbook[]>([]);
const selected = ref<Row[]>([]);
const scanning = ref(false);
const loading = ref(false);
const transferring = ref(false);
const manualIp = ref('');

/** 当前方向的书目行 */
const rows = computed<Row[]>(() => {
  if (direction.value === 0) {
    return remoteBooks.value.map((b) => ({
      key: b.filePath,
      title: b.title || b.name || '未命名',
      format: b.format,
      size: b.size,
      remote: b,
    }));
  }
  return props.books
    .filter((b) => b.format === 'epub' || b.format === 'txt')
    .map((b) => ({
      key: b.path,
      title: b.title || b.name || '未命名',
      format: b.format ?? '',
      local: { filePath: b.path, name: b.name, title: b.title, format: b.format },
    }));
});

function rowKey(row: Row): string {
  return row.key;
}

/** 扫描局域网对端 */
async function onScan() {
  scanning.value = true;
  try {
    const res = await ebookTransferApi.scan();
    peers.value = res.data ?? [];
    if (peers.value.length === 0) ElMessage.info('未发现设备，可手填 IP');
  } catch (e) {
    ElMessage.error(`扫描失败：${String(e)}`);
  } finally {
    scanning.value = false;
  }
}

/** 手填 IP 加入设备列表 */
function onAddManual() {
  const ip = manualIp.value.trim();
  if (!ip) return;
  if (!peers.value.some((p) => p.ip === ip)) {
    peers.value = [...peers.value, { ip, name: `手动设备 ${ip}`, id: ip, platform: 'unknown' }];
  }
  peerIp.value = ip;
  manualIp.value = '';
}

/** 拉取对端书目 */
async function loadRemote() {
  if (!peerIp.value) return;
  loading.value = true;
  try {
    const res = await ebookTransferApi.listRemote(peerIp.value);
    remoteBooks.value = res.data ?? [];
  } catch (e) {
    remoteBooks.value = [];
    ElMessage.error(`获取对端书目失败：${String(e)}`);
  } finally {
    loading.value = false;
  }
}

function onSelectionChange(rows: Row[]) {
  selected.value = rows;
}

/** 一键批量传输 */
async function onTransfer() {
  if (!peerIp.value || selected.value.length === 0) return;
  transferring.value = true;
  try {
    const res =
      direction.value === 0
        ? await ebookTransferApi.download(
            peerIp.value,
            selected.value.map((r) => r.remote as RemoteEbook),
          )
        : await ebookTransferApi.upload(
            peerIp.value,
            selected.value.map((r) => r.local as LocalEbookPick),
          );
    const results = res.data ?? [];
    const ok = results.filter((r) => r.ok).length;
    const fail = results.length - ok;
    if (fail === 0) {
      ElMessage.success(`已传输 ${ok} 本`);
    } else {
      const firstErr = results.find((r) => !r.ok);
      ElMessage.warning(`成功 ${ok} 本，失败 ${fail} 本${firstErr ? `（如《${firstErr.title}》：${firstErr.error ?? '未知错误'}）` : ''}`);
    }
    tableRef.value?.clearSelection();
    selected.value = [];
    emit('done');
    if (direction.value === 0) await loadRemote();
  } catch (e) {
    ElMessage.error(`传输失败：${String(e)}`);
  } finally {
    transferring.value = false;
  }
}

// 切换方向 / 设备时清空勾选，避免跨端混选；切回「从这台导入」时补拉对端书目
// （否则「先选设备、方向还在『传到这台』、再切回导入」会出现空列表）
watch(direction, () => {
  selected.value = [];
  tableRef.value?.clearSelection();
  if (direction.value === 0 && peerIp.value) void loadRemote();
});
watch(peerIp, () => {
  selected.value = [];
  tableRef.value?.clearSelection();
  if (direction.value === 0) void loadRemote();
});

// 打开时自动扫描一次
watch(
  () => props.modelValue,
  (v) => {
    if (v && peers.value.length === 0) void onScan();
  },
);
</script>

<style scoped>
.transfer-dialog {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.section-title {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 8px;
}
.peer-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.peer-list {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  margin-top: 8px;
}
.hint {
  font-size: 12px;
  opacity: 0.65;
}
.empty {
  font-size: 12px;
  opacity: 0.65;
  padding: 10px 0;
}
.footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.footer-actions {
  display: flex;
  gap: 8px;
}
</style>

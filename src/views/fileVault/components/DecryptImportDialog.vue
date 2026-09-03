<template>
  <AppDialog v-model="visible" title="导入解密（.jlv）" :show-fullscreen="false">
    <div class="dec">
      <!-- 拖拽 / 选择区 -->
      <div
        class="dec-drop"
        :class="{ 'dec-drop--active': dragOver }"
        @dragover.prevent="dragOver = true"
        @dragenter.prevent="dragOver = true"
        @dragleave.prevent="dragOver = false"
        @drop.prevent="onDrop"
      >
        <LucideIcon name="FileBox" :size="28" />
        <p class="dec-drop__hint">将 .jlv 加密文件拖到此处，或</p>
        <button class="dec-pick" @click="choose">
          <LucideIcon name="FolderOpen" :size="16" />
          <span>选择 .jlv 文件…</span>
        </button>
      </div>

      <!-- 已选源文件 -->
      <div v-if="picked.length" class="dec-list">
        <div v-for="(p, i) in picked" :key="i" class="dec-item" :title="p.name">
          <LucideIcon name="FileBox" :size="14" />
          <span class="dec-item__name">{{ p.name }}</span>
        </div>
      </div>

      <!-- 解密后的结果 -->
      <div v-if="decrypted.length" class="dec-list">
        <div v-for="item in decrypted" :key="item.source" class="dec-result">
          <template v-if="item.error">
            <LucideIcon name="TriangleAlert" :size="14" />
            <span class="dec-result__err">{{ basename(item.source) }}：{{ item.error }}</span>
          </template>
          <template v-else>
            <LucideIcon name="Unlock" :size="14" />
            <input v-model="item.name" class="dec-result__name" placeholder="输出文件名" />
            <button class="dec-link" @click="togglePreview(item)">
              <LucideIcon :name="item.previewing ? 'EyeOff' : 'Eye'" :size="14" />
              {{ item.previewing ? '收起' : '预览' }}
            </button>
            <button class="dec-link dec-link--primary" @click="saveAs(item)">
              <LucideIcon name="Download" :size="14" /> 另存为
            </button>

            <!-- 内嵌预览 -->
            <div v-if="item.previewing && item.tempPath" class="dec-preview">
              <img v-if="isImage(item.ext)" :src="jlocal(item.tempPath)" class="dec-pv-img" alt="preview" />
              <iframe v-else-if="isPdf(item.ext)" :src="jlocal(item.tempPath)" class="dec-pv-frame" />
              <audio v-else-if="isAudio(item.ext)" :src="jlocal(item.tempPath)" controls class="dec-pv-audio" />
              <pre v-else-if="isText(item.ext) && item.textContent !== undefined" class="dec-pv-text">{{ item.textContent }}</pre>
              <div v-else class="dec-pv-none">
                <LucideIcon name="FileBox" :size="32" />
                <p>该类型暂不支持内嵌预览，请点击「另存为」查看。</p>
              </div>
            </div>
          </template>
        </div>
      </div>

      <p v-if="error" class="dec-error">{{ error }}</p>

      <div class="dec-footer">
        <button class="dec-btn" @click="visible = false">关闭</button>
        <button
          v-if="picked.length && !decrypted.length"
          class="dec-btn dec-btn--primary"
          :disabled="busy"
          @click="run"
        >
          {{ busy ? '解密中…' : `开始解密（${picked.length}）` }}
        </button>
      </div>
    </div>
  </AppDialog>
</template>

<script setup lang="ts">
/**
 * 导入解密对话框：拖拽 / 选择 .jlv → 已解锁时主进程用 dataKey 解密 → 预览 → 另存为明文。
 * 明文不过 IPC（主进程解密到临时目录，渲染端仅持临时路径）；关闭时清理临时目录。
 */
import { ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { fileNotify } from '@/utils/fileNotify';
import AppDialog from '@/components/AppDialog.vue';
import LucideIcon from '@/components/LucideIcon.vue';
import useFileVault from '../store/useFileVault';
import { fileVaultApi } from '../api/fileVaultApi';
import { suspendAutoLockForNative, resumeAutoLockForNative } from '@/composables/useAutoLock';

const visible = defineModel<boolean>({ default: false });
const store = useFileVault();
/** 右键菜单预填的 .jlv 路径（来自资源管理器「解密(.jlv)」）；为空时走拖拽/原生选择 */
const props = defineProps<{ initialFiles?: string[] }>();

interface DecryptedItem {
  source: string;
  tempPath?: string;
  ext?: string;
  error?: string;
  name: string;
  previewing: boolean;
  textContent?: string | null;
}

interface PickedItem {
  kind: 'path' | 'bytes';
  name: string; // 显示名（含 .jlv）
  path?: string; // kind==='path'：本地路径
  buffer?: ArrayBuffer; // kind==='bytes'：已读字节
}
const picked = ref<PickedItem[]>([]);
const decrypted = ref<DecryptedItem[]>([]);

/** 右键预填：把 initialFiles（本地 .jlv 路径）直接填入待解密列表；为空则清空 */
watch(
  () => props.initialFiles,
  (v) => {
    picked.value = v && v.length
      ? v.map((p) => ({ kind: 'path', name: basename(p), path: p }) as PickedItem)
      : [];
  },
  { immediate: true },
);
const dragOver = ref(false);
const busy = ref(false);
const error = ref('');

function basename(p: string): string {
  return p.split(/[\\/]/).pop() || p;
}
function jlocal(p: string): string {
  return `jlocal:///${p.replace(/\\/g, '/')}`;
}
function isImage(ext?: string): boolean {
  return ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'].includes((ext || '').toLowerCase());
}
function isPdf(ext?: string): boolean {
  return (ext || '').toLowerCase() === '.pdf';
}
function isAudio(ext?: string): boolean {
  return (ext || '').toLowerCase() === '.mp3';
}
function isText(ext?: string): boolean {
  return ['.txt', '.md', '.json', '.csv'].includes((ext || '').toLowerCase());
}

function isJlv(name: string): boolean {
  return (name || '').toLowerCase().endsWith('.jlv');
}

/**
 * 拖入事件：优先用本地路径（dev/部分环境可用），拿不到路径时回退到「读字节 → 主进程解密」通道，
 * 以彻底绕开打包后 file:// 页面拖拽时 File.path/name 为空的安全限制。
 */
async function onDrop(e: DragEvent) {
  dragOver.value = false;
  const dt = e.dataTransfer;
  if (!dt) return;
  const files = dt.files;
  const collected: PickedItem[] = [];
  const rejected: string[] = [];
  let anyFile = false;
  for (let i = 0; i < files.length; i++) {
    const f = files[i] as any;
    const fname: string = f?.name || '';
    if (fname) anyFile = true;
    if (!isJlv(fname)) continue; // 非 .jlv 直接跳过，稍后统一提示
    if (f?.path) {
      collected.push({ kind: 'path', name: fname, path: f.path as string });
    } else {
      // 拿不到 path：用字节通道（读 arrayBuffer，不依赖本地路径）
      try {
        const buf = await (f as File).arrayBuffer();
        collected.push({ kind: 'bytes', name: fname, buffer: buf });
      } catch {
        rejected.push(fname || '未知文件');
      }
    }
  }
  if (collected.length) picked.value = picked.value.concat(collected);
  if (rejected.length) ElMessage.warning(`以下文件无法读取，请改用「选择 .jlv 文件」按钮：${rejected.join('、')}`);
  else if (!collected.length && anyFile) ElMessage.warning('仅支持 .jlv 加密文件');
  else if (!collected.length && !anyFile) ElMessage.warning('无法读取拖入的文件路径，请点击「选择 .jlv 文件」按钮导入');
}

async function choose() {
  suspendAutoLockForNative();
  try {
    const paths = await fileVaultApi.pickImportDecrypt();
    if (paths && paths.length)
      picked.value = picked.value.concat(paths.map((p) => ({ kind: 'path', name: basename(p), path: p }) as PickedItem));
  } finally {
    resumeAutoLockForNative();
  }
}

function toDecrypted(it: { source: string; tempPath?: string; ext?: string; name?: string; error?: string }): DecryptedItem {
  const base = it.name || '';
  return {
    source: it.source,
    tempPath: it.tempPath,
    ext: it.ext,
    error: it.error,
    name: base ? base : it.ext ? `未命名${it.ext}` : '未命名',
    previewing: false,
  };
}

async function run() {
  if (!picked.value.length) return;
  busy.value = true;
  error.value = '';
  decrypted.value = [];
  try {
    let ok = 0;
    let fail = 0;
    const merged: DecryptedItem[] = [];
    const pathItems = picked.value.filter((p) => p.kind === 'path');
    const byteItems = picked.value.filter((p) => p.kind === 'bytes');
    if (pathItems.length) {
      const r1 = await store.decryptImportFiles(pathItems.map((p) => p.path!) as string[]);
      ok += r1.ok;
      fail += r1.fail;
      merged.push(...r1.items.map(toDecrypted));
    }
    if (byteItems.length) {
      const r2 = await store.decryptImportBytes(byteItems.map((p) => ({ name: p.name, buffer: p.buffer! })));
      ok += r2.ok;
      fail += r2.fail;
      merged.push(...r2.items.map(toDecrypted));
    }
    decrypted.value = merged;
    picked.value = [];
    if (fail) ElMessage.warning(`${fail} 个文件解密失败（可能不属于当前保险箱）`);
    if (ok) ElMessage.success(`已解密 ${ok} 个文件，可预览或另存为`);
  } catch (e: any) {
    error.value = e?.message || '解密失败';
  } finally {
    busy.value = false;
  }
}

async function togglePreview(item: DecryptedItem) {
  item.previewing = !item.previewing;
  if (item.previewing && isText(item.ext) && item.textContent === undefined && item.tempPath) {
    try {
      const resp = await fetch(jlocal(item.tempPath));
      item.textContent = await resp.text();
    } catch {
      item.textContent = null;
    }
  }
}

async function saveAs(item: DecryptedItem) {
  if (!item.tempPath) return;
  suspendAutoLockForNative();
  try {
    const dir = await fileVaultApi.pickExportDir();
    if (!dir) return;
    const ok = await store.savePlainFile(item.tempPath, dir, item.name || `未命名${item.ext || ''}`);
    if (ok) {
      // 保留用户选择的导出目录，仅把成功提示改为可点击定位的 fileNotify
      fileNotify({ title: '已另存为明文文件', filePath: dir });
    } else ElMessage.error(store.error || '保存失败');
  } finally {
    resumeAutoLockForNative();
  }
}

watch(visible, (v) => {
  if (!v) {
    // 关闭即清理临时明文，防磁盘残留
    picked.value = [];
    decrypted.value = [];
    dragOver.value = false;
    error.value = '';
    store.cleanupImportDecryptTemp();
  }
});
</script>

<style scoped lang="scss">
.dec {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 4px 2px;
}
.dec-drop {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 24px 12px;
  border: 1px dashed var(--border-subtle);
  border-radius: var(--radius-btn, 8px);
  background: var(--bg-base);
  color: var(--text-muted);
  transition: all 0.15s;
  &--active {
    border-color: var(--color-primary);
    color: var(--color-primary);
    background: var(--bg-hover, rgba(99, 102, 241, 0.06));
  }
}
.dec-drop__hint {
  margin: 0;
  font-size: 13px;
}
.dec-pick {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px;
  font-size: 13px;
  border: 1px solid var(--color-primary);
  border-radius: var(--radius-btn, 8px);
  background: var(--color-primary);
  color: #fff;
  cursor: pointer;
}
.dec-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 220px;
  overflow: auto;
}
.dec-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  font-size: 12px;
  color: var(--text-secondary);
  background: var(--bg-hover, rgba(0, 0, 0, 0.04));
  border-radius: 6px;
  white-space: nowrap;
  overflow: hidden;
}
.dec-item__name {
  overflow: hidden;
  text-overflow: ellipsis;
}
.dec-result {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 8px;
  font-size: 12px;
  color: var(--text-secondary);
  background: var(--bg-hover, rgba(0, 0, 0, 0.04));
  border-radius: 6px;
}
.dec-result__err {
  color: var(--color-error, #e11d48);
}
.dec-result__name {
  flex: 1;
  min-width: 120px;
  padding: 5px 8px;
  font-size: 12px;
  border: 1px solid var(--border-subtle);
  border-radius: 6px;
  background: var(--bg-card);
  color: var(--text-primary);
  outline: none;
  &:focus {
    border-color: var(--color-primary);
  }
}
.dec-link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 5px 10px;
  font-size: 12px;
  border: 1px solid var(--border-subtle);
  border-radius: 6px;
  background: var(--bg-card);
  color: var(--text-secondary);
  cursor: pointer;
  &:hover {
    border-color: var(--color-primary);
    color: var(--color-primary);
  }
  &--primary {
    color: #fff;
    background: var(--color-primary);
    border-color: var(--color-primary);
    &:hover {
      color: #fff;
      filter: brightness(1.05);
    }
  }
}
.dec-preview {
  flex-basis: 100%;
  margin-top: 4px;
  padding: 8px;
  border: 1px solid var(--border-subtle);
  border-radius: 6px;
  background: var(--bg-base);
  display: flex;
  justify-content: center;
}
.dec-pv-img {
  max-width: 100%;
  max-height: 40vh;
  object-fit: contain;
  border-radius: 6px;
}
.dec-pv-frame {
  width: 100%;
  height: 40vh;
  border: none;
  border-radius: 6px;
  background: #fff;
}
.dec-pv-audio {
  width: 100%;
}
.dec-pv-text {
  width: 100%;
  max-height: 40vh;
  margin: 0;
  padding: 10px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-primary);
  white-space: pre-wrap;
  word-break: break-all;
  overflow: auto;
}
.dec-pv-none {
  text-align: center;
  color: var(--text-muted);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  p {
    margin: 0;
    font-size: 12px;
  }
}
.dec-error {
  margin: 0;
  font-size: 12px;
  color: var(--color-error, #e11d48);
}
.dec-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.dec-btn {
  padding: 8px 16px;
  font-size: 13px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-btn, 8px);
  background: var(--bg-card);
  color: var(--text-secondary);
  cursor: pointer;
  &--primary {
    color: #fff;
    background: var(--color-primary);
    border-color: var(--color-primary);
    &:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
  }
}
</style>

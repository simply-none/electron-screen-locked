<template>
  <div class="file-card">
    <div class="card-header">
      <h3 class="card-title">
        <el-icon><LucideIcon name="MousePointerClick" /></el-icon>
        右键菜单管理
      </h3>
      <el-button size="small" @click="reregister" plain>重新注册</el-button>
    </div>
    <div class="card-body">
      <p class="tip">勾选后在文件右键菜单显示对应动作；「用渐离阅读」可设为默认打开程序（可撤销，不抢占系统默认）。</p>
      <div class="cmd-list">
        <div class="cmd-row" v-for="c in commands" :key="c.id">
          <span class="cmd-name">{{ c.name }}</span>
          <span class="cmd-exts">{{ c.exts.includes('*') ? '所有文件' : c.exts.join(' / ') }}</span>
          <el-switch v-model="enabledMap[c.id]" @change="onEnabledChange" />
        </div>
      </div>
      <template v-if="readerExts.length">
        <div class="sub-title">设为默认打开（用渐离阅读）</div>
        <div class="cmd-list">
          <div class="cmd-row" v-for="ext in readerExts" :key="ext">
            <span class="cmd-name">{{ ext }} 文件</span>
            <span class="cmd-exts">双击即用渐离打开</span>
            <el-switch :model-value="defaultOpenSet.has(ext)" @change="(v: any) => onDefaultChange(ext, !!v)" />
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted } from 'vue';
import LucideIcon from '@/components/LucideIcon.vue';
import { ElMessage } from 'element-plus';

interface CmdState {
  id: string;
  name: string;
  action: string;
  exts: string[];
  enabled: boolean;
}

const commands = ref<CmdState[]>([]);
const enabledMap = reactive<Record<string, boolean>>({});
const defaultOpenSet = ref<Set<string>>(new Set());
const readerExts = ref<string[]>([]);

async function loadState(): Promise<void> {
  try {
    const res = (await window.ipcRenderer.invoke('shell-menu:get-state')) as {
      commands: CmdState[];
      defaultOpen: string[];
    };
    commands.value = res.commands || [];
    for (const c of commands.value) enabledMap[c.id] = c.enabled;
    defaultOpenSet.value = new Set(res.defaultOpen || []);
    const reader = commands.value.find((c) => c.action === 'open-reader');
    readerExts.value = reader ? reader.exts.filter((e) => e !== '*') : [];
  } catch (e) {
    console.error('加载右键菜单状态失败', e);
  }
}

function onEnabledChange(): void {
  const ids = commands.value.filter((c) => enabledMap[c.id]).map((c) => c.id);
  window.ipcRenderer.send('shell-menu:set-enabled', ids);
  ElMessage.success('已更新右键菜单');
}

function onDefaultChange(ext: string, enabled: boolean): void {
  window.ipcRenderer.send('shell-menu:set-default-open', { ext, enabled });
  if (enabled) defaultOpenSet.value.add(ext);
  else defaultOpenSet.value.delete(ext);
  ElMessage.success(enabled ? `已将 ${ext} 设为默认打开` : `已取消 ${ext} 默认打开`);
}

function reregister(): void {
  window.ipcRenderer.send('shell-menu:reregister');
  ElMessage.success('已重新注册右键菜单');
}

onMounted(loadState);
</script>

<style scoped lang="scss">
.tip {
  margin: 0 0 12px;
  font-size: 12px;
  color: var(--text-muted);
}
.cmd-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  padding: 8px 12px;
}
.cmd-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 0;
}
.cmd-name {
  font-size: 14px;
  color: var(--text-primary);
  font-weight: 500;
}
.cmd-exts {
  margin-left: auto;
  font-size: 12px;
  color: var(--text-muted);
}
.sub-title {
  margin: 16px 0 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-secondary);
}
</style>

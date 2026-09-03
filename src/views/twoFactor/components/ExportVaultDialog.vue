<template>
  <AppDialog v-model="visible" title="导出 / 备份保险库" :show-fullscreen="false">
    <div class="export-vault">
      <div class="ev-warn">
        <LucideIcon name="ShieldAlert" :size="16" />
        <span>
          导出文件包含你全部 2FA 密钥（加密后）。请保存到<strong>安全位置</strong>，
          并牢记导出口令——遗忘将无法恢复。该文件即为你密钥的唯一副本。
        </span>
      </div>

      <button class="ev-file" @click="choose">
        <LucideIcon name="Save" :size="16" />
        <span>{{ filePath || '选择导出位置…' }}</span>
      </button>

      <label class="ev-check">
        <input v-model="useNewPass" type="checkbox" />
        <span>使用不同口令加密（不勾选则沿用当前保险库口令）</span>
      </label>
      <input
        v-if="useNewPass"
        v-model="pass"
        class="ev-input"
        type="password"
        placeholder="导出文件口令"
      />

      <p v-if="error" class="ev-error">{{ error }}</p>
      <button class="ev-submit" :disabled="!filePath || (useNewPass && !pass) || exporting" @click="doExport">
        {{ exporting ? '导出中…' : '导出' }}
      </button>
    </div>
  </AppDialog>
</template>

<script setup lang="ts">
/**
 * 导出 / 备份保险库弹窗：把当前内存保险库加密另存为用户指定文件。
 * 该文件即用户密钥的唯一副本（应用数据库不存密钥）。
 */
import { ref } from 'vue';
import { ElMessage } from 'element-plus';
import AppDialog from '@/components/AppDialog.vue';
import LucideIcon from '@/components/LucideIcon.vue';
import useTwoFactor from '@/store/useTwoFactor';
import { twoFactorApi } from '../api/twoFactorApi';
import { fileNotify } from '@/utils/fileNotify';

const store = useTwoFactor();
const visible = defineModel<boolean>({ default: false });

const filePath = ref('');
const useNewPass = ref(false);
const pass = ref('');
const error = ref('');
const exporting = ref(false);

async function choose() {
  const p = await twoFactorApi.pickSave('2fa-vault-backup');
  if (p) filePath.value = p;
}

async function doExport() {
  error.value = '';
  if (!filePath.value) return;
  exporting.value = true;
  const ok = await store.exportVault(filePath.value, useNewPass.value ? pass.value : undefined);
  exporting.value = false;
  if (ok) {
    // 保留用户选择的安全位置，仅把成功提示改为可点击定位的 fileNotify
    fileNotify({ title: '已导出保险库文件', filePath: filePath.value });
    visible.value = false;
  } else {
    error.value = store.error || '导出失败';
  }
}
</script>

<style scoped lang="scss">
.export-vault {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.ev-warn {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 10px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--color-warning, #d97706);
  background: color-mix(in srgb, var(--color-warning, #d97706) 10%, transparent);
  border-radius: var(--radius-btn, 8px);
}
.ev-file {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 10px;
  border: 1px dashed var(--border-subtle);
  border-radius: var(--radius-btn, 8px);
  background: var(--bg-base);
  color: var(--text-secondary);
  cursor: pointer;
  text-align: left;
  &:hover {
    border-color: var(--color-primary);
    color: var(--color-primary);
  }
}
.ev-check {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-secondary);
}
.ev-input {
  width: 100%;
  box-sizing: border-box;
  padding: 9px 10px;
  font-size: 13px;
  color: var(--text-primary);
  background: var(--bg-base);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-btn, 8px);
  outline: none;
  &:focus {
    border-color: var(--color-primary);
  }
}
.ev-error {
  margin: 0;
  font-size: 12px;
  color: var(--color-error, #e11d48);
}
.ev-submit {
  padding: 10px;
  font-size: 14px;
  font-weight: 600;
  color: #fff;
  background: var(--color-primary);
  border: none;
  border-radius: var(--radius-btn, 8px);
  cursor: pointer;
  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
}
</style>

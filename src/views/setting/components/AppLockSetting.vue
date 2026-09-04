<template>
  <div class="app-lock-setting">
    <!-- 应用锁开关行 -->
    <div class="lock-row">
      <div class="row-label">
        <div class="row-main">应用锁</div>
        <div class="row-desc">开启后可一键锁定应用，所有窗口隐藏，需输入密码解锁</div>
      </div>
      <el-switch
        :model-value="lockStore.hasPassword"
        :loading="switching"
        @change="handleSwitchLock"
      />
    </div>

    <!-- 已启用时的管理与触发方式配置 -->
    <template v-if="lockStore.hasPassword">
      <div class="lock-row">
        <div class="row-label">
          <div class="row-main">应用启动时自动锁定</div>
          <div class="row-desc">打开应用后需输入密码解锁（默认关闭）</div>
        </div>
        <el-switch :model-value="lockStore.onStartup" @change="(v: any) => lockStore.setOnStartup(!!v)" />
      </div>

      <div class="lock-row">
        <div class="row-label">
          <div class="row-main">最小化恢复时锁定</div>
          <div class="row-desc">窗口从最小化/隐藏恢复到前台时自动锁定（默认关闭）</div>
        </div>
        <el-switch :model-value="lockStore.onRestore" @change="(v: any) => lockStore.setOnRestore(!!v)" />
      </div>

      <!-- 2FA 门禁（两步验证）：解锁需 密码 + 动态码 双重验证 -->
      <div class="lock-row">
        <div class="row-label">
          <div class="row-main">两步验证（TOTP）</div>
          <div class="row-desc">
            开启后解锁需「密码 + 手机验证器动态码」双重验证，防止密码泄露后应用被解锁
          </div>
        </div>
        <div class="row-ops">
          <span v-if="twoFa.enabled" class="tfa-badge">恢复码剩 {{ twoFa.recoveryRemaining }} 条</span>
          <el-switch :model-value="twoFa.enabled" @change="handleSwitch2fa" />
        </div>
      </div>

      <div class="lock-actions">
        <el-button @click="openChangeDialog">
          <LucideIcon name="KeyRound" :size="14" />
          修改密码
        </el-button>
        <el-button v-if="twoFa.enabled" @click="openRegenerateWizard">
          <LucideIcon name="RefreshCw" :size="14" />
          重新生成恢复码
        </el-button>
        <el-button type="warning" plain @click="handleLockNow">
          <LucideIcon name="LockKeyhole" :size="14" />
          立即锁定
        </el-button>
      </div>
    </template>

    <!-- 老板键说明 -->
    <div class="lock-row">
      <div class="row-label">
        <div class="row-main">隐私模式（老板键）</div>
        <div class="row-desc">
          在「快捷键」页为「隐私模式（老板键）」绑定快捷键，可一键隐藏/恢复全部窗口；
          应用锁开启时恢复窗口保持锁定态
        </div>
      </div>
      <el-button size="small" @click="goShortcutPage">去配置</el-button>
    </div>

    <!-- 设置/修改密码弹窗 -->
    <el-dialog
      v-model="passwordDialogVisible"
      :title="isChangeMode ? '修改应用锁密码' : '设置应用锁密码'"
      width="360px"
      :close-on-click-modal="false"
      @closed="resetDialog"
    >
      <el-form label-position="top">
        <el-form-item v-if="isChangeMode" label="当前密码">
          <el-input v-model="form.current" type="password" show-password placeholder="请输入当前密码" />
        </el-form-item>
        <el-form-item label="新密码">
          <el-input v-model="form.next" type="password" show-password placeholder="请输入新密码（4 位以上）" />
        </el-form-item>
        <el-form-item label="确认新密码">
          <el-input
            v-model="form.confirm"
            type="password"
            show-password
            placeholder="请再次输入新密码"
            @keyup.enter="submitPassword"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="passwordDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitPassword">确定</el-button>
      </template>
    </el-dialog>

    <!-- 关闭应用锁验证弹窗 -->
    <el-dialog
      v-model="clearDialogVisible"
      title="关闭应用锁"
      width="360px"
      :close-on-click-modal="false"
      @closed="resetDialog"
    >
      <p class="clear-tip">关闭后锁定功能停用，已有密码将被清除。请输入当前密码确认：</p>
      <el-input
        v-model="form.current"
        type="password"
        show-password
        placeholder="请输入当前密码"
        @keyup.enter="submitClear"
      />
      <template #footer>
        <el-button @click="clearDialogVisible = false">取消</el-button>
        <el-button type="danger" :loading="submitting" @click="submitClear">确认关闭</el-button>
      </template>
    </el-dialog>

    <!-- 关闭两步验证弹窗（双因子确认：密码 + 当前动态码或恢复码） -->
    <el-dialog
      v-model="tfaDisableVisible"
      title="关闭两步验证"
      width="360px"
      :close-on-click-modal="false"
      @closed="resetDialog"
    >
      <p class="clear-tip">关闭后解锁仅需密码。请输入当前密码与动态码确认：</p>
      <el-input
        v-model="form.current"
        type="password"
        show-password
        placeholder="请输入当前密码"
        class="tfa-gap"
      />
      <el-input v-model="form.code" placeholder="6 位动态码或恢复码" @keyup.enter="submitDisable2fa" />
      <template #footer>
        <el-button @click="tfaDisableVisible = false">取消</el-button>
        <el-button type="danger" :loading="tfaSubmitting" @click="submitDisable2fa">确认关闭</el-button>
      </template>
    </el-dialog>

    <!-- 2FA 门禁向导（enroll 开启 / regenerate 重新生成恢复码） -->
    <TwoFactorGateWizard v-model="wizardVisible" :mode="wizardMode" @completed="onWizardCompleted" />
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { useRouter } from 'vue-router';
import LucideIcon from '@/components/LucideIcon.vue';
import useAppLock from '@/store/useAppLock';
import TwoFactorGateWizard from './TwoFactorGateWizard.vue';

/** 应用锁 store */
const lockStore = useAppLock();
const router = useRouter();

/** 应用锁开关切换中（防止连点） */
const switching = ref(false);
/** 密码设置/修改弹窗可见性 */
const passwordDialogVisible = ref(false);
/** 是否修改密码模式（false 为首次设置） */
const isChangeMode = ref(false);
/** 关闭应用锁验证弹窗可见性 */
const clearDialogVisible = ref(false);
/** 提交中 */
const submitting = ref(false);

/** 弹窗表单：当前密码 / 新密码 / 确认新密码 / 动态码 */
const form = reactive({ current: '', next: '', confirm: '', code: '' });

/** 2FA 门禁配置快照（enabled + 恢复码剩余数） */
const twoFa = reactive({ enabled: false, recoveryRemaining: 0 });
/** 门禁向导可见性与模式 */
const wizardVisible = ref(false);
const wizardMode = ref<'enroll' | 'regenerate'>('enroll');
/** 关闭两步验证弹窗可见性与提交中 */
const tfaDisableVisible = ref(false);
const tfaSubmitting = ref(false);

onMounted(() => {
  lockStore.init();
  load2faConfig();
});

// 应用锁关闭后门禁必然清除，联动刷新门禁配置快照
watch(
  () => lockStore.hasPassword,
  (has) => {
    if (!has) {
      twoFa.enabled = false;
      twoFa.recoveryRemaining = 0;
    } else {
      load2faConfig();
    }
  }
);

/**
 * 拉取 2FA 门禁配置快照（设置页展示启用状态与恢复码剩余数）
 *
 * @returns {Promise<void>}
 */
async function load2faConfig(): Promise<void> {
  try {
    const config = await lockStore.get2faConfig();
    twoFa.enabled = config.enabled;
    twoFa.recoveryRemaining = config.recoveryRemaining;
  } catch (err) {
    console.error('[AppLockSetting] 拉取门禁配置失败:', err);
  }
}

/**
 * 应用锁开关切换：开启 → 打开设置密码弹窗；关闭 → 打开验证关闭弹窗
 *
 * @returns {Promise<void>}
 */
async function handleSwitchLock(): Promise<void> {
  if (switching.value) return;
  if (!lockStore.hasPassword) {
    isChangeMode.value = false;
    passwordDialogVisible.value = true;
  } else {
    form.current = '';
    clearDialogVisible.value = true;
  }
}

/**
 * 打开修改密码弹窗
 *
 * @returns {void}
 */
function openChangeDialog(): void {
  isChangeMode.value = true;
  passwordDialogVisible.value = true;
}

/**
 * 提交设置/修改密码：校验一致性 → （修改模式先验证当前密码）→ 主进程加密落库
 *
 * @returns {Promise<void>}
 */
async function submitPassword(): Promise<void> {
  if (submitting.value) return;
  if (!form.next || form.next.length < 4) {
    ElMessage.warning('新密码长度至少 4 位');
    return;
  }
  if (form.next !== form.confirm) {
    ElMessage.warning('两次输入的新密码不一致');
    return;
  }
  submitting.value = true;
  try {
    // 修改模式：先验证当前密码
    if (isChangeMode.value) {
      const matched = await lockStore.verify(form.current);
      if (!matched) {
        ElMessage.error('当前密码错误');
        return;
      }
    }
    const ok = await lockStore.setPassword(form.next, isChangeMode.value ? form.current : undefined);
    if (ok) {
      ElMessage.success(isChangeMode.value ? '密码修改成功' : '应用锁已开启');
      passwordDialogVisible.value = false;
    } else {
      ElMessage.error('设置失败，请稍后重试');
    }
  } catch (err: any) {
    ElMessage.error('设置失败：' + (err?.message || '未知错误'));
  } finally {
    submitting.value = false;
  }
}

/**
 * 提交关闭应用锁：验证当前密码后清除并解除锁定
 *
 * @returns {Promise<void>}
 */
async function submitClear(): Promise<void> {
  if (submitting.value) return;
  submitting.value = true;
  try {
    const ok = await lockStore.clearPassword(form.current);
    if (ok) {
      ElMessage.success('应用锁已关闭');
      clearDialogVisible.value = false;
    } else {
      ElMessage.error('密码错误');
    }
  } catch (err: any) {
    ElMessage.error('操作失败：' + (err?.message || '未知错误'));
  } finally {
    submitting.value = false;
  }
}

/**
 * 立即锁定（测试/手动触发）
 *
 * @returns {Promise<void>}
 */
async function handleLockNow(): Promise<void> {
  await lockStore.lock();
}

/**
 * 2FA 门禁开关切换：未启用 → 打开注册向导；已启用 → 打开双因子关闭弹窗
 *
 * @returns {void}
 */
function handleSwitch2fa(): void {
  if (!twoFa.enabled) {
    wizardMode.value = 'enroll';
    wizardVisible.value = true;
  } else {
    form.current = '';
    form.code = '';
    tfaDisableVisible.value = true;
  }
}

/**
 * 打开「重新生成恢复码」向导（regenerate 模式：密码 + 动态码双因子确认）
 *
 * @returns {void}
 */
function openRegenerateWizard(): void {
  wizardMode.value = 'regenerate';
  wizardVisible.value = true;
}

/**
 * 关闭两步验证（双因子确认）：主进程删除门禁数据并刷新快照
 *
 * @returns {Promise<void>}
 */
async function submitDisable2fa(): Promise<void> {
  if (tfaSubmitting.value) return;
  if (!form.current || !form.code) {
    ElMessage.warning('请输入当前密码与动态码');
    return;
  }
  tfaSubmitting.value = true;
  try {
    const res = await lockStore.disable2fa(form.current, form.code.trim());
    if (res.ok) {
      ElMessage.success('两步验证已关闭');
      tfaDisableVisible.value = false;
      await load2faConfig();
    } else {
      ElMessage.error(res.error || '关闭失败');
    }
  } catch (err: any) {
    ElMessage.error('操作失败：' + (err?.message || '未知错误'));
  } finally {
    tfaSubmitting.value = false;
  }
}

/**
 * 向导完成回调：按模式提示并刷新门禁配置快照
 *
 * @returns {Promise<void>}
 */
async function onWizardCompleted(): Promise<void> {
  ElMessage.success(wizardMode.value === 'enroll' ? '两步验证已开启' : '恢复码已重新生成');
  await load2faConfig();
}

/**
 * 跳转快捷键配置页（绑定「隐私模式（老板键）」/「锁定应用」快捷键）
 *
 * @returns {void}
 */
function goShortcutPage(): void {
  router.push({ name: 'registerShortcut' });
}

/**
 * 重置弹窗表单
 *
 * @returns {void}
 */
function resetDialog(): void {
  form.current = '';
  form.next = '';
  form.confirm = '';
  form.code = '';
}
</script>

<style scoped lang="scss">
.app-lock-setting {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.lock-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 14px;
  border-radius: 8px;

  &:nth-child(odd) {
    background: var(--bg-hover);
  }

  .row-label {
    flex: 1;

    .row-main {
      font-size: 13px;
      font-weight: 500;
      color: var(--text-primary);
    }

    .row-desc {
      margin-top: 2px;
      font-size: 12px;
      color: var(--text-muted);
      line-height: 1.5;
    }
  }
}

.row-ops {
  display: flex;
  align-items: center;
  gap: 10px;
}

.tfa-badge {
  font-size: 12px;
  color: var(--text-muted);
  padding: 2px 8px;
  border-radius: 10px;
  background: var(--bg-hover);
}

.tfa-gap {
  margin-bottom: 10px;
}

.lock-actions {
  display: flex;
  align-items: center;
  gap: 0;
  padding: 4px 14px;
}

.clear-tip {
  margin: 0 0 12px;
  font-size: 13px;
  color: var(--text-secondary);
  line-height: 1.6;
}
</style>

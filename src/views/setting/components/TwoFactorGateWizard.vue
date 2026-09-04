<template>
  <el-dialog
    :model-value="modelValue"
    :title="title"
    width="440px"
    :close-on-click-modal="false"
    @update:model-value="handleVisibleChange"
    @closed="resetWizard"
  >
    <!-- 步骤1：验证当前密码（regenerate 模式还需当前动态码双因子确认） -->
    <template v-if="step === 1">
      <el-form label-position="top" @submit.prevent>
        <el-form-item label="当前应用锁密码">
          <el-input
            v-model="form.password"
            type="password"
            show-password
            placeholder="请输入当前密码"
            @keyup.enter="submitStep1"
          />
        </el-form-item>
        <el-form-item v-if="mode === 'regenerate'" label="当前动态码或恢复码">
          <el-input
            v-model="form.code"
            placeholder="6 位动态码或恢复码"
            @keyup.enter="submitStep1"
          />
        </el-form-item>
      </el-form>
      <div v-if="errorText" class="wizard-error">{{ errorText }}</div>
      <div v-if="mode === 'enroll'" class="wizard-tip">
        开启后解锁应用需「密码 + 手机验证器动态码」双重验证。请先在手机上安装验证器应用（如
        Google Authenticator、Microsoft Authenticator）。
      </div>
    </template>

    <!-- 步骤2：扫码 / 手动录入 → 输入动态码确认（仅 enroll 模式） -->
    <template v-else-if="step === 2">
      <div class="wizard-qr-tip">使用手机验证器扫描二维码，或手动录入密钥：</div>
      <div class="wizard-qr">
        <QrCodeView :content="form.uri" :size="180" />
      </div>
      <div class="wizard-secret">
        <span class="secret-text">{{ form.secret }}</span>
        <el-button size="small" link type="primary" @click="copyText(form.secret)">复制</el-button>
      </div>
      <el-input
        v-model="form.code"
        placeholder="输入手机上显示的 6 位动态码"
        size="large"
        class="wizard-code"
        @keyup.enter="submitStep2"
      />
      <div v-if="errorText" class="wizard-error">{{ errorText }}</div>
    </template>

    <!-- 步骤3：恢复码一次性展示 -->
    <template v-else>
      <el-alert
        type="warning"
        :closable="false"
        show-icon
        title="恢复码仅本次显示"
        description="手机丢失或验证器不可用时，可凭恢复码解锁应用。请离线妥善保存，关闭后无法再次查看。"
      />
      <div class="recovery-grid">
        <div v-for="code in form.recoveryCodes" :key="code" class="recovery-item">{{ code }}</div>
      </div>
      <div class="recovery-ops">
        <el-button size="small" @click="copyText(form.recoveryCodes.join('\n'))">
          <LucideIcon name="Copy" :size="13" />
          复制全部
        </el-button>
      </div>
      <el-checkbox v-model="form.savedAck">我已妥善保存恢复码</el-checkbox>
    </template>

    <template #footer>
      <template v-if="step === 1">
        <el-button @click="handleVisibleChange(false)">取消</el-button>
        <el-button
          type="primary"
          :loading="submitting"
          :disabled="!form.password || (mode === 'regenerate' && !form.code)"
          @click="submitStep1"
        >
          下一步
        </el-button>
      </template>
      <template v-else-if="step === 2">
        <el-button @click="backToStep1">上一步</el-button>
        <el-button
          type="primary"
          :loading="submitting"
          :disabled="form.code.replace(/\D/g, '').length !== 6"
          @click="submitStep2"
        >
          验证并开启
        </el-button>
      </template>
      <template v-else>
        <el-button type="primary" :disabled="!form.savedAck" @click="finish">完成</el-button>
      </template>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
/**
 * 应用锁 2FA 门禁向导
 *
 * 两种模式复用同一流程：
 * - enroll：验证密码 → 扫码/手动录入 → 输动态码确认 → 恢复码一次性展示；
 * - regenerate：密码 + 当前动态码双因子确认 → 直接出新的恢复码（旧码作废）。
 * 密钥材料（URI/密钥文本）仅注册期间一次性回传，由主进程暂存会话承载；
 * 取消/关闭时调 enrollCancel 清主进程会话。二维码用 QrCodeView 内联渲染，不落 qr_history。
 */
import { computed, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import LucideIcon from '@/components/LucideIcon.vue';
import QrCodeView from '@/components/qrcode/QrCodeView.vue';
import useAppLock from '@/store/useAppLock';

/** 向导模式：enroll 开启门禁 / regenerate 重新生成恢复码 */
const props = defineProps<{ modelValue: boolean; mode: 'enroll' | 'regenerate' }>();

/** completed：流程完成（父组件刷新配置并提示） */
const emit = defineEmits<{ (e: 'update:modelValue', v: boolean): void; (e: 'completed'): void }>();

/** 应用锁 store（门禁管理动作） */
const lockStore = useAppLock();

/** 当前步骤：1 验证密码 / 2 扫码确认 / 3 恢复码展示 */
const step = ref(1);
/** 提交中 */
const submitting = ref(false);
/** 错误提示 */
const errorText = ref('');
/** 向导表单（uri/secret/recoveryCodes 仅内存持有，不持久化） */
const form = reactive({
  password: '',
  code: '',
  uri: '',
  secret: '',
  recoveryCodes: [] as string[],
  savedAck: false,
});

/** 弹窗标题按模式区分 */
const title = computed(() => (props.mode === 'enroll' ? '开启两步验证（TOTP）' : '重新生成恢复码'));

/**
 * 提交步骤1：enroll 调注册接口拿到 URI/密钥进入扫码步；
 * regenerate 双因子确认后直接进入恢复码展示
 *
 * @returns {Promise<void>}
 */
async function submitStep1(): Promise<void> {
  if (submitting.value || !form.password) return;
  if (props.mode === 'regenerate' && !form.code) return;
  submitting.value = true;
  errorText.value = '';
  try {
    if (props.mode === 'enroll') {
      const res = await lockStore.enrollStart(form.password);
      if (res.ok && res.uri && res.secret) {
        form.uri = res.uri;
        form.secret = res.secret;
        form.code = '';
        step.value = 2;
      } else {
        errorText.value = res.error || '验证失败';
      }
    } else {
      const res = await lockStore.regenerateRecovery(form.password, form.code.trim());
      if (res.ok && res.recoveryCodes) {
        form.recoveryCodes = res.recoveryCodes;
        step.value = 3;
      } else {
        errorText.value = res.error || '操作失败';
      }
    }
  } catch (err: any) {
    errorText.value = '操作失败：' + (err?.message || '未知错误');
  } finally {
    submitting.value = false;
  }
}

/**
 * 提交步骤2：输入手机当前动态码确认注册，成功后展示恢复码
 *
 * @returns {Promise<void>}
 */
async function submitStep2(): Promise<void> {
  if (submitting.value || form.code.replace(/\D/g, '').length !== 6) return;
  submitting.value = true;
  errorText.value = '';
  try {
    const res = await lockStore.enrollConfirm(form.code.trim());
    if (res.ok && res.recoveryCodes) {
      form.recoveryCodes = res.recoveryCodes;
      step.value = 3;
    } else {
      errorText.value = res.error || '验证失败';
    }
  } catch (err: any) {
    errorText.value = '验证失败：' + (err?.message || '未知错误');
  } finally {
    submitting.value = false;
  }
}

/**
 * 返回步骤1（扫码步上一步）：清主进程暂存会话，密钥材料作废
 *
 * @returns {void}
 */
function backToStep1(): void {
  step.value = 1;
  form.uri = '';
  form.secret = '';
  form.code = '';
  errorText.value = '';
  lockStore.enrollCancel();
}

/**
 * 完成：通知父组件刷新配置并关闭弹窗
 *
 * @returns {void}
 */
function finish(): void {
  emit('completed');
  emit('update:modelValue', false);
}

/**
 * 弹窗显隐变化：注册中途关闭时清主进程暂存会话
 *
 * @param {boolean} v - 目标显隐
 * @returns {void}
 */
function handleVisibleChange(v: boolean): void {
  if (!v && props.mode === 'enroll' && step.value < 3) {
    lockStore.enrollCancel();
  }
  emit('update:modelValue', v);
}

/**
 * 关闭后重置向导内部状态
 *
 * @returns {void}
 */
function resetWizard(): void {
  step.value = 1;
  errorText.value = '';
  form.password = '';
  form.code = '';
  form.uri = '';
  form.secret = '';
  form.recoveryCodes = [];
  form.savedAck = false;
}

/**
 * 复制文本到剪贴板（渲染端原生剪贴板，失败静默提示）
 *
 * @param {string} text - 待复制文本
 * @returns {Promise<void>}
 */
async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    ElMessage.success('已复制到剪贴板');
  } catch {
    ElMessage.error('复制失败，请手动选择复制');
  }
}
</script>

<style scoped lang="scss">
.wizard-tip {
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.6;
}

.wizard-error {
  margin-top: 4px;
  font-size: 12px;
  color: var(--el-color-danger, #f56c6c);
}

.wizard-qr-tip {
  font-size: 13px;
  color: var(--text-secondary);
  margin-bottom: 10px;
}

.wizard-qr {
  display: flex;
  justify-content: center;
  padding: 8px 0 12px;
}

.wizard-secret {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  margin-bottom: 12px;
  border-radius: 6px;
  background: var(--bg-hover);

  .secret-text {
    flex: 1;
    font-family: monospace;
    font-size: 12px;
    word-break: break-all;
    color: var(--text-primary);
    user-select: all;
  }
}

.wizard-code {
  margin-top: 4px;
}

.recovery-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 6px;
  margin: 12px 0;
}

.recovery-item {
  padding: 6px 10px;
  border-radius: 6px;
  background: var(--bg-hover);
  font-family: monospace;
  font-size: 13px;
  text-align: center;
  color: var(--text-primary);
  user-select: all;
}

.recovery-ops {
  display: flex;
  justify-content: center;
  margin-bottom: 8px;
}
</style>

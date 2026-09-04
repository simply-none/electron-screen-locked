<template>
  <div class="totp-step">
    <div class="totp-desc">
      {{ useRecovery ? '输入启用两步验证时保存的恢复码' : '输入手机验证器上当前显示的动态码' }}
    </div>
    <el-input
      ref="codeInputRef"
      v-model="code"
      :maxlength="useRecovery ? 13 : 6"
      :placeholder="useRecovery ? 'xxxxxx-xxxxxx' : '6 位动态码'"
      size="large"
      :disabled="cooldown > 0"
      class="lock-input"
      @keyup.enter="handleSubmit"
    />
    <div class="lock-error">
      <template v-if="cooldown > 0">尝试次数过多，请 {{ cooldown }} 秒后再试</template>
      <template v-else-if="errorText">{{ errorText }}</template>
    </div>
    <el-button
      type="primary"
      class="lock-btn"
      size="large"
      :loading="verifying"
      :disabled="cooldown > 0 || !code"
      @click="handleSubmit"
    >
      验证并解锁
    </el-button>
    <div class="totp-links">
      <el-button link size="small" @click="toggleMode">
        {{ useRecovery ? '使用动态码' : '使用恢复码' }}
      </el-button>
      <el-button link size="small" @click="emit('back')">返回重新输入密码</el-button>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 应用锁 2FA 门禁第二步（动态码 / 恢复码输入）
 *
 * 职责：在锁屏遮罩内完成「密码通过后」的 TOTP 动态码（或一次性恢复码）校验；
 * 校验结果由主进程权威判定（app-lock:verify-2fa），成功后主进程广播解锁、遮罩自动淡出。
 * 冷却倒计时由父组件（AppLock.vue）持有（主进程返回的 retryAfterSeconds 驱动），本组件仅展示。
 */
import { nextTick, onMounted, ref, watch } from 'vue';
import useAppLock from '@/store/useAppLock';

/** 第一步密码验证通过后返回的待 2FA 会话 token */
const props = defineProps<{ token: string; cooldown: number }>();

/** cooldown：通知父组件启动冷却倒计时；back：返回密码输入步 */
const emit = defineEmits<{ (e: 'cooldown', seconds: number): void; (e: 'back'): void }>();

/** 应用锁 store（verify2fa 走主进程校验） */
const lockStore = useAppLock();

/** 输入的动态码 / 恢复码 */
const code = ref('');
/** 是否处于恢复码模式（默认动态码） */
const useRecovery = ref(false);
/** 是否正在校验 */
const verifying = ref(false);
/** 错误提示文本 */
const errorText = ref('');
/** 输入框引用（挂载时自动聚焦） */
const codeInputRef = ref();

onMounted(async () => {
  await nextTick();
  codeInputRef.value?.focus?.();
});

// 动态码模式下输满 6 位自动提交（恢复码不自动提交，格式多样）
watch(code, (val) => {
  if (!useRecovery.value && /^\d{6}$/.test(val)) handleSubmit();
});

/**
 * 切换动态码 / 恢复码模式：清空输入与错误提示
 *
 * @returns {void}
 */
function toggleMode(): void {
  useRecovery.value = !useRecovery.value;
  code.value = '';
  errorText.value = '';
  codeInputRef.value?.focus?.();
}

/**
 * 提交动态码 / 恢复码：主进程校验通过即广播解锁（本组件无需处理成功态）；
 * 失败展示剩余次数，进入冷却时通知父组件启动倒计时
 *
 * @returns {Promise<void>}
 */
async function handleSubmit(): Promise<void> {
  if (!code.value || props.cooldown > 0 || verifying.value) return;
  verifying.value = true;
  errorText.value = '';
  try {
    const res = await lockStore.verify2fa(props.token, code.value.trim());
    if (res.ok) {
      code.value = '';
    } else if (res.retryAfterSeconds && res.retryAfterSeconds > 0) {
      emit('cooldown', res.retryAfterSeconds);
    } else {
      errorText.value =
        typeof res.remainingAttempts === 'number'
          ? `${res.error || '动态码不正确'}（还剩 ${res.remainingAttempts} 次尝试机会）`
          : res.error || '动态码不正确';
    }
  } catch (err: any) {
    errorText.value = '校验失败：' + (err?.message || '未知错误');
  } finally {
    verifying.value = false;
    codeInputRef.value?.focus?.();
  }
}
</script>

<style scoped lang="scss">
.totp-step {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  width: 100%;
}

.totp-desc {
  font-size: 13px;
  color: rgba(255, 255, 255, 0.65);
}

.lock-input {
  width: 100%;

  :deep(.el-input__wrapper) {
    background: rgba(255, 255, 255, 0.12);
    box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.25) inset;

    &.is-focus {
      box-shadow: 0 0 0 1px var(--color-primary, #409eff) inset;
    }

    .el-input__inner {
      color: #fff;

      &::placeholder {
        color: rgba(255, 255, 255, 0.45);
      }
    }
  }
}

.lock-error {
  min-height: 18px;
  font-size: 12px;
  color: #ff9a8a;
}

.lock-btn {
  width: 100%;
}

.totp-links {
  display: flex;
  align-items: center;
  gap: 4px;
}
</style>

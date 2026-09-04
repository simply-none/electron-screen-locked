<template>
  <!-- 应用锁遮罩：锁定时全屏覆盖，毛玻璃模糊防窥，输密码解锁 -->
  <Transition name="lock-fade">
    <div v-if="lockStore.locked" class="app-lock-mask">
      <div class="lock-panel">
        <div class="lock-icon">
          <LucideIcon name="LockKeyhole" :size="42" />
        </div>
        <div class="lock-title">渐离App 已锁定</div>
        <!-- 第一步：密码输入；开启 2FA 门禁后密码通过将切到动态码步 -->
        <template v-if="step === 'password'">
          <div class="lock-desc">输入密码解锁应用</div>
          <el-input
            ref="pwdInputRef"
            v-model="password"
            type="password"
            placeholder="请输入密码"
            size="large"
            show-password
            :disabled="cooldown > 0"
            class="lock-input"
            @keyup.enter="handleUnlock"
          />
          <div class="lock-error">
            <template v-if="cooldown > 0">
              尝试次数过多，请 {{ cooldown }} 秒后再试
            </template>
            <template v-else-if="errorText">{{ errorText }}</template>
          </div>
          <el-button
            type="primary"
            class="lock-btn"
            size="large"
            :loading="unlocking"
            :disabled="cooldown > 0 || !password"
            @click="handleUnlock"
          >
            解锁
          </el-button>
        </template>
        <!-- 第二步：动态码 / 恢复码校验（2FA 门禁） -->
        <AppLockTotpStep
          v-else
          :token="pendingToken"
          :cooldown="cooldown"
          @cooldown="startCooldown"
          @back="backToPassword"
        />
      </div>
    </div>
  </Transition>
</template>

<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue';
import LucideIcon from '@/components/LucideIcon.vue';
import useAppLock from '@/store/useAppLock';
import AppLockTotpStep from './components/AppLockTotpStep.vue';

/** 应用锁 store（锁定态由主进程广播驱动） */
const lockStore = useAppLock();

/** 当前解锁步骤：password 密码步 / totp 动态码步（2FA 门禁） */
const step = ref<'password' | 'totp'>('password');
/** 待 2FA 会话 token（密码步通过后由主进程返回） */
const pendingToken = ref('');
/** 密码输入 */
const password = ref('');
/** 输入框引用（锁定时自动聚焦） */
const pwdInputRef = ref();
/** 是否正在解锁 */
const unlocking = ref(false);
/** 错误提示文本 */
const errorText = ref('');
/** 冷却倒计时（秒），0 表示无冷却（数值来自主进程返回的 retryAfterSeconds） */
const cooldown = ref(0);
/** 冷却定时器句柄 */
let cooldownTimer: ReturnType<typeof setInterval> | null = null;

onMounted(() => {
  lockStore.init();
});

// 锁定态变化：复位到密码步并清空输入（防遗留上一次的密码/会话 token）
watch(
  () => lockStore.locked,
  async (locked) => {
    if (locked) {
      password.value = '';
      errorText.value = '';
      pendingToken.value = '';
      step.value = 'password';
      await nextTick();
      pwdInputRef.value?.focus?.();
    } else {
      // 解锁成功：清空全部临时状态
      pendingToken.value = '';
      step.value = 'password';
      cooldown.value = 0;
      if (cooldownTimer) clearInterval(cooldownTimer);
      cooldownTimer = null;
    }
  }
);

/**
 * 第一步解锁：主进程校验密码；开启 2FA 门禁时返回待验证会话，切到动态码步。
 * 失败计数与冷却在主进程维护，此处仅按返回值提示剩余次数 / 启动冷却倒计时。
 *
 * @returns {Promise<void>}
 */
async function handleUnlock(): Promise<void> {
  if (!password.value || cooldown.value > 0 || unlocking.value) return;
  unlocking.value = true;
  errorText.value = '';
  try {
    const res = await lockStore.unlock(password.value);
    if (res.matched && res.need2fa) {
      // 密码正确且已开启门禁：进入第二步（动态码 / 恢复码）
      pendingToken.value = res.token || '';
      step.value = 'totp';
      password.value = '';
    } else if (res.matched) {
      // 直接解锁成功（未开启门禁）：遮罩随广播淡出
      password.value = '';
      errorText.value = '';
    } else if (res.retryAfterSeconds && res.retryAfterSeconds > 0) {
      startCooldown(res.retryAfterSeconds);
    } else {
      errorText.value =
        typeof res.remainingAttempts === 'number'
          ? `密码错误（还剩 ${res.remainingAttempts} 次尝试机会）`
          : '密码错误';
    }
  } catch (err: any) {
    errorText.value = '解锁失败：' + (err?.message || '未知错误');
  } finally {
    unlocking.value = false;
    if (lockStore.locked && step.value === 'password') pwdInputRef.value?.focus?.();
  }
}

/**
 * 返回密码输入步（动态码步点击「返回重新输入密码」）：
 * 旧会话 token 作废，重新提交密码会创建新会话
 *
 * @returns {Promise<void>}
 */
async function backToPassword(): Promise<void> {
  pendingToken.value = '';
  step.value = 'password';
  errorText.value = '';
  await nextTick();
  pwdInputRef.value?.focus?.();
}

/**
 * 启动冷却倒计时（主进程返回的 retryAfterSeconds 驱动，冷却期内两步输入均禁用）
 *
 * @param {number} seconds - 冷却秒数
 * @returns {void}
 */
function startCooldown(seconds: number): void {
  cooldown.value = seconds;
  errorText.value = '';
  if (cooldownTimer) clearInterval(cooldownTimer);
  cooldownTimer = setInterval(() => {
    cooldown.value -= 1;
    if (cooldown.value <= 0) {
      if (cooldownTimer) clearInterval(cooldownTimer);
      cooldownTimer = null;
    }
  }, 1000);
}
</script>

<style scoped lang="scss">
.app-lock-mask {
  position: fixed;
  inset: 0;
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
  // 毛玻璃 + 深色遮罩：完全遮蔽底下的应用内容（防窥）
  background: rgba(15, 18, 25, 0.55);
  backdrop-filter: blur(24px) saturate(120%);
}

.lock-panel {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  width: 320px;
  padding: 36px 32px;
  border-radius: 16px;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.15);
  box-shadow: 0 12px 48px rgba(0, 0, 0, 0.35);
}

.lock-icon {
  width: 76px;
  height: 76px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, var(--color-primary, #409eff), var(--color-primary-light, #79bbff));
  color: #fff;
}

.lock-title {
  font-size: 17px;
  font-weight: 600;
  color: #fff;
}

.lock-desc {
  font-size: 13px;
  color: rgba(255, 255, 255, 0.65);
}

.lock-input {
  width: 100%;
  margin-top: 8px;

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

// 锁定遮罩淡入淡出
.lock-fade-enter-active,
.lock-fade-leave-active {
  transition: opacity 0.25s ease;
}

.lock-fade-enter-from,
.lock-fade-leave-to {
  opacity: 0;
}
</style>

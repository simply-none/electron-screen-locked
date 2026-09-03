<template>
  <div class="small-window" :class="statusClass">
    <div class="window-content">
      <div class="status-section">
        <div class="status-icon">
          <LucideIcon :name="statusIcon" :size="24" />
        </div>
        <div class="status-info">
          <div class="status-label">{{ statusLabel }}</div>
          <div class="next-time">{{ nextTimeLabel }}：{{ nextTimeValue }}</div>
        </div>
      </div>

      <div class="progress-section">
        <div class="progress-bar">
          <div 
            class="progress-fill" 
            :style="{ width: progressPercent + '%' }"
          ></div>
        </div>
        <div class="progress-text">{{ Math.round(progressPercent) }}%</div>
      </div>

      <div class="countdown-section">
        <div class="countdown-label">{{ countdownLabel }}</div>
        <div class="countdown-value">{{ countdownValue }}</div>
      </div>
    </div>

    <div class="setting-btn" @click="toSetting">
      <LucideIcon name="Settings" :size="18" />
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import useTipsRuntime from '@/store/useTipsRuntime';
import { useTipsActions } from '@/store/useTipsActions';
import useNewReminder from '@/store/useNewReminder';
import { isInIdlePeriod } from '@/utils/idleTime';
import { storeToRefs } from 'pinia';
import LucideIcon from '@/components/LucideIcon.vue';

const router = useRouter();
const timer = ref(null);

// 番茄钟运行时（多状态提醒）由主进程驱动，这里仅做展示
const runtime = useTipsRuntime();
const { currentStateKey, nextStateTime, stateStartTime } = storeToRefs(runtime);
const reminderStore = useNewReminder();
const pomodoroReminder = computed(() => reminderStore.reminders.find((r) => r.id === 'pomodoro'));
// 空闲（免打扰）判定：按提醒配置 idleTime + 当前时间本地推导（确定性、与其它端统一）；
// 同时兼容主进程下发的 runtime.idle。nowRef 随倒计时刷新，跨过空闲边界即时响应。
const nowRef = ref(Date.now());
const isIdleNow = computed(() =>
  isInIdlePeriod(pomodoroReminder.value?.idleTime, new Date(nowRef.value)) || runtime.idle
);

// 第二窗口是独立渲染进程，需自行注册状态监听并拉取当前状态
const { registerGlobalListener, unregisterGlobalListener } = useTipsActions();

const statusIcon = computed(() => {
  if (isIdleNow.value) return 'Moon';
  if (currentStateKey.value === 'work') return 'timer';
  if (currentStateKey.value === 'lock') return 'lock';
  return 'coffee';
});

const statusClass = computed(() => {
  if (isIdleNow.value) return 'status-idle';
  if (currentStateKey.value === 'work') return 'status-work';
  if (currentStateKey.value === 'lock') return 'status-lock';
  return 'status-rest';
});

const statusLabel = computed(() => {
  if (isIdleNow.value) return '空闲中';
  if (currentStateKey.value === 'work') return '工作中';
  if (currentStateKey.value === 'lock') return '锁屏中';
  return '休息中';
});

const nextTimeLabel = computed(() => {
  if (isIdleNow.value) return '免打扰';
  if (currentStateKey.value === 'work') return '下次休息';
  if (currentStateKey.value === 'lock') return '结束后回到';
  return '下次工作';
});

const nextTimeValue = computed(() => {
  if (isIdleNow.value) return '时段内不打扰';
  if (!nextStateTime.value) return '--:--';
  return new Date(nextStateTime.value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
});

const countdownLabel = computed(() => {
  if (isIdleNow.value) return '状态';
  if (currentStateKey.value === 'work') return '距离休息';
  if (currentStateKey.value === 'lock') return '距离解锁';
  return '距离工作';
});

const countdownValue = ref('00:00:00');

const progressPercent = computed(() => {
  if (isIdleNow.value) return 0;
  const now = Date.now();
  const start = stateStartTime.value || now;
  const end = nextStateTime.value || now;
  const total = end - start;
  const current = now - start;
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, (current / total) * 100));
});

function countDown(time) {
  if (!time) return '00:00:00';
  const now = Date.now();
  const diff = (new Date(time)).getTime() - now;
  if (diff < 0) return '00:00:00';
  const h = Math.floor(diff / 1000 / 60 / 60);
  const m = Math.floor((diff / 1000 / 60) % 60);
  const s = Math.floor((diff / 1000) % 60);
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function updateCountdown() {
  nowRef.value = Date.now(); // 驱动空闲边界的响应式刷新（跨过空闲段即时响应）
  if (isIdleNow.value) {
    countdownValue.value = '空闲中';
    return;
  }
  countdownValue.value = countDown(nextStateTime.value);
}

onMounted(() => {
  registerGlobalListener();
  updateCountdown();
  timer.value = setInterval(updateCountdown, 1000);
});

onUnmounted(() => {
  if (timer.value) {
    clearInterval(timer.value);
  }
  unregisterGlobalListener();
});

function toSetting() {
  router.push('/setting');
}
</script>

<style lang="scss" scoped>
.small-window {
  // 禁止复制
  -webkit-user-select: none;
  user-select: none;
  width: 280px;
  min-height: 180px;
  display: flex;
  flex-direction: column;
  padding: 20px;
  box-sizing: border-box;
  border-radius: 16px;
  transition: all 0.5s ease;
  -webkit-app-region: drag;
  position: relative;
  overflow: hidden;

  &.status-work {
    background: linear-gradient(135deg, #e8f5e9 0%, #c8e6c9 100%);
    
    .status-icon {
      background: linear-gradient(135deg, #4caf50 0%, #45a049 100%);
    }
    
    .status-label {
      color: #2e7d32;
    }
    
    .progress-fill {
      background: linear-gradient(90deg, #4caf50 0%, #66bb6a 100%);
    }
    
    .countdown-value {
      color: #2e7d32;
    }
  }

  &.status-rest {
    background: linear-gradient(135deg, #e3f2fd 0%, #bbdefb 100%);
    
    .status-icon {
      background: linear-gradient(135deg, #2196f3 0%, #1976d2 100%);
    }
    
    .status-label {
      color: #1565c0;
    }
    
    .progress-fill {
      background: linear-gradient(90deg, #2196f3 0%, #42a5f5 100%);
    }
    
    .countdown-value {
      color: #1565c0;
    }
  }

  &.status-lock {
    background: linear-gradient(135deg, #fff3e0 0%, #ffe0b2 100%);

    .status-icon {
      background: linear-gradient(135deg, #ff9800 0%, #f57c00 100%);
    }

    .status-label {
      color: #e65100;
    }

    .progress-fill {
      background: linear-gradient(90deg, #ff9800 0%, #ffb74d 100%);
    }

    .countdown-value {
      color: #e65100;
    }
  }

  &.status-idle {
    background: linear-gradient(135deg, #f5f5f5 0%, #e0e0e0 100%);

    .status-icon {
      background: linear-gradient(135deg, #9e9e9e 0%, #757575 100%);
    }

    .status-label {
      color: #616161;
    }

    .progress-fill {
      background: linear-gradient(90deg, #9e9e9e 0%, #bdbdbd 100%);
    }

    .countdown-value {
      color: #616161;
    }
  }
}

.window-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 16px;
  z-index: 1;
}

.status-section {
  display: flex;
  align-items: center;
  gap: 12px;
  
  .status-icon {
    width: 48px;
    height: 48px;
    border-radius: 12px;
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
    transition: transform 0.3s ease;
    
    &:hover {
      transform: scale(1.05);
    }
    
    .el-icon {
      font-size: 24px;
      color: #fff;
    }
  }
  
  .status-info {
    display: flex;
    flex-direction: column;
    gap: 4px;
    
    .status-label {
      font-size: 18px;
      font-weight: 700;
    }
    
    .next-time {
      font-size: 13px;
      color: #666;
    }
  }
}

.progress-section {
  display: flex;
  align-items: center;
  gap: 10px;
  
  .progress-bar {
    flex: 1;
    height: 8px;
    background: rgba(255, 255, 255, 0.6);
    border-radius: 4px;
    overflow: hidden;
    
    .progress-fill {
      height: 100%;
      border-radius: 4px;
      transition: width 1s ease;
    }
  }
  
  .progress-text {
    font-size: 12px;
    font-weight: 600;
    color: #666;
    min-width: 36px;
    text-align: right;
  }
}

.countdown-section {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  
  .countdown-label {
    font-size: 12px;
    color: #888;
    text-transform: uppercase;
    letter-spacing: 1px;
  }
  
  .countdown-value {
    font-size: 36px;
    font-weight: 900;
    font-family: 'SF Mono', Monaco, 'Consolas', monospace;
    text-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
  }
}

.setting-btn {
  position: absolute;
  top: 12px;
  right: 12px;
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.5);
  cursor: pointer;
  -webkit-app-region: no-drag;
  transition: all 0.3s ease;
  
  &:hover {
    background: rgba(255, 255, 255, 0.8);
    transform: scale(1.1);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  }
  
  &:active {
    transform: scale(0.95);
  }
  
  .el-icon {
    font-size: 18px;
    color: #666;
  }
}
</style>

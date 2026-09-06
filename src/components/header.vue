<template>
  <div class="app-header">
    <!-- 左侧：返回按钮 + 页面标题 -->
    <div class="header-left">
      <button
        class="back-btn"
        :class="{ 'is-hidden': hideBack }"
        @click="back"
        title="返回主页"
      >
        <svg
          class="back-icon"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <polyline points="15 18 9 12 15 6" />
        </svg>
      </button>
      <span class="page-title">{{ title }}</span>
    </div>

    <!-- 右侧：应用信息 -->
    <div class="header-right">
      <div class="app-badge">
        <img class="app-logo" src="/logo.svg" alt="logo" />
        <div class="app-info">
          <span class="app-name">{{ nickname }}</span>
          <span class="version-tag">v{{ pkg.version }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script lang="ts" setup>
import { ref, onMounted } from 'vue'
import pkg from '../../package.json'

const props = defineProps({
  title: {
    type: String,
    default: '',
  },
  hideBack: {
    type: Boolean,
    default: false,
  },
})

const emit = defineEmits(['back'])

// 顶部栏展示随机昵称（主进程 3 天有效期，过期自动重生成）
const nickname = ref('渐离 App')
onMounted(async () => {
  try {
    const n = await window.ipcRenderer.invoke('transfer:nickname')
    if (n) nickname.value = n
  } catch {
    /* 取不到就回退默认文案 */
  }
})

function back () {
  emit('back')
}
</script>

<style lang="scss" scoped>
.app-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  user-select: none;
}

/* ---------- 左侧 ---------- */
.header-left {
  display: flex;
  align-items: center;
  gap: 10px;
}

.back-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  padding: 0;
  border: none;
  border-radius: var(--radius-btn);
  background: var(--bg-active-btn);
  color: var(--text-secondary);
  cursor: pointer;
  transition: background 0.2s, color 0.2s, transform 0.15s;
  flex-shrink: 0;

  .back-icon {
    width: 16px;
    height: 16px;
    transition: transform 0.2s;
  }

  &:hover {
    background: var(--bg-active-btn-hover);
    color: var(--text-primary);

    .back-icon {
      transform: translateX(-2px);
    }
  }

  &:active {
    background: var(--bg-hover);
    transform: scale(0.95);
  }

  &.is-hidden {
    visibility: hidden;
    pointer-events: none;
  }
}

.page-title {
  font-size: 1.18rem;
  font-weight: 650;
  color: var(--text-primary);
  letter-spacing: 0.01em;
  line-height: 1.3;
}

/* ---------- 右侧 ---------- */
.header-right {
  display: flex;
  align-items: center;
}

.app-badge {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 4px 12px 4px 4px;
  border-radius: 20px;
  background: linear-gradient(135deg,
    color-mix(in srgb, var(--logo-gradient-from) 12%, transparent),
    color-mix(in srgb, var(--logo-gradient-to) 10%, transparent));
  transition: background 0.2s, opacity 0.2s;

  &:hover {
    background: linear-gradient(135deg,
      color-mix(in srgb, var(--logo-gradient-from) 18%, transparent),
      color-mix(in srgb, var(--logo-gradient-to) 15%, transparent));
  }
}

.app-logo {
  width: 26px;
  height: 26px;
  border-radius: 6px;
  flex-shrink: 0;
  object-fit: contain;
}

.app-info {
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.app-name {
  font-size: 0.82rem;
  font-weight: 700;
  line-height: 1.2;
  background: linear-gradient(135deg, var(--logo-gradient-from), var(--logo-gradient-to));
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

.version-tag {
  font-size: 0.7rem;
  font-weight: 500;
  color: var(--text-muted);
  line-height: 1.2;
  font-variant-numeric: tabular-nums;
}
</style>
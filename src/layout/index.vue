<template>
  <div class="layout-vue">
    <Layout isPadding :showTop="topbarVisible" :showLeft="sidebarVisible">
      <template #top>
        <div class="header-row">
          <Header :title="title" @back="toHome" />
          <div class="header-toggles">
            <button
              class="toggle-btn"
              :class="{ 'is-off': !topbarVisible }"
              :title="topbarVisible ? '隐藏顶部栏' : '显示顶部栏'"
              @click="setTopbarVisible(!topbarVisible)"
            >
              <LucideIcon :name="topbarVisible ? 'PanelTop' : 'PanelTopClose'" :size="16" />
            </button>
            <button
              class="toggle-btn"
              :class="{ 'is-off': !sidebarVisible }"
              :title="sidebarVisible ? '隐藏侧边栏' : '显示侧边栏'"
              @click="setSidebarVisible(!sidebarVisible)"
            >
              <LucideIcon :name="sidebarVisible ? 'PanelLeft' : 'PanelLeftClose'" :size="16" />
            </button>
          </div>
        </div>
      </template>
      <template #left>
        <nav class="sidebar-menu">
          <div v-for="group in menuGroups" :key="group.label" class="menu-group">
            <div class="group-label">{{ group.label }}</div>
            <div
              v-for="item in group.items"
              :key="item.name as string"
              class="menu-item"
              :class="{ 'is-active': activeIndex === item.name }"
              @click="toggleRoute(item)"
            >
              <LucideIcon :name="item.meta?.icon as string" :size="17" class="menu-icon" />
              <span class="menu-text">{{ item.meta?.title || '占位' }}</span>
            </div>
          </div>
        </nav>
        <!-- 主题切换器 -->
        <div class="theme-switcher" ref="themeSwitcherRef">
          <div class="theme-label">主题</div>
          <div class="theme-options">
            <button
              v-for="t in displayedThemes"
              :key="t.name"
              class="theme-dot"
              :class="{ 'is-active': currentTheme === t.name }"
              :title="t.label"
              :style="{ '--dot-bg': t.preview[0], '--dot-card': t.preview[1], '--dot-primary': t.preview[2] }"
              @click="setTheme(t.name)"
            >
              <span class="dot-inner" />
            </button>
            <button
              class="theme-more"
              :class="{ 'is-open': showThemeDropdown }"
              @click="toggleThemeDropdown"
            >
              <span class="more-icon">⋮</span>
            </button>
          </div>
          <!-- 主题下拉面板 -->
          <Transition name="dropdown">
            <div v-if="showThemeDropdown" class="theme-dropdown" ref="themeDropdownRef">
              <div
                v-for="t in dropdownThemes"
                :key="t.name"
                class="dropdown-item"
                :class="{ 'is-active': currentTheme === t.name }"
                @click="handleDropdownThemeClick(t.name)"
              >
                <span class="dropdown-dot" :style="{ '--dot-bg': t.preview[0], '--dot-card': t.preview[1], '--dot-primary': t.preview[2] }" />
                <span class="dropdown-label">{{ t.label }}</span>
              </div>
            </div>
          </Transition>
        </div>
      </template>
      <template #main>
        <RouterView />
      </template>
    </Layout>

    <!-- 应用锁遮罩：锁定态下全屏覆盖（主进程广播驱动） -->
    <AppLock />

    <!-- 顶部栏隐藏时显示的浮动恢复按钮 -->
    <Transition name="float-fade">
      <button
        v-if="!topbarVisible"
        class="float-restore-top"
        title="显示顶部栏"
        @click="setTopbarVisible(true)"
      >
        <LucideIcon name="PanelTopClose" :size="15" />
      </button>
    </Transition>
  </div>
</template>

<script setup lang="ts">
import Layout from '@/components/layout.vue';
import Header from '@/components/header.vue';
import LucideIcon from '@/components/LucideIcon.vue';
import AppLock from '@/layout/AppLock.vue';
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useRoute, useRouter, type RouteRecordNameGeneric, type RouteRecordRaw } from 'vue-router';
import { layoutRouters } from '@/router';
import { storeToRefs } from 'pinia';
import useRuntimeVariables from '@/store/useRuntimeVariables';
import useTheme, { themeOptions, type ThemeName } from '@/store/useTheme';
import { watch } from 'vue';
import { getStore } from '@/utils/common';
import { iconMap } from '@/utils';
import { fileNotify } from '@/utils/fileNotify';
import useGlobalSetting from '@/store/useGlobalSetting';

// 为每个路由注入图标到 meta
const enrichedRouters = layoutRouters.map(r => ({
  ...r,
  meta: { ...r.meta, icon: iconMap[r.name as string] || 'settings' },
}));

// 菜单分组定义
interface MenuGroup {
  label: string;
  names: string[];
}

const groupDefs: MenuGroup[] = [
  { label: '通用', names: ['setting', 'newTips', 'homeMode', 'windowMode'] },
  { label: '系统与资源', names: ['systemInfo', 'routeSetting', 'appCache', 'backup', 'fileRela', 'resourceManage', 'safetyProtection', 'sync', 'fileTransfer', 'ferry'] },
  { label: '效率工具', names: ['pomodoroRecord', 'clipboard', 'notebookApp', 'categorizableNotes', 'themeConversation', 'todoList', 'habit', 'countdown', 'accounting', 'stock', 'earning', 'resume', 'registerShortcut', 'function', 'weather', 'browser', 'ebookReader', 'screenshot', 'downloader', 'colorPalette', 'qrCode', 'twoFactor', 'passwordVault', 'pdfTools', 'fileVault'] },
  { label: '开发工具', names: ['netRequest', 'highPerfSql', 'flow', 'ttsTest', 'dataAcquisition', 'devToolbox'] },
  { label: '关于', names: ['about'] },
];

// 不可配置的路由（始终显示）
const lockedRoutes = ['setting', 'systemInfo', 'routeSetting'];

// 响应式刷新 key，用于强制更新菜单
const menuRefreshKey = ref(0);

const menuGroups = computed(() => {
  menuRefreshKey.value; // 依赖刷新 key，使 computed 响应式
  const savedConfig = getStore('routeSetting') || {};
  const visibleRoutes: Record<string, boolean> = savedConfig;

  return groupDefs
    .map(g => ({
      label: g.label,
      items: g.names
        .filter(name => {
          // 始终显示的路由（不可配置）
          if (lockedRoutes.includes(name)) {
            return true;
          }
          // 检查用户配置，未配置的默认显示
          return visibleRoutes[name] !== false;
        })
        .map(name => enrichedRouters.find(r => r.name === name))
        .filter(Boolean) as RouteRecordRaw[],
    }))
    .filter(g => g.items.length > 0); // 过滤空分组
});

// 监听路由配置变化事件
function handleMenuRefresh() {
  menuRefreshKey.value++;
}

/** 文件互传：对端发来文件落地后，即使不在文件互传页也弹蓝色路径通知 */
function handleFileReceived(
  _e: unknown,
  payload: { name: string; path: string; size: number; from: string },
) {
  fileNotify({ title: "收到文件", message: `来自 ${payload.from}`, filePath: payload.path });
}

onMounted(() => {
  window.addEventListener('route-setting-changed', handleMenuRefresh);
  // 文件互传：接收方收到文件后，即使不在文件互传页也弹蓝色路径通知
  window.ipcRenderer.on('file-transfer:received', handleFileReceived);
  // 预热快捷键注册页 chunk，避免首次进入时因懒加载编译/下载产生的「暂停」感
  // 与 router 中 () => import(...) 指向同一模块，Vite 复用同一 chunk
  const preload = () => import('@/views/registerShortcut/index.vue').catch(() => {});
  if (typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(preload, { timeout: 2000 });
  } else {
    setTimeout(preload, 0);
  }
});

onUnmounted(() => {
  window.removeEventListener('route-setting-changed', handleMenuRefresh);
  window.ipcRenderer.off('file-transfer:received', handleFileReceived);
});

const router = useRouter();
const route = useRoute();
const title = ref(route.meta?.title || '占位');

const { activeRouteName } = storeToRefs(useRuntimeVariables());
const { updateActiveRouteName } = useRuntimeVariables();

router.beforeEach((to, from, next) => {
  activeIndex.value = to.name || 'setting';
  next();
});

const activeIndex = ref<RouteRecordNameGeneric>(route.name || 'setting');

watch(activeRouteName, (newVal: string) => {
  if (!newVal || newVal == activeIndex.value) {
    return;
  }
  const cur = layoutRouters.find(item => item.name == newVal);
  if (cur) {
    activeIndex.value = cur.name;
    title.value = cur.meta?.title || '占位';
  }
}, {
  immediate: true,
  deep: true,
});

const toggleRoute = (item: RouteRecordRaw) => {
  activeIndex.value = item.name;
  title.value = item.meta?.title || '占位';
  router.push({ name: activeIndex.value });
};

const toHome = () => {
  router.push({ name: 'home', query: { from: 'setting' } });
};

// 主题切换
const themeStore = useTheme();
const { currentTheme } = storeToRefs(themeStore);
const { setTheme } = themeStore;

const themeSwitcherRef = ref<HTMLElement>();
const themeDropdownRef = ref<HTMLElement>();
const showThemeDropdown = ref(false);

const displayedThemes = computed(() => {
  const current = themeOptions.find(t => t.name === currentTheme.value);
  const others = themeOptions.filter(t => t.name !== currentTheme.value);
  const recommended = others[0] || null;
  const result: typeof themeOptions = [];
  if (current) result.push(current);
  if (recommended) result.push(recommended);
  return result;
});

const dropdownThemes = computed(() => {
  const displayedNames = displayedThemes.value.map(t => t.name);
  return themeOptions.filter(t => !displayedNames.includes(t.name));
});

function toggleThemeDropdown() {
  showThemeDropdown.value = !showThemeDropdown.value;
}

function handleDropdownThemeClick(name: string) {
  setTheme(name as ThemeName);
  showThemeDropdown.value = false;
}

function handleClickOutside(event: MouseEvent) {
  const target = event.target as HTMLElement;
  if (themeSwitcherRef.value && !themeSwitcherRef.value.contains(target)) {
    showThemeDropdown.value = false;
  }
}

onMounted(() => {
  document.addEventListener('click', handleClickOutside);
});

onUnmounted(() => {
  document.removeEventListener('click', handleClickOutside);
});

// ========== 侧边栏 / 顶部栏 可见性控制 ==========
const globalSettingStore = useGlobalSetting();
const { sidebarVisible, topbarVisible } = storeToRefs(globalSettingStore);
const { setSidebarVisible, setTopbarVisible } = globalSettingStore;
</script>

<style scoped lang="scss">
.layout-vue {
  height: 100%;
  width: 100%;
  position: relative;
}

/* ========== 顶部栏布局 ========== */
.header-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
}

.header-toggles {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.toggle-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: none;
  border-radius: var(--radius-btn);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition: background 0.2s, color 0.2s;

  &:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  &.is-off {
    color: var(--text-disabled);
    background: var(--bg-active-btn);
  }
}

/* 浮动恢复按钮 */
.float-restore-top {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 50;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  padding: 0;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-btn);
  background: var(--bg-card);
  color: var(--text-muted);
  cursor: pointer;
  box-shadow: var(--shadow-card);
  transition: background 0.2s, color 0.2s, transform 0.15s;

  &:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
    transform: scale(1.1);
  }

  &:active {
    transform: scale(0.95);
  }
}

.float-fade-enter-active,
.float-fade-leave-active {
  transition: all 0.2s ease;
}

.float-fade-enter-from,
.float-fade-leave-to {
  opacity: 0;
  transform: scale(0.8);
}

/* ========== 侧边栏菜单 ========== */
.sidebar-menu {
  flex: 1;
  overflow-y: auto;
  padding: 10px 8px;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 4px;

  // 滚动条
  &::-webkit-scrollbar { width: 3px; }
  &::-webkit-scrollbar-thumb {
    background: transparent;
    border-radius: 3px;
  }
  &:hover::-webkit-scrollbar-thumb {
    background: var(--scrollbar-thumb);
  }
}

.menu-group {
  display: flex;
  flex-direction: column;
  gap: 2px;

  // 非首组顶部加细线分隔
  & + & {
    padding-top: 8px;
    margin-top: 4px;
    border-top: 1px solid var(--border-group);
  }
}

.group-label {
  font-size: 0.68rem;
  font-weight: 700;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  padding: 4px 12px 6px;
  user-select: none;
}

.menu-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-radius: var(--radius-btn);
  cursor: pointer;
  transition: background 0.2s, color 0.2s, box-shadow 0.2s;
  user-select: none;
  color: var(--text-secondary);
  font-size: 0.86rem;
  font-weight: 500;
  line-height: 1.3;
  position: relative;

  .menu-icon {
    flex-shrink: 0;
    opacity: 0.65;
    transition: opacity 0.2s, color 0.2s;
  }

  .menu-text {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* hover 态 */
  &:hover {
    background: var(--bg-hover);
    color: var(--text-primary);

    .menu-icon { opacity: 0.9; }
  }

  /* active 态 */
  &.is-active {
    background: var(--color-primary-light);
    color: var(--color-primary-solid);
    font-weight: 600;

    // 左侧指示条
    &::before {
      content: '';
      position: absolute;
      left: 0;
      top: 50%;
      transform: translateY(-50%);
      width: 3px;
      height: 18px;
      border-radius: 0 3px 3px 0;
      background: var(--color-primary);
      transition: height 0.2s;
    }

    .menu-icon {
      color: var(--color-primary);
      opacity: 1;
    }
  }

  /* active + hover */
  &.is-active:hover {
    background: var(--color-primary-hover);
  }
}

/* ========== 主题切换器 ========== */
.theme-switcher {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-top: 1px solid var(--border-subtle);
  user-select: none;
  position: relative;
}

.theme-label {
  font-size: 0.72rem;
  font-weight: 600;
  color: var(--text-muted);
  letter-spacing: 0.03em;
}

.theme-options {
  display: flex;
  gap: 6px;
}

.theme-dot {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: 2px solid var(--dot-bg);
  background: transparent;
  cursor: pointer;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: border-color 0.2s, box-shadow 0.2s, transform 0.15s;

  .dot-inner {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    display: block;
    background: linear-gradient(135deg, var(--dot-card) 50%, var(--dot-primary) 50%);
    transition: transform 0.15s;
  }

  &:hover {
    transform: scale(1.15);
    border-color: var(--dot-primary);
  }

  &.is-active {
    border-color: var(--dot-primary);
    box-shadow: 0 0 0 2px var(--dot-primary);

    .dot-inner {
      transform: scale(1.1);
    }
  }
}

.theme-more {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: none;
  background: transparent;
  cursor: pointer;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: background 0.2s, transform 0.15s;

  .more-icon {
    font-size: 12px;
    color: var(--text-muted);
    transition: color 0.2s;
    line-height: 1;
  }

  &:hover {
    background: var(--bg-hover);

    .more-icon {
      color: var(--text-primary);
    }
  }

  &.is-open {
    background: var(--bg-active-btn);

    .more-icon {
      color: var(--color-primary);
    }
  }
}

.theme-dropdown {
  position: absolute;
  bottom: calc(100% + 8px);
  right: 8px;
  width: 160px;
  max-height: 280px;
  overflow-y: auto;
  background: var(--bg-card);
  border-radius: var(--radius-card);
  box-shadow: var(--shadow-card);
  border: 1px solid var(--border-subtle);
  padding: 4px;
  z-index: 100;

  &::-webkit-scrollbar {
    width: 4px;
  }
  &::-webkit-scrollbar-thumb {
    background: var(--scrollbar-thumb);
    border-radius: 2px;
  }
  &::-webkit-scrollbar-track {
    background: transparent;
  }
}

.dropdown-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-radius: var(--radius-btn);
  cursor: pointer;
  transition: background 0.2s;

  &:hover {
    background: var(--bg-hover);
  }

  &.is-active {
    background: var(--color-primary-light);
  }
}

.dropdown-dot {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  flex-shrink: 0;
  display: inline-block;
  border: 2px solid var(--dot-bg);
  background: linear-gradient(135deg, var(--dot-card) 50%, var(--dot-primary) 50%);
}

.dropdown-label {
  font-size: 0.82rem;
  color: var(--text-secondary);
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;

  .dropdown-item.is-active & {
    color: var(--color-primary-solid);
    font-weight: 600;
  }
}

.dropdown-enter-active,
.dropdown-leave-active {
  transition: all 0.2s ease;
}

.dropdown-enter-from,
.dropdown-leave-to {
  opacity: 0;
  transform: translateY(8px) scale(0.98);
}
</style>

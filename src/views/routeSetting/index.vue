<template>
  <div class="route-setting-page">
    <div class="page-header">
      <h2>路由配置</h2>
      <p>自定义侧边栏菜单的显示与隐藏</p>
    </div>

    <div class="config-container">
      <div v-for="group in menuGroupDefs" :key="group.label" class="config-group">
        <h3 class="group-title">{{ group.label }}</h3>
        <div class="route-list">
          <div
            v-for="item in group.items"
            :key="item.name"
            class="route-item"
            :class="{ 'is-locked': isLockedRoute(item.name) }"
          >
            <div class="route-info">
              <LucideIcon class="route-icon" :name="item.meta?.icon || 'settings'" :size="20" />
              <div class="route-text">
                <span class="route-name">{{ item.meta?.title }}</span>
                <span class="route-path">{{ item.path }}</span>
              </div>
            </div>
            <div class="route-action">
              <el-switch
                :model-value="isRouteVisible(item.name)"
                :disabled="isLockedRoute(item.name)"
                @change="toggleRoute(item.name, $event)"
              />
              <el-tag v-if="isLockedRoute(item.name)" size="small" type="info">锁定</el-tag>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="page-footer">
      <el-button type="primary" @click="saveConfig" :loading="saving">保存配置</el-button>
      <el-button @click="resetConfig">重置为默认</el-button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { ElMessage } from 'element-plus';
import { layoutRouters, RouteNames } from '@/router';
import { getStore, setStore } from '@/utils/common';
import { RouteRecordNameGeneric } from 'vue-router';
import LucideIcon from '@/components/LucideIcon.vue';
import { iconMap } from '@/utils';

// 为每个路由注入图标到 meta
const enrichedRouters = layoutRouters.map(r => ({
  ...r,
  meta: { ...r.meta, icon: iconMap[r.name as string] || 'settings' },
}));

// 不可配置的路由（始终显示）
const lockedRoutes = ['setting', 'systemInfo', 'routeSetting'];

// 菜单分组定义
interface MenuGroup {
  label: string;
  names: string[];
}

const groupDefs: MenuGroup[] = [
  { label: '通用', names: ['setting', 'newTips', 'homeMode', 'windowMode'] },
  { label: '系统与资源', names: ['systemInfo', 'routeSetting', 'appCache', 'backup', 'fileRela', 'resourceManage', 'safetyProtection', 'sync', 'fileTransfer'] },
  { label: '效率工具', names: ['pomodoroRecord', 'clipboard', 'notebookApp', 'categorizableNotes', 'todoList', 'habit', 'countdown', 'accounting', 'stock', 'earning', 'resume', 'registerShortcut', 'function', 'weather', 'browser', 'ebookReader', 'screenshot', 'downloader', 'qrCode'] },
  { label: '开发工具', names: ['netRequest', 'flow', 'highPerfSql', 'ttsTest', 'dataAcquisition', 'devToolbox'] },
  { label: '关于', names: ['about'] },
];

// 用户配置
const routeConfig = ref<Record<string, boolean>>({});
const saving = ref(false);

// 菜单分组（带路由详情）
const menuGroupDefs = computed(() => {
  return groupDefs.map(g => ({
    label: g.label,
    items: g.names
      .map(name => enrichedRouters.find(r => r.name === name))
      .filter(Boolean) as typeof enrichedRouters,
  }));
});

// 判断路由是否锁定
function isLockedRoute(name: string | RouteRecordNameGeneric): boolean {
  if (!name) {
    return false;
  }
  // 修复：确保 name 是 string 类型后再进行 includes 判断
  if (typeof name !== 'string') {
    return false;
  }
  return lockedRoutes.includes(name);
}

// 判断路由是否可见
function isRouteVisible(name: string | RouteRecordNameGeneric): boolean {
  // 类型守卫：确保 name 是 string 类型
  if (typeof name !== 'string') {
    return true; // 非字符串名称（如 symbol/undefined）默认可见或根据业务逻辑处理
  }
  // 锁定的路由始终可见
  if (isLockedRoute(name)) {
    return true;
  }
  
  // 未配置的路由默认可见
  if (routeConfig.value[name] === undefined) {
    return true;
  }
  return routeConfig.value[name];
}

// 切换路由可见性
function toggleRoute(name: string | RouteRecordNameGeneric, visible: boolean) {
  // 类型守卫：如果 name 不是字符串，直接返回，避免后续逻辑错误
  if (typeof name !== 'string') {
    console.warn('尝试切换非字符串名称的路由:', name);
    return;
  }
  if (isLockedRoute(name)) {
    return;
  }
  routeConfig.value[name] = visible;
}

// 加载配置
function loadConfig() {
  const savedConfig = getStore('routeSetting');
  if (savedConfig && typeof savedConfig === 'object') {
    routeConfig.value = { ...savedConfig };
  }
}

// 保存配置
function saveConfig() {
  saving.value = true;
  try {
    setStore('routeSetting', routeConfig.value);
    ElMessage.success('配置已保存');
    // 通知 layout 刷新菜单
    window.dispatchEvent(new CustomEvent('route-setting-changed'));
  } catch (error) {
    console.error('保存配置失败:', error);
    ElMessage.error('保存配置失败');
  } finally {
    saving.value = false;
  }
}

// 重置配置
function resetConfig() {
  routeConfig.value = {};
  setStore('routeSetting', {});
  ElMessage.success('已重置为默认配置');
  // 通知 layout 刷新菜单
  window.dispatchEvent(new CustomEvent('route-setting-changed'));
}

onMounted(() => {
  loadConfig();
});
</script>

<style scoped lang="scss">
.route-setting-page {
  width: 100%;
  height: 100%;
  // background: var(--bg-base);
  display: flex;
  flex-direction: column;
  gap: 16px;
  // padding: 20px 24px;
  box-sizing: border-box;
  overflow: auto;
}

.page-header {
  .page-header-title {
    margin: 0 0 4px;
  }

  h2 {
    margin: 0;
    font-size: 22px;
    font-weight: 700;
    color: var(--text-primary);
  }

  p {
    margin: 4px 0 0;
    font-size: 13px;
    color: var(--text-muted);
  }
}

.config-container {
  flex: 1;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.config-group {
  background: var(--bg-card);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-card);
  padding: 16px;

  .group-title {
    margin: 0 0 12px;
    font-size: 14px;
    font-weight: 600;
    color: var(--text-primary);
    padding-bottom: 8px;
    border-bottom: 1px solid var(--border-subtle);
  }
}

.route-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.route-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px;
  background: var(--bg-base);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-btn);
  transition: all 0.2s ease;

  &:hover {
    border-color: var(--color-primary);
    box-shadow: 0 2px 8px rgba(99, 102, 241, 0.1);
  }

  &.is-locked {
    background: var(--bg-hover);
    opacity: 0.7;

    &:hover {
      border-color: var(--border-subtle);
      box-shadow: none;
    }
  }
}

.route-info {
  display: flex;
  align-items: center;
  gap: 12px;

  .route-icon {
    font-size: 20px;
    color: var(--text-secondary);
  }

  .route-text {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .route-name {
    font-size: 14px;
    font-weight: 500;
    color: var(--text-primary);
  }

  .route-path {
    font-size: 12px;
    color: var(--text-muted);
  }
}

.route-action {
  display: flex;
  align-items: center;
  gap: 8px;
}

.page-footer {
  flex-shrink: 0;
  display: flex;
  justify-content: flex-end;
  gap: 12px;
  padding-top: 16px;
  border-top: 1px solid var(--border-subtle);
}
</style>
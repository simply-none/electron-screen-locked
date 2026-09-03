<script setup lang="ts">
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import { useRouter, useRoute } from 'vue-router';
import { storeToRefs } from 'pinia';
import { watch, ref } from 'vue';
import useOpenWindow from '@/hooks/useOpenWindow';
import useRuntimeVariables from '@/store/useRuntimeVariables';
import useTheme from '@/store/useTheme';
import { layoutRouters, RouteNames } from '@/router';
import { ElMessageBox } from 'element-plus';
import { sysNotify, appNotify } from '@/utils/notify';
import useWindowMode from '@/store/useWindowMode';
import { isHabitReminderId } from '@/store/useHabit';
import useFileVault, { type CliPendingItem } from '@/views/fileVault/store/useFileVault';
import FileVaultCliHandler from '@/views/fileVault/components/FileVaultCliHandler.vue';

const router = useRouter()
const route = useRoute()
const { activeRouteName } = storeToRefs(useRuntimeVariables())
const { updateActiveRouteName } = useRuntimeVariables()

// 主题切换 — 将 data-theme 设置到 html 根元素
const { currentTheme } = storeToRefs(useTheme())
watch(currentTheme, (theme) => {
  document.documentElement.setAttribute('data-theme', theme)
}, { immediate: true })

// 路由过渡动画控制
const layoutRouteNames = new Set(layoutRouters.map(r => r.name))
const transitionName = ref(route.name === 'home' ? '' : 'page-fade')
router.beforeEach((to, from, next) => {
  const fromIsHome = from.name === 'home'
  const fromIsLayout = layoutRouteNames.has(from.name)
  const toIsLayout = layoutRouteNames.has(to.name)
  // 从 home 出发、或从设置页离开到其他页面，无动画
  transitionName.value = fromIsHome || (fromIsLayout && !toIsLayout) ? '' : 'page-fade'
  next()
})

// 使用不同窗口打开时分别处理的hook
useOpenWindow()

// 定时提醒触发：弹通知；若开启「结束后记录」则跳转到主题对话并记录情绪。
// 仅主窗口处理，避免第二窗口重复弹通知/跳转。
const isSecondWindow = location.href.includes('isSecondWindow=true');
if (!isSecondWindow) {
  window.ipcRenderer.on('tips-trigger', (event, reminder: any) => {
    const title = reminder?.title || '提醒';
    const content = reminder?.content || `${title}提醒到了`;

    // 托盘气泡提醒（Windows）：应用收在托盘时也能看到提醒
    window.ipcRenderer.send('tray-balloon', { title, content });

    // 习惯提醒（id 形如 habit:<key>#<序号>）：到点唤起打卡小窗，点通知也能再唤出
    const isHabit = isHabitReminderId(reminder?.id);
    const openHabitWindow = isHabit
      ? () => useWindowMode().openHabitWindow()
      : undefined;
    sysNotify(title, content, '', 3, openHabitWindow);
    appNotify(title, content, 5000, openHabitWindow);
    if (isHabit) openHabitWindow?.();

    if (reminder?.recordAfter) {
      router.push({
        name: RouteNames.THEME_CONVERSATION,
        query: {
          recordReminder: reminder.title,
          rt: String(reminder.triggerTime || Date.now()),
        },
      });
    }
  });

  // 待办截止提醒触发：弹系统/站内通知（点击行为与原提醒一致）
  window.ipcRenderer.on('todo-reminder-trigger', (event, todo: any) => {
    const title = `待办提醒：${todo?.title || '待办事项'}`;
    const content = todo?.dueDate ? `即将到期（截止 ${todo.dueDate}）` : '即将到期';
    window.ipcRenderer.send('tray-balloon', { title, content });
    sysNotify(title, content, '');
    appNotify(title, content, 5000);
  });

  // 轮次（stateful）状态进入提醒：主进程「真实进入新状态」（emitStatefulEnter / emitStatefulEvent）走
  // tips-state-change（channel A）下发；仅该通道代表「状态进入=提醒到了」，直接弹系统+应用内通知。
  // 状态同步（补偿/恢复/停止）走独立的 tips-state-sync（channel B），不会触发本监听，故不在「打开提醒页/启动」时误弹。
  window.ipcRenderer.on('tips-state-change', (event, arg: any) => {
    if (!arg || !arg.reminderId) return;
    const title = arg.title || '提醒';
    const content = arg.content || `${arg.stateLabel || ''}提醒到了`;
    window.ipcRenderer.send('tray-balloon', { title, content });
    sysNotify(title, content, '');
    appNotify(title, content, 5000);
  });

  // 倒计时结束提醒：弹系统/站内通知；点击打开倒计时主页
  window.ipcRenderer.on('countdown-finished', (event, payload: any) => {
    const title = `倒计时结束：${payload?.name || '倒计时'}`;
    const content = payload?.name ? `「${payload.name}」时间到` : '倒计时时间到';
    window.ipcRenderer.send('tray-balloon', { title, content });
    const openCountdown = () => router.push({ name: RouteNames.COUNTDOWN });
    sysNotify(title, content, '', 3, openCountdown);
    appNotify(title, content, 5000, openCountdown);
  });

  // 资源管理器右键菜单：接收文件参数，交给全局处理器直接弹对应对话框（不跳转保险箱页面）
  window.ipcRenderer.on('app:cli-open', (_e, item: CliPendingItem) => {
    useFileVault().setPendingCli(item);
  });
  // 告知主进程渲染端已就绪，可下发排队中的右键文件参数（解决首启竞态）
  window.ipcRenderer.send('app:cli-ready');
}

// 监听事件
window.ipcRenderer.on('open-match-page', (event, url) => {
  router.push({
    name: url,
  })
  updateActiveRouteName(url)
})

// 监听确认隐藏窗口事件
window.ipcRenderer.on('confirm-hide-app', (event, confirm) => {
  if (confirm) {
    // 使用elMessageBox.confirm
    ElMessageBox.confirm('确定要隐藏应用吗？', '提示', {
      confirmButtonText: '确定',
      cancelButtonText: '取消',
      type: 'warning',
    }).then(() => {
      // 确认隐藏应用,发送给主进程处理
      window.ipcRenderer.send("hide-app");
    }).catch(() => {
      // 取消隐藏应用
    });
  } else {
    // 拒绝隐藏应用
    // ...
  }
})



</script>

<template>
  <router-view v-slot="{ Component }">
    <el-config-provider :locale="zhCn">
      <transition :name="transitionName" mode="out-in">
        <component :is="Component" />
      </transition>
    </el-config-provider>
  </router-view>

  <!-- 资源管理器右键菜单全局处理器：直接弹加密/解密/安全删除对话框，不跳转保险箱页 -->
  <FileVaultCliHandler />
</template>

<style lang="scss">
html,
body,
#app {
  margin: 0;
  padding: 0;
  width: 100%;
  height: 100%;
}

/* ========== 路由切换动画 ========== */
.page-fade-enter-active,
.page-fade-leave-active {
  transition: opacity 0.22s ease, transform 0.22s ease;
}

.page-fade-enter-from {
  opacity: 0;
  transform: translateY(6px);
}

.page-fade-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

/* ========== 通用工具类 ========== */
.page {
  width: 100%;
  height: 100%;
  padding: 12px;
  box-sizing: border-box;

  &-container {
    width: 100%;
    height: 100%;
    padding: 12px;
    overflow-y: auto;
    box-sizing: border-box;
  }
}

.flex-center {
  display: flex;
  align-items: center;
  justify-content: center;
}

.logo {
  height: 6em;
  padding: 1.5em;
  will-change: filter;
  transition: filter 300ms;
}
</style>

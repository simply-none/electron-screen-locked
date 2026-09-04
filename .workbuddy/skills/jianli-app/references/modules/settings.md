# 全局设置 (setting)

## 职责
聚合应用级全局设置：番茄钟开关与状态、启动项、主题/字体/配色、是否启用主页模式、缓存清理等，数据集中在 `useGlobalSetting` 落 `basic_info`。

## 关键文件
- 页面：`src/views/setting/index.vue`（番茄钟设置区块等）、`cacheSet.vue`（缓存清理）
- 安全与隐私区块：`src/views/setting/components/AppLockSetting.vue`（应用锁 + 2FA 门禁行 + 关闭双因子弹窗）、`TwoFactorGateWizard.vue`（门禁注册/恢复码向导，见 `app-lock.md`）
- 核心 store：`src/store/useGlobalSetting.ts`（大量 `setStore` 字段：`curStatus`、`isStartup`、`sidebarVisible`、`appBgColor`、`globalFont`、`homeMode` 等，见 `:86-289`）
- 主题：`src/store/useTheme.ts`（`STORE_KEY` 经 `get/setStore`）

## 路由
- `RouteNames.SETTING` → `/setting`

## 用到的 IPC 通道
- `get-store` / `set-store`（绝大多数开关经 `common.setStore` 落 `basic_info`）
- `set-startup`（渲染→主，开启/关闭开机自启，`useGlobalSetting.ts:154`）
- `sync-data-to-other-window`（主进程就绪后广播全局配置，`:512`）
- `quit-app`（渲染→主，退出应用，`setting/index.vue`）
- `get-fonts`（渲染→主，拉系统字体列表）

## 复用 / 集成点
- **全局单一状态源**：几乎所有模块（homeMode、windowMode、番茄钟、主题）都读 `useGlobalSetting` 的字段，改动会经 `setStore` 落到 `basic_info` 并广播。
- **小窗配置无关**：小窗自身配置在 `window-mode:xxx`，不在此页；此页管的是「应用级」开关。

## 特有坑 / 注意
- **改主进程才生效的开关**：`set-startup`（开机自启）走主进程 `autoStartup`，改 `electron/main/module/autoStartup.ts` 须重启 Electron。
- **`initPiniaStatus` 初始化**：`useGlobalSetting` 用 `initPiniaStatus(allVars)` 把 `basic_info` 键映射成响应式变量，新增持久化字段务必同时加入 `boolVars/objectVars` 与 `setXxx` 写回，否则不落库。
- **`homeMode` 整树提交**：调用 `setHomeMode(obj)` 要传完整结构（见 home-mode 文档），只传部分字段会覆盖其余配置。
- **字体/主题类走主进程**：`get-fonts`、主题切换涉及 preload 暴露能力，渲染端禁止 `import electron/*`。

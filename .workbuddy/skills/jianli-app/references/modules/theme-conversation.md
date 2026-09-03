# 主题对话 (themeConversation)

## 职责
主题对话（记录情绪/主题笔记）的主页面与常驻小窗，数据自管（不碰番茄钟/习惯落库路径），同时作为 habit 链式动作的目标之一。

## 关键文件
- 主页面：`src/views/themeConversation/index.vue`（薄壳，挂 `components/ThemeConversationPage.vue`）
- 小窗：`src/views/themeConversationMiniWindow/index.vue`（挂同一 `ThemeConversationPage`，`compact` 模式）
- 页面逻辑：`src/views/themeConversation/components/ThemeConversationPage.vue`
- 左侧主题列表：`src/views/themeConversation/components/ThemeList.vue`（新建/编辑/删除/右键菜单/导出入口）
- composables：`src/views/themeConversation/composables/useThemeConversation.ts`、`richText.ts`
- 数据层：`src/views/themeConversation/db.ts`（封装 `new-sql:query/insert/update/delete/execute`）
- 导出 Markdown：`src/views/themeConversation/utils/exportMarkdown.ts`
- 勾选导出弹窗：`src/views/themeConversation/components/ExportThemesDialog.vue`

## 路由
- `RouteNames.THEME_CONVERSATION` → `/themeConversation`
- `RouteNames.THEME_CONVERSATION_MINI` → `/themeConversationMini`（路径须与 `open-new-window` 的 arg 一致）

## 用到的 IPC 通道
- `new-sql:query` / `new-sql:insert` / `new-sql:update` / `new-sql:delete`（渲染→主，主题对话表，自增 `id` 主键）
- `new-sql:execute`（跨表搜索等复杂查询，`db.ts:64` 的 `dbExecute`）
- 小窗四件套：`open/close-new-window`(`themeConversationMini`)、`sync-data-to-other-window`、`disable/enable-mouse-click-through`、`get/set-store`
- **`export-text-to-cache`**（渲染→主，同步 `ipcMain.on` + `e.returnValue`，复用 `export-data-to-json` 范式）：把纯文本（Markdown 等）直接写入缓存目录，**不弹保存框**。入参 `{ text, filename, dir? }`，返回 `{ success, path?, message? }`。目录优先级：`dir`（渲染端 `fileCachePathC`）→ electron-store `fileCachePath` 设置项 → 用户文档目录。实现见 `electron/main/module/dialog.ts` 的 `exportTextToCache`。
- 主题切换走 `useTheme` 的 `get/setStore`（见 `themeConversationMiniWindow/index.vue:33` 的 `applyTheme`）

## 复用 / 集成点
- **提醒引擎联动**：提醒设 `recordAfter=1` 时，`App.vue` 自动跳到本页记录情绪。
- **habit 链式动作目标**：`src/views/habit/chainActions/actions/themeConversationAction.ts` 打卡后追加一条主题对话记录。
- **小窗四件套**：配置在 `windowSections.ts:213`（key=`themeConversation`，storeKey=`themeConversationMini`）。

## 特有坑 / 注意
- **`cloneForIpc` 防结构化克隆失败**：`db.ts:23` 用 `JSON.parse(JSON.stringify())` 剥离 Vue Proxy，否则传 reactive 数组（如 `form.tags`）会抛 `DataCloneError`。调用 `dbXxx` 前务必过这一层。
- **小窗鼠标穿透**：`themeConversationMiniWindow/index.vue` 用左右 `mouse-* click-through` 控制，常驻需 `mouseEvents:true`。
- **主题与皮肤区分**：小窗双击切的是「皮肤」(`data-skin` 属性)，与 `useTheme` 的全局主题名（`STORE_KEY`）是两套键，别混写。

## 导出 Markdown（主题对话 → .md）
- **入口 1（单主题）**：左侧主题列表右键菜单「导出所有」→ `ThemeList.ctxExportAll` → `exportThemeToMarkdown(theme, dir)`。
- **入口 2（多主题）**：头部「导出主题」按钮（Download 图标，在「新建主题」右侧）→ `ExportThemesDialog` 勾选 → `onExportConfirm` → `exportThemesToMarkdown(themes, dir)`，合并为单个 .md 文件（各主题以 `#` 大标题分隔）。
- **直写缓存、不弹窗**：落盘走主进程 `export-text-to-cache` IPC（见上「IPC 通道」），不再用 `net-request:save-file` 弹保存框；目录默认 `fileCachePath`（渲染端 `fileCachePathC` 透传），缺省回退到设置项/文档目录。成功提示统一用 `src/utils/fileNotify.ts` 的 `fileNotify({ title, filePath })`——蓝色可点击路径，点击经 `open-file-in-assets-manager` 在资源管理器打开并选中文件。
- **数据依赖**：复用组合式 `getConversationsByTheme(themeId)`、`tagName`、`parseArr`；导出时过滤软删除（`is_deleted='1'`）。

### 导出格式说明（.md 结构，供后续复用 / 改动参考）
- **文件名**：单主题 `主题-<标题>_<YYYYMMDD_HHmmss>.md`；多主题 `主题对话导出_<YYYYMMDD_HHmmss>.md`（`<标题>` 经 `sanitizeName` 去非法字符并截断 40 字）。
- **单主题结构**：
  ```
  # <主题标题>
  <创建时间> ｜ <更新时间> ｜ 主题标签：<标签名> ｜ 对话数：N
  ---
  ### 对话 · <create_time>
  <正文：is_rich='1' 经 htmlToMarkdown 转换；'0' 纯文本原样>
  > 标注 <时间> ｜ 标签 <名> ｜ 引用 N 条 ｜ 跨主题 N 条
  ---   （对话间分隔）
  ```
- **内容转换**：`is_rich='1'` 走 `htmlToMarkdown()`（轻量 HTML→Markdown，覆盖 quill 常见标签 h1-6/ul-ol-li/blockquote/strong-em-code/a/br）；`'0'` 纯文本原样保留换行；标签经 `tagName(id)` 解析为名称；残留 HTML 实体做解码与换行压缩。
- **多主题**：各主题块以 `\n\n---\n\n` 拼接为单个文件。

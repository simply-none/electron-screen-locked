---
name: jianli-app
description: 本技能用于开发、维护、扩展「渐离App」(jianli-app) —— 一个 Electron + Vue3 + TypeScript + Vite 桌面效率应用。当任务涉及该项目的任意模块（习惯打卡、番茄钟、待办、剪贴板、笔记、电子书、股票、截图、小窗、提醒引擎、命令面板、调色板、数据层等）、需要理解架构/进程边界/IPC 通道/小窗四件套/复用模式，或要新增功能、排查已知雷区时，使用本技能。
agent_created: true
---

# 渐离App 项目开发技能（jianli-app）

## 这是什么
封装「渐离App」整个桌面应用的架构、约定、IPC 契约、复用模式与逐模块知识，让 AGENTS 在本项目里能按既定模式开发、维护、扩展功能，并避开已知雷区。它不是运行时功能，而是「开发该应用的知识库」——把散落在代码与记忆里的工程约定固化下来，供后续会话按需加载。

## 何时使用
- 任务涉及本项目任意模块（习惯打卡 / 番茄钟 / 待办 / 剪贴板 / 笔记 / 电子书 / 股票 / 截图 / 小窗 / 提醒 / 命令面板 / 调色板 / 数据层 …）。
- 需要理解：进程边界、改主进程要不要重启、IPC 通道怎么对接、小窗怎么加、某个注册表怎么扩。
- 要新增功能、重构功能、排查问题、排查「发了 IPC 没反应」、避免 newSql / 穿透 / 破表等历史坑。
- **数据层操作 / 双 SQL 层合并**：建表、读写业务数据、多库选择、旧层调用迁移，见「参考文档导航」中的 `sql-db-ops.md` 与 `sql-merge-plan.md`。
- **把功能移植到 Flutter 移动端（Android/iOS）、跨端复用 db.sqlite、类 LocalSend 局域网同步**：见下方「Flutter 移动端移植计划」与 `references/flutter-port.md`。

## 全局红线（先读，违反必踩雷）
1. 渲染端**禁止 `import electron/*`（含类型）**；一切系统 / 磁盘 / 库操作走 IPC。
2. 改主进程（`electron/**`）**必须重启 Electron**；改渲染端（`src/**`）热重载即可。
3. 业务数据走 newSql 的 `query`/`upsert`/`delete`；❌ **严禁裸 `new-sql:execute`**（确需用 SQL 时先读 `references/db-pitfalls.md`，execute 有自动建表劫持结构、PRAGMA 拿不到结果、SELECT 结果在 data.rows 三个必避的坑）。
4. SQLite 补主键 = `ADD COLUMN key TEXT` + `CREATE UNIQUE INDEX`（不能 `ALTER` 加 PK）。
5. 常驻小窗必须 `mouseEvents:true`，否则鼠标穿透点不动 / 拖不动。
6. 小窗路由 path 名**必须**与主进程 `createOtherWindow` 的 `arg` 一致。
7. 新需求开发/功能重构采用**原子化、组件化、功能化**拆解构建：单文件职责单一、体量可控，禁止把一堆功能堆成一个超大文件（与项目 `AGENTS.md`「功能注意分割，防止代码文件过大」一致）；每个功能 / 组件需带注释。
8. 新需求开发落地清单（接入菜单与小窗）：
   - **必备**：① 在侧边栏 `src/layout/index.vue` 添加菜单入口；② 在路由配置页 `src/views/routeSetting/index.vue` 添加该菜单的「可见开关」，让用户在设置里可隐藏 / 显示该菜单。
   - **可选**：若需常驻浮动交互，再按小窗四件套加一个小窗（见 `references/mini-window.md` / `references/modules/small-window.md`），且必须 `mouseEvents:true` 并遵循路径一致性红线（第 6 条）。
9. 每次修改都必须同步更新对应模块的文档 `references/modules/<模块>.md`
10. **导出统一规范（见 `references/export.md`，新增导出功能前必读）**：所有「导出 / 保存文件到磁盘」走统一入口 `src/utils/exportToFile.ts`（`exportTextToCache` / `exportBufferToCache`）；**不弹系统保存框、默认直写缓存目录 `fileCachePath`、成功用 `src/utils/fileNotify.ts` 的 `fileNotify` 提示（蓝色可点击路径）**；安全敏感导出（2FA 密钥库 / 文件保险库解密）保留用户选位置，仅把成功提示换成 `fileNotify`。

## 参考文档导航
- 架构总览：`references/architecture.md`
- 数据层约定：`references/data-layer.md`
- SQL 数据库操作（统一数据层 newSql）：`references/sql-db-ops.md`
- 双 SQL 层合并设计：`references/sql-merge-plan.md`
- 数据库踩坑指南（写库前必读）：`references/db-pitfalls.md`
- IPC 通道契约：`references/ipc-channels.md`
- 导出统一规范（落盘/命名/反馈/红线）：`references/export.md`
- 小窗机制与四件套：`references/mini-window.md`
- 通用复用模式：`references/patterns.md`
- 主题与视觉约定（token 清单 / 严禁硬编码 / 禁用未全覆盖的 --el-* / 派生色用 color-mix）：`references/theme.md`
- 已知差异与风险：`references/risks.md`
- Flutter 移动端移植计划（跨端 / 双端同步）：`references/flutter-port.md`
- 逐模块文档（`references/modules/`，处理具体模块前先读对应文件）：
  - **效率 / 提醒类**：`habit` `reminder` `todo` `pomodoro` `countdown` `command-palette` `theme-conversation` `window-mode` `shortcut` `home-mode` `route-setting` `settings` `quick-note` `sticker` `app-lock` `two-factor` `file-vault`
  - **内容 / 数据类**：`clipboard` `notebook` `categorizable-notes` `ebook-reader` `accounting` `stock` `flow` `function` `color-palette` `resume`
  - **系统 / 工具类**：`system-info` `weather` `crawler` `spider` `high-perf-sql` `file-rela` `resource-manage` `screenshot` `browser` `downloader` `about` `safety-protection` `app-cache` `backup` `tts` `small-window` `home` `data-acquisition` `dev-toolbox` `qr-code` `sync`

## 使用方式
1. 接到本项目任务，先判断属于「架构 / 数据 / IPC / 小窗 / 复用模式」哪一类，读对应核心参考。
2. 锁定到具体模块，读 `references/modules/<模块>.md` 拿到入口文件、store、路由、用到的 IPC、特有坑。
3. 需要新增能力时，优先复用既有模式（命令面板 REGISTRY、链式动作 registry、小窗四件套、提醒引擎 `syncReminders`），不要另起炉灶。
4. 所有文档用中文；发现与代码不符，请直接更新对应文档，保持 skill 与代码同步。

## 维护说明
- 本 skill 是「项目知识基线」，随代码演进而更新。每次大改动后同步 `risks.md` 与对应模块文档。
- 新增模块时：在 `references/modules/` 加一份文档，并在上方「逐模块文档」导航里补一行。

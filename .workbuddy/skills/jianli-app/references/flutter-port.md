# Flutter 移动端移植计划（flutter-port）

> 本文件记录把渐离 App 部分功能移植到 Flutter（Android + iOS）的方向、数据映射与双端同步设计。
> 与 Electron 版的差异见 `architecture.md` / `risks.md`；本文件聚焦「跨端移植」这一新方向。

## 0. 范围与目标
- 平台：**Android + iOS**（移动端）。注意系统级能力受限：系统截图监听、剪贴板常驻监听、悬浮小窗、全局热键、资源管理器右键菜单在移动端不可用/需重设计。
- 首批功能：习惯打卡 / 番茄钟 / 待办 / 电子书阅读器 / 2FA / 主题对话 / 截图记录 / 可归类笔记 / 私密文件保险箱。
- 数据策略：**复用现有 `db.sqlite`**（表结构 + 加密必须对齐），并规划一个类 LocalSend 的局域网双端同步（先计划，后续再做）。

## 1. 环境现状（P0 前置）
- 本机当前 **未安装 Flutter / Dart**（`flutter --version` 报 `command not found`）。这是硬前置，第一步。
- 需安装：Flutter SDK + Dart、Android Studio（Android SDK / 模拟器）、Xcode（Mac 上跑 iOS 模拟器）。
- 工程结构：feature-first，`lib/features/<module>/`（api · models · repositories · components · composables · utils），延续 AGENTS.md「功能分割 + 注释」约定。

### 国内镜像安装方案（CERNET → 南京大学镜像）
- 文档：https://help.mirrors.cernet.edu.cn/flutter/ （cernet 域名会 302 重定向到 NJU 镜像，文件实际在 NJU）
- 下载基址：`https://mirrors.cernet.edu.cn/flutter/flutter_infra/releases/stable/windows/`
- 稳定版包（2026-09-04）：`flutter_windows_3.47.2-stable.zip`（约 1.8 GB），解压到 `C:\src\flutter`
- 环境变量（持久化到用户环境，写注册表）：
  - `FLUTTER_STORAGE_BASE_URL=https://mirrors.cernet.edu.cn/flutter`
  - `PUB_HOSTED_URL=https://mirrors.cernet.edu.cn/dart-pub/`
  - 用户 PATH 追加 `C:\src\flutter\bin`
- 验证：`C:\src\flutter\bin\flutter.bat --version` / `flutter doctor`（缺 Android Studio / Xcode / Visual Studio 属预期，是后续移动端工具链，不在 SDK 安装范围）

## 2. 加密红线（最高风险，先做 PoC）
统一加密在 `electron/main/module/vault/crypto.ts`：**AES-256-GCM + PBKDF2(iter=200000)**，泛型，主进程内存只驻留明文。
**关键事实（已从 db 验证）**：2FA 与密码保险箱数据**不在 SQLite 行里**，而是加密的 **vault 文件**，其路径写在 `basic_info`：
- `twoFactorVaultPath` → 2FA 保险库文件（设备绑定主密钥）
- `passwordVaultPath` → 密码保险库文件（设备绑定主密钥）
- `appLockVault` → 应用锁哨兵（直接存在 `basic_info.value`）
- 股票 API Key → `stockVault`（设备绑定，本次首批未含股票）

Flutter 必须：
1. 复刻 vault 文件格式与派生参数（AES-256-GCM + PBKDF2 iter=200000）。
2. 读 `basic_info` 里的 vault 路径，打开并解密文件（注意设备绑定密钥不能直接跨设备用）。
3. **解密 PoC 通过前，不要动任何依赖 vault 的功能**（2FA / 密码库 / 文件保险箱）。
包选型：`cryptography` / `encrypt`。

## 3. 数据层映射（从 db.sqlite 实测）
> 表结构来自 `C:\Users\风起\Downloads\测试\db.sqlite`（共 69 张表）。业务表主键两类：自增 `INTEGER` 或 `key TEXT`。
> 迁移建议用 **drift**，并按 `key`/`id` 做幂等 upsert（天然利于后续局域网同步）。

### 效率类
- `habit_def`（key, name, chainActions JSON, weekDays, enabled, reminderTimes, freqType, remark）— 习惯定义
- `habit_checkin`（key, habitKey, note, date, source, time）— 打卡记录
- `todo_list`（**key TEXT PK**，含 recurrence 系列字段、tags、parentId 父子任务、deadlineReminder）
- `todo_tags`（key, color）— 待办标签
- `reminders`（**id TEXT PK**，mode/repeat/weekDays/interval/time/title/content/enabled…）— **统一提醒引擎**，习惯/待办/番茄钟到点都来自此表 → 移动端映射为本地通知
- `pomodoro_status`（7113 行，label/value/mode/dateTime）— 番茄钟状态流水（work/rest/lock）
- `pomodoro_mini_config`（key, skin）— 番茄钟皮肤配置

### 笔记（可归类）
- `note_book`（**key TEXT PK**，html, mdText, content, tags, category, excerpt, createTime, updateTime）— `category` 即分类；`html` 富文本（vue-quill）→ 移动端用 `flutter_quill` 直接吃
- basic_info 键 `note_tags` — 笔记标签配置

### 主题对话
- `conversation`（theme_id, content, tags, pinned, is_deleted, ref_ids, cross_refs, ext_key…）
- `conversation_theme`（title, tags, parent_id, remark…）— 对话主题/人格
- `conversation_tag`（color, scope）— 对话标签

### 2FA（数据在 vault 文件，不在本表）
- `basic_info.twoFactorVaultPath` 指向加密文件；解密后为 otpSecret 等条目
- Flutter 需自行建 Dart 模型 + vault 解密（见第 2 节）

### 私密文件保险箱
- `file_vault_config`（key, value）— 配置
- `file_vault_files`（**id TEXT PK**，name, mime, ext, size, ciphertext_path, created_at）— **密文在磁盘 `ciphertext_path` 指向的文件里**，db 只存元数据
- Flutter 须把密文文件一并拷进沙盒，并用同套 crypto 解密

### 电子书阅读器（file_path 为桌面路径，移动端需重映射）
- `ebook_bookshelf`（file_path PK, name, format, percent, cover, content_hash…）
- `ebook_progress`（file_path PK, cfi, percent, updated_at, content_hash）
- `ebook_bookmark`（file_path, cfi, label, percent, content_hash）
- `ebook_annotation`（file_path, anchor, text, note, color, type, content_hash）
- `ebook_category` / `ebook_book_category`（分类）
- `ebook_bg_image`（image_path UNIQUE, data_url）— 阅读背景图
- ⚠️ 这些表以**桌面绝对路径**做关联键。移动端把 epub 放进沙盒后，用 `content_hash` 做稳定映射，不要依赖 file_path

### 截图记录（需重设计）
- `screenshots`（path, action, width, height, sticker_status, created_at）— 桌面端 path 为系统截图路径
- 移动端**无法系统级监听截图**（隐私）。重设计：从相册导入（`image_picker`）/ 系统分享扩展收纳，把图片拷进沙盒并重写 path

## 4. 功能移动端现实
| 功能 | 移动端处理 |
|---|---|
| 习惯/番茄钟/待办 | `reminders`→本地通知（awesome_notifications）；番茄钟需前台服务/isolate 保活（iOS 受限）；待办每日实例用 workmanager |
| 2FA | 解密 vault + HMAC-SHA1 出 TOTP（最早可交付） |
| 可归类笔记 | `flutter_quill` 直吃 html |
| 私密文件保险箱 | 沙盒内同套 AES 加密 |
| 电子书 | `epubx`/`flutter_epub`；进度/划线按 content_hash 映射 |
| 主题对话 | 先定 LLM 后端（自建 API / 本地模型） |
| 截图记录 | 重设计为导入/分享收纳 |

## 5. Flutter 工程骨架（feature-first）
```
lib/
  main.dart
  app/
    app.dart
    theme/            # 25 套主题 token → ThemeData / ColorScheme
    router/           # go_router
    di/               # 依赖注入（Riverpod）
  core/
    db/               # drift 数据库 + migrations
    crypto/           # vault 解密（AES-256-GCM + PBKDF2）
    sync/             # 局域网同步（后续）
    notifications/    # 本地通知封装
  features/
    habit/  pomodoro/  todo/  notes/  conversation/
    twofactor/  file_vault/  ebook/  screenshots/
      api/  models/  repositories/  components/  composables/  utils/
```
状态：Riverpod（对应 Pinia）；路由：go_router（对应 vue-router）；富文本：flutter_quill（对应 vue-quill）；DB：drift。

## 6. pubspec 依赖（初版）
```yaml
dependencies:
  flutter:
    sdk: flutter
  flutter_riverpod: ^2.x        # 状态（对应 Pinia）
  go_router: ^14.x              # 路由（对应 vue-router）
  drift: ^2.x                   # 类型安全 SQLite DAO
  sqlite3_flutter_libs: ^0.x
  cryptography: ^2.x            # AES-256-GCM + PBKDF2（加密红线）
  encrypt: ^5.x                 # 备选
  awesome_notifications: ^0.x   # 本地通知 / 提醒
  workmanager: ^0.x             # 后台任务（待办每日实例）
  flutter_quill: ^10.x          # 富文本（对应 vue-quill，吃 html）
  epubx: ^0.x                   # epub 解析（对应 epubjs）
  path_provider: ^2.x           # 沙盒路径
  file_picker: ^x               # 文件导入（保险箱 / 电子书）
  image_picker: ^x              # 截图导入
  shared_preferences: ^2.x      # 轻量配置
dev_dependencies:
  drift_dev: ^2.x
  build_runner: ^2.x
  flutter_test: ^x
```
> 桌面专属能力（悬浮小窗、全局热键、资源管理器右键、系统级剪贴板常驻）本次不搬。

## 7. 类 LocalSend 局域网同步（P3，先计划，后续做）
- 因所有表以 `key`/`id` 为主键，**同步 = 按主键幂等 upsert**，天然适合。
- 发现：mDNS / NSD 在同局域网找对端（LocalSend 本身即 Flutter，可借鉴其发现 + 传输架构）。
- 传输：本端起本地 HTTP（`shelf` / `http_server`），把选中数据序列化 JSON 发出；对端按 `key` upsert。
- 冲突：`updated_at` 最后写入胜出（表内需有时间戳）。
- 触发：App 内「发送同步 / 接收同步」按钮，选表 / 范围。
- 安全：含 vault 字段的数据，传输层加会话密钥，勿明文走局域网。
- vault 文件同步：文件本身 + basic_info 路径需一起迁；密钥为设备绑定，跨设备需用「用户口令」重新封装，不能直传设备密钥。

## 8. 推进顺序
P0 装环境 → P1 加密 PoC（2FA 打通即验证成功）→ P1 表迁移（drift）→ 2FA / 笔记 → 习惯 / 待办 / 番茄钟 → 文件保险箱 → 电子书 → 主题对话 → 截图记录（重设计）→ 最后做 P3 局域网同步。

## 9. 实测产物（可复用脚本）
- 导出脚本：`test-scripts/dump_schema.py`（全库 69 表 CREATE + 列）、`test-scripts/extract_relevant.py`（首批功能相关表 + basic_info 键）
- 产物：`test-scripts/db_schema_dump.txt`、`db_relevant_dump.txt`
- 运行：`python extract_relevant.py`（只读 `?mode=ro` 打开 db，不污染业务库）

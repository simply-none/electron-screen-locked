# Flutter 移动端移植计划（flutter-port）

> 本文件记录把渐离 App 部分功能移植到 Flutter（Android + iOS）的方向、数据映射与双端同步设计。
> 与 Electron 版的差异见 `architecture.md` / `risks.md`；本文件聚焦「跨端移植」这一新方向。

## 0. 范围与目标
- 平台：**Android + iOS**（移动端）。注意系统级能力受限：系统截图监听、剪贴板常驻监听、悬浮小窗、全局热键、资源管理器右键菜单在移动端不可用/需重设计。
- 首批功能：习惯打卡 / 番茄钟 / 待办 / 电子书阅读器 / 2FA / 主题对话 / 截图记录 / 可归类笔记 / 私密文件保险箱。
- 数据策略：**复用现有 `db.sqlite`**（表结构 + 加密必须对齐），并规划一个类 LocalSend 的局域网双端同步（先计划，后续再做）。

## 1. 环境现状（P0 前置）
> **2026-09-04 状态：P0 已完成 ✅**（移动端工程见第 10 节）

- Flutter SDK：**3.47.2 stable** 已装于 `C:\src\flutter`（Dart 3.13.2）。用户手动解压到 Downloads 后已迁移到 ASCII 路径——官方要求 SDK 路径不含中文/特殊字符，且用户 PATH 早已指向 `C:\src\flutter\bin`。
- 镜像（已持久化到用户环境变量）：**cernet 的 dart-pub 端点已失效**（返回 badly formatted response），已改用 Flutter 官方中国镜像：
  - `PUB_HOSTED_URL=https://pub.flutter-io.cn`
  - `FLUTTER_STORAGE_BASE_URL=https://storage.flutter-io.cn`
- `flutter doctor` 基线：Flutter ✓ / Chrome ✓（可先跑 Web 冒烟）；**Android toolchain ✗（待装 Android Studio，由用户手动安装）**；Visual Studio ✗（仅 Windows 桌面目标需要，移动端无关）。
- ⚠️ **中文用户名雷区**：Windows 用户目录含中文（`C:\Users\风起`），Dart build_runner 自举编译会因 `%TEMP%` 路径含中文而失败（`Unable to read program.dill`）。**解法：跑 dart/flutter 工具链时设置 ASCII 临时目录** `TMP`/`TEMP`/`TMPDIR=C:\src\tmp`。Gradle 构建同理，后续若再遇编码问题优先怀疑路径。
- 待用户手动安装：Android Studio（含 Android SDK / 模拟器），装完跑 `flutter doctor --android-licenses` 接受许可。
- iOS：需 Mac + Xcode，Windows 阶段仅保留 ios 目录不构建。
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
- `twoFactorVaultPath` → 2FA 保险库文件
- `passwordVaultPath` → 密码保险库文件
- `appLockVault` → 应用锁哨兵（直接存在 `basic_info.value`）
- 股票 API Key → `stockVault`

**密钥来源（⚠️ 以 `vault/deviceKey.ts` 为准，修正本节旧记载）**：
- **2FA / 应用锁：用户手动输入的口令** 经 PBKDF2 派生密钥（不是设备绑定密钥）；
- **密保 / 股票 API Key：设备绑定随机主密钥**（electron-store `_device_master_key`，32 字节 hex，重装失效→强制重录）；
- 两者加密原语、信封格式完全一致：JSON 信封 `{v:1, kdf:'pbkdf2-sha256', iter, salt(b64,16B), iv(b64,12B), ct(b64=密文‖16B tag)}`。

Flutter 侧已复刻（2026-09-05）：`lib/core/crypto/vault_codec.dart`（信封/二进制编解码，与 crypto.ts 逐字节对齐）+ `vault_crypto.dart`（常量与格式说明）。
**注意**：移动端无法直接读桌面 `twoFactorVaultPath` 指向的本机路径，需同步/导入把 vault 文件带过来；纯 Dart PBKDF2 200000 次解锁约数秒，P2 可接 `cryptography_flutter` 走平台实现提速。
**解密 PoC 通过前，不要动任何依赖 vault 的功能**（2FA / 密码库 / 文件保险箱）。

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

## 6. pubspec 依赖（已按 2026-09 实装版本更新 ✅）
```yaml
# pub add 实际解析版本（flutter pub add 自动选兼容最新版）
dependencies:
  flutter:
    sdk: flutter
  flutter_riverpod: ^3.4.3      # ⚠️ 实装为 Riverpod 3.x（计划原写 2.x），API 与 2.x 有差异，开发以 3.x 文档为准
  go_router: ^18.0.1
  drift: ^2.34.4                # dev: drift_dev ^2.34.6 + build_runner
  sqlite3_flutter_libs: ^0.6.0
  cryptography: ^2.9.0          # AES-256-GCM + PBKDF2（加密红线）
  awesome_notifications: ^0.12.1
  workmanager: ^0.10.9
  flutter_quill: ^11.5.1
  epubx: ^4.0.0
  path_provider: ^2.1.6
  path: ^1.9.x                  # db 路径拼接
  file_picker: ^12.2.0
  image_picker: ^1.2.3
  shared_preferences: ^2.5.5
  intl: ^0.20.3
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
P0 装环境 ✅ → P1 加密复刻 ✅（信封/JLV/wrappedKey 全对齐，TOTP RFC 向量单测 ✅）→ P1 表迁移 ✅（**25 张表**）→ 首批 5 功能域 ✅ → 第二批 8 功能域 + 四 Tab 壳 ✅ → 移动端新建能力全量补齐 ✅（习惯/提醒/笔记/主题对话/2FA 添加）→ **P3 局域网同步双向联调 ✅（2026-09-05：四种组合全通——手机拉/推 PC、PC 拉/推手机；PC 端同步页上线：系统与资源 → 局域网同步，含扫描/手动 IP(ip:port 格式)/推送/拉取）** → 剩余：真机验证、模拟器 /ping 设备名补传、精细化（QR 样式 / interval 通知 / PDF / CFI 精确进度 / 会话加密 / KGP 上游跟进）。

## 9. 实测产物（可复用脚本）
- 导出脚本：`test-scripts/dump_first_batch.py`（首批 22 张表 CREATE + 行数 + 样例，只读 `?mode=ro` 打开 db，不污染业务库；**用 `py -3` 运行**，PATH 上的 `python` 是 2.7）
- 产物：`test-scripts/db_first_batch_dump.txt`（2026-09-04 重新生成，表结构以此为准）
- 旧版 `dump_schema.py` / `extract_relevant.py` 未随仓库保留，如需全库 69 表可基于新脚本扩展

## 10. 移动端工程落地记录（jianli-mobile-app）
- 位置：`C:\cod\electron-vite-vue\jianli-mobile-app`（`flutter create --org com.jianli --platforms android,ios`，项目名 `jianli_mobile_app`）
- **drift 表定义三大铁律（2026-09-05 夜间实战踩出来的）**：
  1. drift 默认把驼峰 getter 转下划线列名，而桌面端业务列多为驼峰 → **必须 `.named('桌面原名')` 显式锁定**（`@Named` 注解在 drift 2.34 不存在）；
  2. **getter 不能叫 `text` / `dateTime`**（与 drift `Table.text()` / `Table.dateTime()` 构造方法冲突，会导致整个库解析失败、生成空壳 .g.dart）→ 改名 + `.named()` 锁定（`annotatedText`、`recordedAt`）；
  3. **行类名会被单数化**：`TodoTags`→`TodoTag`、`Reminders`→`Reminder`、`Screenshots`→`Screenshot`，其余为 `XxxData`。
- 首批 **22 张表**全部接入并生成代码（habit×2 / todo×2 / reminders / note_book / basic_info / pomodoro×2 / conversation×3 / file_vault×2 / ebook×7 / screenshots）。
- 首批 **5 个功能域**已生成（feature-first，均带中文注释）：
  - `twofactor`：模型 + TOTP 服务（RFC 6238 全算法，含 RFC 向量单测 `test/totp_test.dart`）+ vault 仓库 + 口令解锁页/动态码卡片（点击复制、周期倒计时、锁定清内存）；
  - `notes`：列表（分类 chips）+ 详情（flutter_widget_from_html 渲染 vue-quill html；flutter_quill 编辑器列 P2）；
  - `habit`：今日打卡列表 + 幂等切换（key=`habitKey#date`）+ 近 7 天查询；
  - `todo`：列表/筛选/新增/勾选/滑动删除（uuid 主键，字段约定与桌面一致）；
  - `pomodoro`：状态机解析（reminders stateful）+ 只读倒计时页 + 流水写入。
- 验证状态：build_runner ✅（19324 行生成）、`flutter analyze` ✅ 零问题。**flutter test / 真机运行待用户手动验证。**
- ⚠️ 环境注意：跑 dart/flutter 命令前 `export TMP/TEMP=C:\src\tmp`（中文用户名雷区，见第 1 节）。
- **flutter test 宿主端 sqlite3 雷区**：sqlite3 3.5.x 的 hook 默认从 GitHub 下载 sqlite3.dll（国内超时）。解法已固化在 jianli-mobile-app/pubspec.yaml：`hooks.user_defines.sqlite3.{source: system, name_windows: winsqlite3.dll}`（用 Windows 11 自带 winsqlite3.dll）。

## 11. 第二批落地记录（2026-09-05 夜间）
- **UI 壳**：`lib/app/shell/main_shell.dart` 四 Tab（首页/效率/内容/工具，StatefulShellRoute 保持状态）+ `lib/app/ui/`（AppCard/SectionHeader/EmptyState/StatBlock + RingProgress 自绘进度环）。
- **第二批功能域**（models/repositories/providers/components 原子拆分）：
  - `reminder`：三模式（time/interval/stateful）列表 + 启停联动本地通知；time 模式每天/按星期 → NotificationCalendar；过滤 source==='todo'（get-tips 同款规则）
  - `pomodoro/records`：今日/近7天/累计统计 + 流水列表
  - `countdown`：新增 drift 表（key/end_time(ms) 基准/paused_remaining/status，与桌面端同构抗休眠）+ 大计时器环 + 暂停/恢复/重置
  - `qr`：生成（text/url/wifi/vCard/email，qr_flutter）+ 识别（mobile_scanner）+ 历史（qr_history 表双端同构）
  - `password_vault`：移动端口令 vault（同信封格式，沙盒 Documents/password-vault.jlv，路径记 basic_info.mobilePasswordVaultPath）
  - `file_vault`：**与 PC 完全兼容**——wrappedKey 解包（salt+KEK）、.jlv 新旧格式 parseJlv（JLV1 魔数+metaLen+JSON+iv+ct）、文件名 dataKey 加密存储、导入/预览/删除
  - `ebook`：file_picker 导入（file_picker 12.x 为静态 API）→ sha256 content_hash 身份键 → epubx Chapters 树解析（PascalCase 字段）/TXT 正则分章 → 章节渲染 + 按章进度
  - `conversation`：主题列表 + 消息流（只读，过滤 is_deleted）
  - `home`：Dashboard 聚合（习惯/待办/专注/提醒统计 + 最近倒计时 + 快捷入口）
- **局域网同步（类 LocalSend，双端同协议 v1）**：
  - Flutter：`core/sync/sync_discovery.dart`（UDP 广播 47123，JIANLI_SYNC_DISCOVER_V1）+ `sync_service.dart`（HTTP 47124 收发，INSERT OR REPLACE 幂等 upsert，9 张 TEXT 主键表白名单）+ `features/sync` 同步页
  - PC：`electron/main/module/sync/syncModule.ts`（零 npm 依赖：dgram 应答 + node:http 接收 + newSql upsert 白名单），已注册 `initSync()`（index.ts，**需重启 Electron 生效**；测试 TODO）
- **验证**：`flutter analyze` 0 问题；`flutter test` 5/5（RFC 6238 向量 ×4 + 冒烟 ×1）。
- **同步实战要点（2026-09-05 联调沉淀）**：
  - 模拟器 NAT 广播不通，扫不到宿主 → 同步页支持**手动填 IP**，模拟器固定填 `10.0.2.2`；真机走正常广播。
  - 桌面端表带旧 SQL 层遗留列（id/name/value/created_at）→ 移动端 `_upsertRow` 按 `PRAGMA table_info` 实际列过滤后再 INSERT OR REPLACE，双端 schema 差异免疫。
  - 构建命令的 shell 必须带新镜像变量（旧会话继承 cernet 的 `FLUTTER_STORAGE_BASE_URL` 会让 flutter_embedding_debug 拉取失败）。
  - 双端同步语义：`_upsertRow` 全列 toString 后按主键 INSERT OR REPLACE；行内遗留列在移动端缺列时被安全忽略（nullable，不影响桌面端读回）。
- **2026-09-05 白天验证记录**：APK 真机构建 ✅（腾讯 gradle 镜像 + 阿里云 maven 镜像 + storage.flutter-io.cn，`FLUTTER_STORAGE_BASE_URL` 必须在构建 shell 里是新值——旧会话继承 cernet 变量会让 flutter_embedding_debug 从 googleapis 拉取失败）；模拟器 Pixel_8 运行 ✅；sqlite3 Android 崩溃已修（jniLibs 三 ABI 手动分发 .so + `user_defines.sqlite3.name_android: sqlite3` 裸名——填 `libsqlite3.so` 会被 hook 再装饰成 liblibsqlite3.so.so）。
- **构建警告现状**：① JDK `System::load` restricted-method 警告已修（gradle.properties jvmargs 加 `--enable-native-access=ALL-UNNAMED`）；② KGP 弃用警告（mobile_scanner / workmanager_android 应用旧 Kotlin Gradle Plugin）**暂无法修**——pub outdated 确认两插件已是最新，需等上游支持 Flutter built-in Kotlin，届时升级插件即可（当前仅警告不阻塞）。

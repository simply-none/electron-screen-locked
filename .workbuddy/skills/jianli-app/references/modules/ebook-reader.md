# 电子书阅读器 (ebookReader)

## 职责
EPUB / TXT / PDF 三格式阅读：进度保存、书架、分类、笔记与划线、书签、背景图，支持按内容哈希（sha256）跨路径复用标注/书签/进度。预览见 `components/` 与 `composables/` 按格式拆分（epub / txt / pdf）。

## 关键文件
- 主页面：`src/views/ebookReader/index.vue` + `components/EpubReader.vue` 等 + `composables/`（`useEpubRender`/`useTxtRender`/`usePdfRender`/`useEpubHighlight`/`useTxtHighlight`/`usePdfHighlight`/`useEpubBookmarks`/`usePdfBookmarks`/`useBookshelf`/`useEpubSearch`）+ `workers/pdfWorker.ts` + `types.ts`
- 关联主进程：`electron/main/module/ebook.ts`（`initEbook` 建 7 张表），preload 暴露 `ipcRenderer.ebook.*` 全量
- store：`src/store/useEbookReader.ts`
- 数据库：复用主库 `db.sqlite`，表 `ebook_progress`/`ebook_bookshelf`/`ebook_annotation`/`ebook_bookmark`/`ebook_category`/`ebook_book_category`/`ebook_bg_image`

## 路由
- `RouteNames.EBOOK_READER` → `/ebookReader`
- 无小窗（`windowSections` 无 ebook 条目）

## 用到的 IPC 通道（preload `ebook.*`）
- 读取：`ebook:read-txt`（chardet+iconv-lite 编码检测）、`ebook:read-file-bytes` / `ebook:get-file-size` / `ebook:read-file-range`（PDF 区间加载）、`ebook:compute-file-hash`
- 进度：`ebook:get-progress` / `ebook:save-progress`
- 书架：`ebook:get-bookshelf` / `add-to-bookshelf` / `remove-from-bookshelf` / `clear-bookshelf` / `scan-folder`
- 分类：`ebook:get-categories` / `add-category` / `update-category` / `delete-category` / `get-book-categories` / `set-book-categories`
- 标注：`ebook:get-annotations` / `add-annotation` / `update-annotation` / `remove-annotation` / `remove-annotations` / `get-annotation-counts`
- 书签：`ebook:get-bookmarks` / `add-bookmark` / `remove-bookmark`
- 其它：`ebook:save-book-meta` / `add-bg-image` / `get-bg-images` / `delete-bg-image` / `export-annotations`

## 复用 / 集成点
- 主进程 `ebook.ts` 数据访问**合规**走 `newSql.ts` 的 `query/upsert/update/del` + `ensureTableExists` 自动补列；无命令面板 REGISTRY、无小窗四件套。

## 特有坑 / 注意
- **epubjs 强制样式**：分页布局下 epubjs 对 iframe `body` 写死 `margin:0 !important`（`useEpubRender.ts:585`）。页边距只能用**视口容器 padding** 实现；给 body 加 margin 会破坏分页宽度计算、末栏被裁切。字号/字体经 `themes.override` 注入。
- **pdf.js v6 worker**：必须经 `workers/pdfWorker.ts` 用 `GlobalWorkerOptions.workerPort` 注入 `pdf.worker.min.mjs`（异步加载）。PDF 用**区间加载**（`ebook:read-file-range` + `PDFDataRangeTransport`），按字节按需拉取，切勿整文件读入内存，否则大文件初始化极慢。
- **content_hash 身份**：换路径重新导入按 `sha256` 复用同内容的标注/书签/进度（多副本共享）；但书架行各路径独立，删除某副本只删其书架引用、不删共享数据。书架徽标计数依赖 `get-annotation-counts` 传 `contentHashes`。
- TXT 编码自动检测（GB2312/GBK→GB18030），并去除首部 BOM。
- **附件抽屉（PDF 专用）**：`components/AttachmentsDrawer.vue` + 工具栏「附件」按钮（`v-if="currentFile.format === 'pdf'"`）。读取/另存复用 PDF 工具箱已封装的 `pdfApi.getAttachments / extractAttachment`（即 `pdf:get-attachments` / `pdf:extract-attachment`，主进程 `pdf.ts#readEmbeddedFiles` 解析 `/Names /EmbeddedFiles` 名称树）。**列表只回元信息（name/mime/size），附件字节由主进程直接写盘、不经过渲染端 IPC**，避免大附件卡顿。切换文件时在 `watch(currentFile.path)` 里重置附件状态。踩坑细节见 `modules/pdf-tools.md`。

## 右键外部文件入口（用渐离阅读）
- 资源管理器右键 epub / pdf / txt 的「用渐离阅读」（`--open-reader`）经统一 shellMenu 管线送到 `App.vue` → `useEbookReader().requestOpenExternal(files)` + 跳 `EBOOK_READER`。
- `requestOpenExternal` 把文件写入 `pendingOpenBooks`，`ebookReader/index.vue` 挂载时消费：循环 `loadFile(path, name, format)`（按扩展名判 format）写书架并切阅读视图，默认打开首个；并 `watch(pendingOpenBooks)` 保后续到达。
- 该动作同时注册 ProgID `JianliApp.<ext>` 进「打开方式」列表；用户在设置页「设为默认打开」后双击文件即进本 App（可撤销）。详见 `modules/file-vault.md`「资源管理器右键菜单（统一）」。

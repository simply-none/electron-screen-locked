# PDF 工具箱 (pdfTools)

## 职责
渐离App 新增的**独立 PDF 文件级操作模块**（对标 Smallpdf / Acrobat「组织页面」，但本地离线、文件不出本机）。与电子书阅读器（`ebookReader`）解耦：阅读器负责「读 PDF」，本模块负责「改 PDF」。一期提供：合并 / 拆分 / 组织页面(重排·删除·旋转·提取) / 导出图片。

## 关键文件
- 入口视图：`src/views/pdfTools/index.vue`（卡片仪表盘 + 工具切换；容器**左对齐**不居中，`margin:0 auto` 已移除；打开工具时在 `tool-head` 区显示二级标题 = 当前工具 title + desc，元信息来自 store `tools` 按 `activeTool` 匹配）
- 子工具组件（原子化）：
  - 一期：`MergeTool.vue` / `SplitTool.vue` / `OrganizeTool.vue` / `ExportImagesTool.vue`
  - 二期：`InsertTool.vue` / `ReplaceTool.vue` / `DuplicateTool.vue` / `CropTool.vue` / `DecorateTool.vue` / `WatermarkTool.vue` / `CoverTool.vue` / `ResizeTool.vue` / `DetectBlankTool.vue` / `FlattenTool.vue`
  - 三期：`CompressTool.vue` / `RedactTool.vue` / `SecurityTool.vue` / `PageLabelsTool.vue` / `AttachTool.vue` / `CompareTool.vue`
- 复用原子组件（新增）：`PdfSourcePicker.vue`（单 PDF 源选择）
- 通用原子组件：`components/PdfToolCard.vue`（卡片） / `FileDropZone.vue`（选择/拖入文件） / `ThumbnailGrid.vue`（缩略图网格，IntersectionObserver 懒渲染） / `PdfResultBar.vue`（结果反馈）
- 渲染端 API：`api/pdfApi.ts`（封装 `window.ipcRenderer.pdf.*`）
- 缩略图/栅格化：`composables/usePdfjs.ts`（复用电子书阅读器 worker + polyfill）
- store：`store/usePdfTools.ts`
- 类型：`types.ts`
- 主进程：`electron/main/module/pdf.ts`（`initPdf()` 注册 `pdf:*` IPC）；preload `ipcRenderer.pdf.*` 桥接

## 路由 / 入口
- `RouteNames.PDF_TOOLS` → `/pdfTools`
- 侧边栏 `src/layout/index.vue` 的「效率工具」分组加入 `'pdfTools'`；`src/utils/index.ts` 的 `iconMap` 加 `pdfTools: 'FileBox'`
- 可见开关：`src/views/routeSetting/index.vue` 自动从 `layoutRouters` 生成（无需额外改动）

## 用到的 IPC 通道（preload `pdf.*`）
- `pdf:pick-files` → 多文件选择，返回 `{ files: string[] }`
- `pdf:pick-dir` → 选择目录，返回 `{ dir }`
- `pdf:pick-save(defaultName)` → 保存对话框，返回 `{ filePath }`
- `pdf:merge({ files, outputPath })` → 顺序合并，返回 `{ outputPath, pages }`
- `pdf:organize({ file, outputPath, pageMap:[{index,rotation}] })` → 按最终页序重排/删除/旋转/提取，返回 `{ outputPath, pages }`
- `pdf:split({ file, outputDir, baseName, mode })` → 按 range/everyN/oddEven 拆分，返回 `{ files: string[] }`
- `pdf:write-files({ dir, files:[{name,base64}] })` → 批量写文件（导出图片用）
- 二期：`pdf:insert({file,outputPath,insertFile,atIndex,insertIndices?})` / `pdf:replace({file,outputPath,replaceFile,targetStart,replaceIndices?})` / `pdf:duplicate({file,outputPath,indices})` / `pdf:crop({file,outputPath,margins})` / `pdf:decorate({file,outputPath,opts})` / `pdf:watermark({file,outputPath,opts})` / `pdf:add-cover({file,outputPath,opts})` / `pdf:resize({file,outputPath,size})` / `pdf:flatten({file,outputPath})`
- 三期：`pdf:compress({file,outputPath})` / `pdf:redact({file,outputPath,opts})` / `pdf:encrypt()`(规划中·诚实提示) / `pdf:decrypt()`(规划中·诚实提示) / `pdf:page-labels({file,outputPath,labels})`(走底层 /Labels 数字树) / `pdf:attach({file,outputPath,data,fileName,mime?})`(pdf-lib attach 嵌入附件)
- 附件读取/导出（供阅读器「附件」面板）：`pdf:get-attachments({file})` → 返回 `{ attachments:[{name,mime,size}], count }`（**只回元信息、不含字节**，避免大附件全量过 IPC）；`pdf:extract-attachment({file,index,outputPath})` → 按列表**序号**提取并写盘（不用文件名，规避同名附件歧义）
- 渲染端空格检测复用 `composables/usePdfjs.ts#findBlankPages`（pdf.js 栅格化 + 非白像素占比判定），清理走 `pdf:organize` 删除对应页。

## 库与架构
- **pdf-lib**：主进程二进制操作（合并/拆分/组织），不渲染。
- **pdf.js**：渲染端缩略图与图片栅格化；worker 经 `GlobalWorkerOptions.workerPort` 注入，复用 `src/views/ebookReader/workers/pdfWorker.ts`（内含 polyfill）。
- 文件字节读取复用 `ebook:read-file-bytes`（主进程读盘），渲染端 `atob` → `Uint8Array` → `getDocument`。

## 红线 / 注意
- 渲染端**禁 `import electron/*`**；所有磁盘/二进制走 `pdf:*` IPC；改主进程 `pdf.ts` **须重启 Electron**。
- **安全默认**：所有写操作「另存为」新文件（`pdf:pick-save` 指定路径），绝不直接覆盖原文件。
- 主题用自定义 token（`--bg-card`/`--text-*`/`--color-*`），禁硬编码、禁 `--el-*`（见 `references/theme.md`）。
- 组件原子化、单文件职责单一、带注释（见 `AGENTS.md`）。
- **⚠️ pdf.js 文档/页面对象禁止进入 Vue 响应式**：`PDFDocumentProxy` 含私有字段，一旦被 `ref`/`reactive`/`Pinia` 包成 Proxy，`getPage`/`destroy` 会抛 `Cannot read from private field`。长期持有文档须 `markRaw(pdf)` 或存局部 `const`（见 `OrganizeTool.vue` 的 `doc.value = markRaw(pdf)`；`CompareTool`/`DetectBlankTool` 用局部 `const doc` 已合规）。
- **页码范围输入统一用 `RangeInput.vue`**（回车即生成 tag、支持多范围/单页、逗号分隔、非法提示）：拆分 `SplitTool`、导出图片 `ExportImagesTool`、密文整页 `RedactTool` 均复用；解析助手在 `utils/pageRange.ts`（`rangeTagsToRanges`→0 基闭区间、`rangeTagsToIndices`→0 基去重页码）。`Decorate`/`Watermark` 应用到全部页无范围输入；`PageLabels` 的「范围」是标签样式配置行（起始页+样式+前缀），非页码选择，不涉及。

## 多文件导出目录约定
- 「自动导出一系列文件」的工具（拆分 `pdf:split`、导出图片 `pdf:write-files`）在用户所选目录下**再生成子目录** `<源文件名>-<功能>-<datetime>/`，文件写入该子目录，避免多次导出散落混在一起。例：`path/doing-拆分-2026-08-31-22-57-00/doing_01.pdf`。
- 实现：渲染端 `utils/exportPath.ts#makeExportSubDir(outDir, baseName, funcLabel)` 生成子目录路径（渲染端无 `node:path`，按 `outDir` 内斜杠推断分隔符拼接；`datetime` 用 `YYYY-MM-DD-HH-mm-ss` 文件系统安全格式），直接作为 `pdf:split` 的 `outputDir` / `pdf:write-files` 的 `dir` 传入；主进程无需改动（`pdf:split` 写入 `args.outputDir`、`pdf:write-files` 已 `mkdirSync(args.dir,{recursive:true})`）。
- 「另存为」单文件类（合并/组织/压缩/密文/页标签/附件等）不受影响，仍走 `pdf:pick-save`。

## 二期 / 三期（已实现）
- 二期（页面修饰处理）：插入页面 / 替换页面 / 复制页面 / 裁剪白边 / 页码·页眉·页脚 / 文字水印 / 添加封面 / 统一尺寸缩放 / 空白页检测（栅格化识别+一键清理）/ 展平标注。
- 三期（文档级）：压缩减体（best-effort 对象流）/ 密文遮盖（整页或矩形永久涂黑）/ 加密·解密（**规划中**，依赖 qpdf 外部引擎，UI 诚实提示）/ 页面标签（pdf-lib 1.17 无 setPageLabels，走底层 /Labels 数字树手写）/ 嵌入附件（pdf-lib attach）/ 双栏对比（pdf.js 渲染并排）。
- 诚实边界：`pdf:encrypt`/`pdf:decrypt` 因缺 qpdf 引擎，后端直接返回提示、前端 `SecurityTool` 灰显并透传，不伪造能力。

## ⚠️ pdf-lib 底层操作踩坑（已修，勿回退）
- **`lookup()` 必须传「键名」，不能传 `get()` 的返回值**：`src.catalog.lookup(src.catalog.get(PDFName.of('Pages')))` 是错的——`get()` 返回的是 `PDFRef` 引用，把它喂给期望 `PDFName` 的 `lookup()` 会解析出 `undefined`，随后 `pages.set(...)` 抛 `Cannot read properties of undefined (reading 'set')`（`pdf:page-labels` 曾因此整体失效）。**正解**：`src.catalog.lookup(PDFName.of('Pages'))` 直接传键名，pdf-lib 会先取键再递归解引用。
- **嵌入附件流带 FlateDecode，不能直接读原始字节**：`PDFDocument.attach()` 写入的嵌入文件流默认被压缩，`stream.getContents()` 拿到的是压缩后的字节（`78 9c` 开头），且 pdf-lib 1.17 的 `PDFRawStream` **没有 `decode()` 方法**。正解用 `decodePDFRawStream(stream).decode()`（从 `pdf-lib` 根导出），才能得到原始字节。
- **pdf-lib 1.17 无 `getAttachments()`**：读取内嵌附件须手动遍历 `/Names → /EmbeddedFiles`（可能是 `/Kids` 多叉树，需递归收集含 `/Names` 的叶子）+ 叶子 `/Names` 扁平数组 `[名称, 文件说明, ...]` → Filespec `/EF /F` → 文件流；MIME 取文件流字典的 `/Subtype`，且名称/类型需还原 `#XX` 十六进制转义（如 `text#2Fplain` → `text/plain`）。本项目已封装为 `pdf.ts#readEmbeddedFiles(src)`，供 get-attachments 与 extract-attachment 共用。
- **`pdf:add-cover` 嵌入封面图的两层坑（已修）**：① 不能靠扩展名判断图片类型——很多图被错命名（如 JPEG 存成 `.png`），按 `.png` 走 `embedPng()` 会报 `The input is not a PNG file!`。正解用 `detectImageFormat(bytes)` 按**文件头魔数**识别（PNG/JPEG/GIF/BMP/WEBP/ICO），真实 PNG/JPEG 直接嵌入保真，其余格式借 `nativeImage.createFromBuffer().toPNG()` 转 PNG 再嵌入（零额外依赖，项目 clipboard/qrcode/screenshot 已用 nativeImage）。② **`fs.readFileSync` 返回的是 Node 缓冲池视图（可能带非 0 byteOffset，底层 ArrayBuffer 比内容大）**，pdf-lib 的 `embedPng/embedJpg` 内部用 `new DataView(imageData.buffer)` 从 buffer 起点读取，会读到池里垃圾字节 → 间歇性报 `SOI not found in JPEG` / `The input is not a PNG file!`（小文件必现、大文件偶现的 heisenbug）。**正解**：嵌入前一律 `Uint8Array.from(bytes)` 转成干净的副本再传给 embedder（nativeImage 输出的 Buffer 同样要转）。已封装为 `pdf.ts#embedImageFromBytes(out, bytes)`。

## 与电子书阅读器的联动（附件面板）
- `pdf:attach` 的导出**本身是正确且完整的**（已用字节级回环验证：嵌入→重新解析→解码→与原始文件 `Buffer.compare` 完全一致）。用户「看不到附件内容」的根因是**内置阅读器原本没有附件面板**，而非导出失败——排查同类反馈时先确认是「导出坏了」还是「无处可看」。
- 阅读器侧入口：`src/views/ebookReader/index.vue` 顶部工具栏「附件」按钮（仅 `format==='pdf'`）+ `components/AttachmentsDrawer.vue` 抽屉；打开时调 `pdfApi.getAttachments(path)`，另存走 `pdf:pick-save` → `pdf:extract-attachment`（主进程直接写盘，字节不经过渲染端）。切换文件时在 `watch(currentFile.path)` 里重置附件状态。

## 右键外部文件入口（PDF 工具箱）
- 资源管理器右键 PDF 的 5 个动作（`--pdf-compress` / `--pdf-split` / `--pdf-merge` / `--pdf-extract-attach` / `--pdf-to-image`）经统一 shellMenu 管线送到 `App.vue` → `usePdfTools().pendingFiles=files` + `openTool(<tool>)` + 跳 `PDF_TOOLS`。
- `PDF_TOOL_MAP` 映射：`pdf-compress→compress`、`pdf-split→split`、`pdf-merge→merge`、`pdf-extract-attach→attach`、`pdf-to-image→exportImages`。
- 各子工具组件（`MergeTool` / `CompressTool` / `SplitTool` / `AttachTool` / `ExportImagesTool`）挂载时从 `store.pendingFiles` 取外部文件预载为源（MergeTool 喂 files 数组，其余设 src/file）；消费后清空 pending。
- 详见 `modules/file-vault.md`「资源管理器右键菜单（统一）」。

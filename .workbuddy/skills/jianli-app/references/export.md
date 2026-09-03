# 导出统一规范（export）

> 本规范约束「渐离App」所有「导出 / 保存文件到磁盘」类功能，确保用户心智一致、
> 落盘行为一致、成功反馈一致。新增任何导出功能前先读本节。

## 一、统一行为（三条铁律）

1. **不弹系统保存对话框**（`net-request:save-file`、`dialog.showSaveDialog` 等默认禁用）。
2. **默认直写缓存目录 `fileCachePath`**（来自 `useCacheSet` 的 `fileCachePathC`），
   渲染端把该值作为 `dir` 透传给主进程；用户可在设置里改缓存目录。
3. **成功反馈统一用 `src/utils/fileNotify.ts` 的 `fileNotify`**：顶部居中、蓝色可点击路径，
   点击 `explorer /select` 在资源管理器定位文件。

## 二、统一入口（渲染端）

所有导出走 `src/utils/exportToFile.ts`，不要各自直连 IPC：

```ts
import { exportTextToCache, exportBufferToCache, type ExportResult } from '@/utils/exportToFile'

// 文本（CSV / JSON / MD / TXT / Patch …）
const r: ExportResult = exportTextToCache(text, '报表.csv', { title: '报表已导出' })

// 二进制（图片 / PDF / 通用 base64 流；dataURL 前缀会自动剥离）
const r2: ExportResult = exportBufferToCache(base64, 'qr.png', { title: '二维码已保存' })
```

- 两函数签名：`(content, filename, opts?)`，`opts = { title?, dir? }`。
- `dir` 传入则覆盖缓存目录；不传自动取 `fileCachePathC`。
- 返回 `{ success, path?, message? }`；**成功时已内部调用 `fileNotify`**，调用方只处理失败（`ElMessage.error`）。
- 文件名遵循既有命名风格（模块名-描述_时间戳.扩展名），时间戳本地时间 `YYYYMMDD-HHmmss`。

## 三、主进程 IPC 契约

| 通道 | 类型 | 入参 | 返回 |
|---|---|---|---|
| `export-text-to-cache` | 同步 `ipcMain.on`+`e.returnValue` | `{ text, filename, dir? }` | `{ success, path? }` |
| `export-buffer-to-cache` | 同步 `ipcMain.on`+`e.returnValue` | `{ base64, filename, dir? }` | `{ success, path? }` |

实现位置：`electron/main/module/dialog.ts` 的 `exportTextToCache` / `exportBufferToCache`
（与既有 `export-data-to-json` 同文件）。目录解析优先级：
`dir` → electron-store `fileCachePath` → `app.getPath('documents')`；目录缺失自动 `mkdirSync`。

> 二进制用 `Buffer.from(base64, 'base64')` 写入；文本用 `fs.writeFileSync(..., 'utf8')`。

## 四、模块改造清单（已落地）

| 模块 | 文件 | 类型 | 改造点 |
|---|---|---|---|
| 主题对话 | `themeConversation/utils/exportMarkdown.ts` | 文本 MD | 直写缓存 + fileNotify（规范起点） |
| 数据采集 | `dataAcquisition/composables/useHistory.ts` `exportRecords` | 文本 JSON | `net-request:save-file` → `exportTextToCache` |
| 数据采集 | `dataAcquisition/components/result/ResultView.vue` `onExport` | 文本 JSON | 复用上者，去重成功提示 |
| 记账 | `accounting/components/stat/TrendChart.vue` `exportReport` | 文本 CSV | 同上 |
| 接口调试 | `netRequest/components/export/ExportDialog.vue` | 文本 JSON | 同上 |
| 接口调试 | `netRequest/components/response/ResponseActions.vue` `saveResponse` | 文本 / 二进制 | 文本走 `exportTextToCache`，二进制走 `exportBufferToCache` |
| 浏览器嗅探 | `browser/composables/useSniffer.ts` `exportSniffItems` + 主进程 `browser-sniffer:export` | 文本 TXT | 主进程接收 `dir`，渲染端 fileNotify |
| 开发者工具 | `devToolbox/tabs/diffViewer/index.vue` `exportPatch` | 文本 Patch | `Blob` 下载 → `exportTextToCache` |
| 简历 | `resume/index.vue` `handleExport` + 主进程 `resume:export-pdf` | 二进制 PDF | 主进程 `resume:export-pdf` 加 `dir` 参数，传 `fileCachePathC` 直写、不弹框 |
| 二维码 | `components/qrcode/QrCodeDialog.vue` `onDownload` | 二进制图片 | `qr:save-image`(弹框) → `exportBufferToCache` |
| PDF 工具 | `pdfTools/components/ExportImagesTool.vue` | 二进制图片 | 输出目录默认缓存目录，fileNotify |
| 2FA 密钥库 | `twoFactor/components/ExportVaultDialog.vue` | 二进制（安全） | **保留用户选位置**，成功提示改 fileNotify |
| 文件保险库 | `fileVault/index.vue` `onExport` / `DecryptImportDialog.vue` `saveAs` | 二进制（安全） | **保留用户选位置**，成功提示改 fileNotify |

## 五、例外（安全敏感导出）

2FA 密钥库、文件保险库解密导出属于「用户密钥唯一副本 / 明文外泄风险」，**必须让用户主动
选择安全落点**（沿用各自原生保存对话框，**不**强制缓存目录）。仅把成功 `ElMessage` 换成
`fileNotify({ title, filePath })`（filePath 为所选路径/目录），保持反馈一致且可点击定位。

## 六、新增导出功能 Checklist

- [ ] 文本 → 调 `exportTextToCache`；二进制（渲染端有 base64）→ 调 `exportBufferToCache`。
- [ ] 文件名含模块名与时间戳；不弹保存框。
- [ ] 成功反馈交给 `fileNotify`（不要在调用处再 `ElMessage.success` 重复提示）。
- [ ] 主进程若需新写盘逻辑，在 `dialog.ts` 加同步 IPC（勿用 `showSaveDialog`）。
- [ ] 安全敏感导出：保留用户选位置 + `fileNotify`。
- [ ] 在 `references/export.md` 清单与本文件红线同步登记。

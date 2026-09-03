<template>
  <div class="resume-page">
    <!-- 顶部工具条：左（标题+简历选择+新建） / 右（填充示例/保存/导出） -->
    <div class="toolbar">
      <ResumeSelect
        :records="records"
        :active-id="activeId"
        @select="handleSelect"
        @create="handleCreate"
        @rename="handleRename"
        @remove="handleRemove"
        @save-as="handleSaveAs"
      />
      <div class="toolbar-right">
        <span v-if="dirty" class="dirty-dot" title="有未保存的更改"></span>
        <!-- 选择排版：el-popover 弹框，支持搜索 + 删除管理 -->
        <el-popover
          v-model:visible="presetPopoverVisible"
          placement="bottom-end"
          :width="300"
          trigger="click"
          popper-class="resume-preset-popper"
          @show="loadPresets"
        >
          <template #reference>
            <el-button size="small" :loading="presetsLoading" :class="{ 'is-active': !!activePresetName }">
              <LucideIcon name="LayoutTemplate" :size="14" />
              <span class="preset-trigger-label">{{ activePresetName || '选择排版' }}</span>
            </el-button>
          </template>
          <div class="preset-pop">
            <el-input
              v-model="presetSearch"
              size="small"
              placeholder="搜索排版名称"
              clearable
            >
              <template #prefix>
                <LucideIcon name="Search" :size="13" />
              </template>
            </el-input>
            <div class="preset-list">
              <div
                v-for="p in filteredPresets"
                :key="p.id"
                class="preset-item"
                :class="{ 'is-active': p.id === activePresetId }"
                @click="handleApplyPreset(p)"
              >
                <LucideIcon
                  v-if="p.id === activePresetId"
                  name="Check"
                  :size="13"
                  class="preset-check"
                />
                <span class="preset-name">{{ p.name }}</span>
                <el-tooltip content="删除排版" placement="top">
                  <button class="preset-del" @click.stop="deletePreset(p)">
                    <LucideIcon name="Trash2" :size="13" />
                  </button>
                </el-tooltip>
              </div>
              <div v-if="filteredPresets.length === 0" class="preset-empty">
                {{ presets.length === 0 ? '暂无保存的排版' : '无匹配的排版' }}
              </div>
            </div>
          </div>
        </el-popover>
        <el-button size="small" :disabled="!activeRecord" @click="handleFillMock">
          <LucideIcon name="Wand2" :size="14" />
          <span>填充示例</span>
        </el-button>
        <el-button size="small" :disabled="!activeRecord" :loading="saving" @click="handleSave">
          <LucideIcon name="Save" :size="14" />
          <span>保存</span>
        </el-button>
        <el-button size="small" type="primary" :disabled="!activeRecord" :loading="exporting" @click="handleExport">
          <LucideIcon name="Download" :size="14" />
          <span>导出 PDF</span>
        </el-button>
      </div>
    </div>

    <!-- 主体：编辑器 | 预览 -->
    <div class="main-area">
      <ResumeEditor
        v-if="activeRecord"
        :data="localData"
        @update:data="onDataChange"
        @add-custom="handleAddCustom"
        @remove-custom="handleRemoveCustom"
      />
      <div v-else class="editor-empty">
        <LucideIcon name="FileText" :size="36" />
        <p>新建或选择一份简历开始编辑</p>
      </div>
      <ResumePreview
        :html="previewHtml"
        v-model:inner-split="innerSplit"
        @open-style="styleDialogVisible = true"
      />
    </div>

    <!-- 排版设置全屏弹窗（左配置 / 右预览：有简历内容用简历数据实时渲染，无内容用示例数据） -->
    <StyleDialog
      v-model:visible="styleDialogVisible"
      :config="layoutConfig"
      :resume-data="localData"
      :inner-split="innerSplit"
      @apply="applyLayout"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import LucideIcon from '@/components/LucideIcon.vue'
import ResumeSelect from './components/ResumeSelect.vue'
import ResumeEditor from './components/ResumeEditor.vue'
import ResumePreview from './components/ResumePreview.vue'
import StyleDialog from './components/styleDrawer/StyleDialog.vue'
import { listResumes, createResume, updateResume, deleteResume, getResumeById, getLayoutByResumeId, saveLayout, listLayoutPresets, deleteLayoutPreset, type LayoutPresetRecord } from './db'
import { getTemplate, DEFAULT_TEMPLATE_ID } from './templates'
import { createMockResumeData } from './mock'
import { defaultLayoutConfig, createCustomModuleStyle } from './engine/defaultConfig'
import { buildPaginatedHtml } from './utils/paginate'
import type { ResumeData, ResumeRecord, ResumeLayoutConfig, CustomSectionData } from './types'
import { fileNotify } from '@/utils/fileNotify'
import useCacheSet from '@/store/useCacheSet'

/** IPC 句柄 */
const ipc: any = (window as any).ipcRenderer
const { fileCachePathC } = useCacheSet()

/** 全部简历记录（按更新时间倒序） */
const records = ref<ResumeRecord[]>([])
/** 当前选中简历 id */
const activeId = ref<number | null>(null)
/** 当前编辑中的简历数据（本地副本） */
const localData = ref<ResumeData>(emptyResumeData())
/** 当前简历排版配置（随简历加载，保存时落库） */
const layoutConfig = ref<ResumeLayoutConfig>(defaultLayoutConfig)
/** 是否有未保存更改 */
const dirty = ref(false)
/** 保存中 */
const saving = ref(false)
/** 导出中 */
const exporting = ref(false)
/** 排版弹窗显隐 */
const styleDialogVisible = ref(false)
/** 模块内切断开关（切页粒度，默认开启；预览与导出共用） */
const innerSplit = ref(true)
/** 排版预设列表（选择排版下拉） */
const presets = ref<LayoutPresetRecord[]>([])
/** 预设列表加载中 */
const presetsLoading = ref(false)
/** 排版选择弹框（el-popover）显隐 */
const presetPopoverVisible = ref(false)
/** 排版搜索关键字（按名称过滤） */
const presetSearch = ref('')
/** 当前预览所应用的排版预设 id（null 表示未套用预设/已手动编辑，用于删除时判断是否为当前预览项） */
const activePresetId = ref<number | null>(null)
/** 当前预览所应用排版预设的名称（选中后替代「选择排版」按钮文字） */
const activePresetName = ref('')

/**
 * 按搜索关键字过滤后的排版预设（名称包含匹配，大小写不敏感）
 */
const filteredPresets = computed<LayoutPresetRecord[]>(() => {
  const kw = presetSearch.value.trim().toLowerCase()
  if (!kw) return presets.value
  return presets.value.filter((p) => p.name.toLowerCase().includes(kw))
})

/** 当前选中的记录（来自列表，仅用于判断存在性） */
const activeRecord = computed(() => records.value.find((r) => r.id === activeId.value) || null)

/** 当前模板（简历数据里存的 templateId） */
const currentTemplate = computed(() =>
  getTemplate(activeRecord.value?.templateId || DEFAULT_TEMPLATE_ID)
)

/** 预览 HTML：模板 + 排版配置渲染结果（150ms 防抖，与导出同源） */
const previewHtml = ref('')
let renderTimer: ReturnType<typeof setTimeout> | null = null

/**
 * 防抖重渲染预览（数据或排版配置变化均触发）
 */
function scheduleRender() {
  if (renderTimer) clearTimeout(renderTimer)
  renderTimer = setTimeout(() => {
    previewHtml.value = currentTemplate.value.render(localData.value, layoutConfig.value)
  }, 150)
}

// 数据/排版变更 → 防抖渲染（immediate 保证首屏出图）
watch([localData, layoutConfig], scheduleRender, { deep: true, immediate: true })

/**
 * 生成一份空白简历数据（作为新建默认值）
 * @returns 空白 ResumeData
 */
function emptyResumeData(): ResumeData {
  return {
    basics: { name: '', jobIntent: '', phone: '', email: '', gender: '', age: '', city: '' },
    education: [],
    work: [],
    project: [],
    skills: [],
    evaluation: '',
    customSections: [],
  }
}

/**
 * 刷新简历列表
 */
async function refreshList() {
  records.value = await listResumes()
}

/**
 * 加载指定简历到编辑区
 * @param id 简历 id
 */
async function loadResume(id: number) {
  const rec = await getResumeById(id)
  if (!rec) return
  activeId.value = id
  localData.value = rec.data
  // 加载该简历的排版配置（无则回退默认）
  layoutConfig.value = await getLayoutByResumeId(id)
  // 切换简历后，当前预览脱离了任何预设关联
  activePresetId.value = null
  activePresetName.value = ''
  dirty.value = false
}

/**
 * 页面加载：拉取列表，无简历时自动创建一份默认简历
 */
onMounted(async () => {
  await refreshList()
  if (records.value.length > 0) {
    await loadResume(records.value[0].id)
  } else {
    const id = await createResume('我的简历', emptyResumeData())
    await refreshList()
    await loadResume(id)
  }
})

/**
 * 编辑数据变更（编辑器上报），并联动同步自定义模块标题到排版层显示名
 * @param value 最新简历数据
 */
function onDataChange(value: ResumeData) {
  // 自定义模块改名 → 同步 layoutConfig.modules 的 customTitle（排版弹窗显示用）
  const customs = value.customSections || []
  if (customs.length > 0) {
    const modules = layoutConfig.value.modules.map((m) => {
      if (!m.id.startsWith('custom:')) return m
      const sec = customs.find((s) => s.id === m.id.slice('custom:'.length))
      return sec && sec.title !== m.customTitle ? { ...m, customTitle: sec.title } : m
    })
    layoutConfig.value = { ...layoutConfig.value, modules }
  }
  localData.value = value
  dirty.value = true
}

/**
 * 添加自定义模块：数据入列 + 注入对应排版配置（默认样式、排在末尾）
 * @param sec 新的自定义模块数据
 */
function handleAddCustom(sec: CustomSectionData) {
  localData.value = {
    ...localData.value,
    customSections: [...(localData.value.customSections || []), sec],
  }
  layoutConfig.value = {
    ...layoutConfig.value,
    modules: [...layoutConfig.value.modules, createCustomModuleStyle(sec.id, sec.title)],
  }
  // 已偏离所套用预设，解除关联
  activePresetId.value = null
  activePresetName.value = ''
  dirty.value = true
  ElMessage.success(`已添加自定义模块「${sec.title}」，可在「排版」中调整其样式`)
}

/**
 * 删除自定义模块：数据与排版配置一并移除
 * @param id 自定义模块数据 id
 */
function handleRemoveCustom(id: string) {
  localData.value = {
    ...localData.value,
    customSections: (localData.value.customSections || []).filter((s) => s.id !== id),
  }
  layoutConfig.value = {
    ...layoutConfig.value,
    modules: layoutConfig.value.modules.filter((m) => m.id !== `custom:${id}`),
  }
  // 已偏离所套用预设，解除关联
  activePresetId.value = null
  activePresetName.value = ''
  dirty.value = true
  ElMessage.success('自定义模块已删除')
}

/**
 * 填充示例数据（调试用）：把虚构的完整简历灌入当前编辑区，
 * 仅改本地副本并标记未保存，点「保存」才落库，切走/刷新可丢弃。
 */
function handleFillMock() {
  localData.value = createMockResumeData()
  dirty.value = true
  ElMessage.success('已填充示例数据，点击保存可写入')
}

/**
 * 应用排版弹窗回传的配置（置为未保存，预览经 watch 自动重渲染）
 * @param value 弹窗 draft 配置
 */
function applyLayout(value: ResumeLayoutConfig) {
  layoutConfig.value = value
  // 手动改过排版，已不再等同于任何预设
  activePresetId.value = null
  activePresetName.value = ''
  dirty.value = true
  ElMessage.success('排版已应用，点击保存可写入')
}

/**
 * 拉取排版预设列表（选择排版弹框展开时）
 */
async function loadPresets() {
  presetsLoading.value = true
  try {
    presets.value = await listLayoutPresets()
  } catch (e: any) {
    ElMessage.error(`排版预设加载失败：${e?.message || e}`)
  } finally {
    presetsLoading.value = false
  }
}

/**
 * 应用选中的排版预设到当前简历（预览即时变化，置未保存）
 * @param preset 选中的预设
 */
function handleApplyPreset(preset: LayoutPresetRecord) {
  layoutConfig.value = JSON.parse(JSON.stringify(preset.config))
  // 记录当前预览所套用的预设，供删除时判断；按钮文字改用预设名
  activePresetId.value = preset.id
  activePresetName.value = preset.name
  dirty.value = true
  presetPopoverVisible.value = false
  ElMessage.success(`已应用排版「${preset.name}」，点击保存可写入当前简历`)
}

/**
 * 删除排版预设（二次确认后移除）
 * @param preset 目标预设
 */
async function deletePreset(preset: LayoutPresetRecord) {
  try {
    await ElMessageBox.confirm(`确定删除排版「${preset.name}」？该操作不可恢复。`, '删除排版', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    })
    await deleteLayoutPreset(preset.id)
    // 记录被删项在原列表中的位置，用于回退「上一个排版」
    const idx = presets.value.findIndex((p) => p.id === preset.id)
    presets.value = presets.value.filter((p) => p.id !== preset.id)
    // 若删除的是当前预览的排版，自动切换预览目标
    if (activePresetId.value === preset.id) {
      // 优先取被删项的前一个；删的是第一项时退化为剩余的第一个
      const fallback = idx > 0 ? presets.value[idx - 1] : presets.value[0]
      if (fallback) {
        // 有剩余预设 → 预览切到上一个（或剩余首项）
        layoutConfig.value = JSON.parse(JSON.stringify(fallback.config))
        activePresetId.value = fallback.id
        activePresetName.value = fallback.name
        dirty.value = true
        ElMessage.success(`已删除「${preset.name}」，预览切换至「${fallback.name}」`)
      } else {
        // 全部删完 → 回退默认排版
        layoutConfig.value = JSON.parse(JSON.stringify(defaultLayoutConfig))
        activePresetId.value = null
        activePresetName.value = ''
        dirty.value = true
        ElMessage.success(`已删除「${preset.name}」，已回退默认排版`)
      }
    } else {
      ElMessage.success(`已删除排版「${preset.name}」`)
    }
  } catch (e: any) {
    if (e === 'cancel') return
    ElMessage.error(`删除失败：${e?.message || e}`)
  }
}

/**
 * 另存为：将当前简历（内容 + 排版）复制成一份新简历并切换
 * @param name 新简历名称
 */
async function handleSaveAs(name: string) {
  if (!activeId.value) return
  saving.value = true
  try {
    const id = await createResume(
      name,
      JSON.parse(JSON.stringify(localData.value)),
      activeRecord.value?.templateId || DEFAULT_TEMPLATE_ID
    )
    await saveLayout(id, JSON.parse(JSON.stringify(layoutConfig.value)))
    await refreshList()
    await loadResume(id)
    ElMessage.success(`已另存为「${name}」`)
  } catch (e: any) {
    ElMessage.error(/UNIQUE/i.test(String(e?.message)) ? '已存在同名简历，请换个名称' : `另存为失败：${e?.message || e}`)
  } finally {
    saving.value = false
  }
}

/**
 * 保存当前简历（内容；名称由顶部选择器重命名管理）
 * @throws 写库失败时 ElMessage 提示
 */
async function handleSave() {
  if (!activeId.value) return
  saving.value = true
  try {
    await updateResume(activeId.value, localData.value)
    // 排版配置一并落库（resume_layout 表）
    await saveLayout(activeId.value, layoutConfig.value)
    await refreshList()
    dirty.value = false
    ElMessage.success('保存成功')
  } catch (e: any) {
    ElMessage.error(`保存失败：${e?.message || e}`)
  } finally {
    saving.value = false
  }
}

/**
 * 切换选中的简历（有未保存更改时先静默保存）
 * @param id 目标简历 id
 */
async function handleSelect(id: number) {
  if (id === activeId.value) return
  // 有未保存更改时自动保存（内容 + 排版），避免丢失
  if (dirty.value && activeId.value) {
    try {
      await updateResume(activeId.value, localData.value)
      await saveLayout(activeId.value, layoutConfig.value)
      await refreshList()
    } catch (e: any) {
      ElMessage.error(`自动保存失败：${e?.message || e}`)
      return
    }
  }
  await loadResume(id)
}

/**
 * 新建简历
 * @param name 简历名称（侧栏弹窗输入）
 */
async function handleCreate(name: string) {
  try {
    const id = await createResume(name, emptyResumeData())
    await refreshList()
    await loadResume(id)
    ElMessage.success('创建成功')
  } catch (e: any) {
    ElMessage.error(/UNIQUE/i.test(String(e?.message)) ? '已存在同名简历，请换个名称' : `创建失败：${e?.message || e}`)
  }
}

/**
 * 重命名简历（立即落库）
 * @param id 简历 id
 * @param name 新名称
 */
async function handleRename(id: number, name: string) {
  try {
    const rec = await getResumeById(id)
    if (!rec) return
    await updateResume(id, rec.data, { name })
    await refreshList()
  } catch (e: any) {
    ElMessage.error(/UNIQUE/i.test(String(e?.message)) ? '已存在同名简历，请换个名称' : `重命名失败：${e?.message || e}`)
  }
}

/**
 * 删除简历（若是当前简历则切换到列表第一条）
 * @param id 简历 id
 */
async function handleRemove(id: number) {
  try {
    await deleteResume(id)
    await refreshList()
    if (id === activeId.value) {
      if (records.value.length > 0) {
        await loadResume(records.value[0].id)
      } else {
        const nid = await createResume('我的简历', emptyResumeData())
        await refreshList()
        await loadResume(nid)
      }
    }
    ElMessage.success('已删除')
  } catch (e: any) {
    ElMessage.error(`删除失败：${e?.message || e}`)
  }
}

/**
 * 生成导出文件名：简历名称-时间戳.pdf（与项目 CSV 导出格式一致）
 * @returns 如 张三-20260830-162000.pdf
 */
function buildExportFileName(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  const ts = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  const base = activeRecord.value?.name?.trim() || '简历'
  return `${base}-${ts}.pdf`
}

/**
 * 导出 PDF：先落库保存，再把模板渲染的 HTML 交给主进程 printToPDF
 */
async function handleExport() {
  if (!activeId.value) return
  exporting.value = true
  try {
    if (dirty.value) {
      await updateResume(activeId.value, localData.value)
      await saveLayout(activeId.value, layoutConfig.value)
      await refreshList()
      dirty.value = false
    }
    // 导出 HTML 经离屏 iframe 分页切分（与预览同一套逻辑），PDF 每页即一张 .rfs-page
    const rawHtml = currentTemplate.value.render(localData.value, layoutConfig.value)
    const html = await buildPaginatedHtml(rawHtml, { innerSplit: innerSplit.value })
    // 统一导出规范：直写缓存目录、不弹保存框，成功用 fileNotify 提示（蓝色可点击路径）
    const res = await ipc.invoke('resume:export-pdf', {
      html,
      fileName: buildExportFileName(),
      dir: fileCachePathC.value,
    })
    if (res && res.ok) {
      fileNotify({ title: '简历 PDF 已导出', filePath: res.path })
    } else if (res && res.canceled) {
      // 用户取消（仅在未传 dir 走保存对话框时出现），不提示
    } else {
      ElMessage.error(`导出失败：${(res && res.error) || '未知错误'}`)
    }
  } catch (e: any) {
    ElMessage.error(`导出失败：${e?.message || e}`)
  } finally {
    exporting.value = false
  }
}
</script>

<style scoped>
.resume-page {
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--border-subtle);
  background: var(--bg-card);
  flex-shrink: 0;
}
.dirty-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--color-warning);
  display: inline-block;
}
.toolbar-right {
  display: flex;
  align-items: center;
  gap: 8px;
}
.toolbar-right :deep(.el-button) {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
/* 选择排版按钮：选中预设后文字显示预设名，并用主题主色强调 */
.preset-trigger-label {
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
:deep(.el-button.is-active) .preset-trigger-label {
  color: var(--color-primary);
}
.main-area {
  flex: 1;
  min-height: 0;
  display: flex;
  overflow: hidden;
}
.editor-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--text-muted);
  font-size: 13px;
}
</style>

<!-- 排版选择弹框内容（el-popover 默认 teleport 到 body，scoped 样式无法命中，故用非 scoped） -->
<style>
.resume-preset-popper .preset-pop {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.resume-preset-popper .preset-list {
  max-height: 260px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0 -4px;
  padding: 0 4px;
}
.resume-preset-popper .preset-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 8px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
  color: var(--text-primary);
}
.resume-preset-popper .preset-item:hover {
  background: var(--bg-hover);
}
/* 当前预览所套用的排版：跟随主题主色高亮，使「当前预览项」在 UI 上可见 */
.resume-preset-popper .preset-item.is-active {
  background: var(--color-primary-light);
  color: var(--color-primary);
}
.resume-preset-popper .preset-item.is-active .preset-name {
  color: var(--color-primary);
  font-weight: 600;
}
.resume-preset-popper .preset-check {
  flex-shrink: 0;
  color: var(--color-primary);
}
.resume-preset-popper .preset-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.resume-preset-popper .preset-del {
  border: none;
  background: transparent;
  cursor: pointer;
  color: var(--text-muted);
  padding: 2px;
  border-radius: 5px;
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
}
.resume-preset-popper .preset-del:hover {
  color: var(--color-error);
  background: color-mix(in srgb, var(--color-error) 12%, transparent);
}
.resume-preset-popper .preset-empty {
  font-size: 12px;
  color: var(--text-muted);
  text-align: center;
  padding: 16px 0;
}
</style>

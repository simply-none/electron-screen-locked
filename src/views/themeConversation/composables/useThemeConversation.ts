/**
 * 主题对话 - 组合式状态管理（模块级单例）
 * ------------------------------------------------------------------
 * 所有组件（主题列表 / 工具栏 / 对话列表 / 输入框 / 引用弹窗）共享同一份状态，
 * 因此把状态与数据库操作收敛到此组合式函数中。
 *
 * 设计要点：
 * - 状态为模块级单例，同一渲染窗口内任意组件 import 后拿到的是同一份数据；
 *   后续新增「小窗模式」时，只需在新窗口中 import 本模块并调用 init()，即可复用全部逻辑与组件。
 * - 数据库操作统一走 db.ts（newSql.ts 的 new-sql:* 通道）。
 * - 引用关系用 JSON 字符串数组存储，支持「引用一个或多个」「一个对话被多次引用」。
 */
import { ref, computed } from 'vue';
import moment from 'moment';
import { dbQuery, dbInsert, dbUpdate, dbDelete, dbExecute } from '../db';
import { TABLE, TAG_SCOPE } from '../types';
import { isRichContent, stripTags } from './richText';

/* ============================ 工具函数 ============================ */

/** 把数据库中的 JSON 字符串数组安全地解析为字符串数组 */
function parseArr(value: any): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(String);
  try {
    const arr = JSON.parse(value);
    return Array.isArray(arr) ? arr.map(String) : [];
  } catch {
    return [];
  }
}

/** 当前时间字符串，格式与项目其它模块保持一致（YYYY-MM-DD HH:mm:ss，本地时区） */
function nowStr(): string {
  return moment().format('YYYY-MM-DD HH:mm:ss');
}

/* ============================ 共享状态 ============================ */

const themes = ref<any[]>([]);                 // 全部对话主题
const themeCounts = ref<Record<number, number>>({}); // 各主题下的对话数量
const tags = ref<any[]>([]);                   // 全部标签
const currentThemeId = ref<number | null>(null); // 当前选中的主题 id
const conversations = ref<any[]>([]);          // 当前主题下的全部对话
const loading = ref(false);

const searchKeyword = ref('');                 // 搜索关键字（主题字段 / 对话内容字段 / 标签）
const activeTagFilter = ref<string>('');       // 按标签筛选（标签分类），存标签 id

const searchResults = ref<any[]>([]);          // 搜索结果（跨主题）

/** 引用抽屉：展示被引用的历史对话信息 */
const referenceDrawer = ref<{ open: boolean; title: string; items: any[] }>({
  open: false,
  title: '',
  items: [],
});

/**
 * 输入框草稿态：待发送新对话所引用的历史对话 id 列表。
 * 集中存放，便于「气泡右下角引用按钮 / 右键引用 / 多选批量引用」多种入口汇入同一处，
 * 发送新对话时一并带上；发送后清空。
 */
const pendingRefIds = ref<string[]>([]);

/**
 * 跨主题引用草稿：待发送新对话所引用的「其它主题」对话列表。
 * 元素为 { themeId, convId }，与同主题引用 pendingRefIds 相互独立、并列存在。
 */
const pendingCrossRefs = ref<Array<{ themeId: number; convId: number }>>([]);

/** 多选模式开关（底部「多选」按钮控制） */
const multiselect = ref(false);

/** 多选模式下选中的对话 id 列表 */
const selectedIds = ref<string[]>([]);

/** 高亮定位：点击引用弹窗中的某条对话后，中间列表滚动到该项并高亮 */
const highlightConvId = ref<number | null>(null);
/** 自增信号：即使重复点击同一条对话，也能重新触发定位与高亮 */
const highlightTick = ref(0);

/** 跨主题引用选择弹窗开关（全局单例，由输入框工具条 / 右键菜单唤起） */
const crossRefPickerOpen = ref(false);

/**
 * 跨主题「被引用」统计：目标对话 id -> 引用它的来源对话列表（含主题名）。
 * 与同主题 referencedIds 不同——来源对话在其它主题，无法从当前列表推断，
 * 需要全局扫描 cross_refs 字段构建（见 loadCrossReferenced）。
 */
const crossReferencedBy = ref<Record<number, any[]>>({});

/* ============================ 计算属性 ============================ */

/** 是否处于搜索/筛选状态 */
const isSearching = computed(() => !!searchKeyword.value.trim() || !!activeTagFilter.value);

/** 实际展示的对话列表：搜索时展示跨主题结果，否则展示当前主题对话（保持真实时间顺序，置顶项不重排） */
const displayConversations = computed(() => {
  if (isSearching.value) return searchResults.value;
  return conversations.value;
});

/**
 * 被引用的对话 id 集合：
 * 遍历当前展示列表，收集所有 reference 目标 id。
 * 用于让「被引用」的对话呈现不同样式。
 */
const referencedIds = computed(() => {
  const set = new Set<string>();
  displayConversations.value.forEach((c: any) => {
    parseArr(c.ref_ids).forEach((rid) => set.add(String(rid)));
  });
  return set;
});

/* ============================ 主题相关 ============================ */

async function loadThemes() {
  const rows = await dbQuery({
    tableName: TABLE.THEME,
    orderBy: 'update_time',
    orderByDesc: true,
  });
  themes.value = rows;
  // 若当前没有选中主题，默认选中最近更新的一个
  if (currentThemeId.value == null && rows.length) {
    currentThemeId.value = rows[0].id;
  }
  await loadThemeCounts();
  return rows;
}

/** 统计每个主题下的对话数量（用于左侧列表角标） */
async function loadThemeCounts() {
  try {
    const rows = await dbExecute(
      `SELECT theme_id, COUNT(*) as cnt FROM ${TABLE.CONVERSATION} GROUP BY theme_id`
    );
    const map: Record<number, number> = {};
    rows.forEach((r: any) => {
      map[Number(r.theme_id)] = Number(r.cnt);
    });
    themeCounts.value = map;
  } catch {
    themeCounts.value = {};
  }
}

async function loadTags() {
  tags.value = await dbQuery({
    tableName: TABLE.TAG,
    orderBy: 'id',
    orderByDesc: false,
  });
}

/** 选中某个主题并加载其对话 */
async function selectTheme(id: number) {
  currentThemeId.value = id;
  searchKeyword.value = '';
  activeTagFilter.value = '';
  await loadConversations(id);
}

/** 加载某主题下的全部对话（按创建时间升序，聊天气泡从旧到新排列） */
async function loadConversations(themeId: number = currentThemeId.value as number) {
  if (!themeId) {
    conversations.value = [];
    return [];
  }
  const rows = await dbQuery({
    tableName: TABLE.CONVERSATION,
    conditions: { theme_id: themeId },
    orderBy: 'create_time',
    orderByDesc: false,
  });
  conversations.value = rows;
  // 同步跨主题「被引用」统计（标记依赖全局 cross_refs 扫描）
  await loadCrossReferenced();
  return rows;
}

/** 新建主题（parentId 不为空时为子主题） */
async function createTheme(title: string, tagIds: string[] = [], parentId?: number | null) {
  const t = nowStr();
  const res = await dbInsert(TABLE.THEME, {
    title,
    tags: JSON.stringify(tagIds),
    create_time: t,
    update_time: t,
    remark: '',
    // 子主题记录父主题 id（parent_id 列，TEXT；顶级主题存空串）
    parent_id: parentId ? String(parentId) : '',
  });
  const item = {
    id: res.lastID,
    title,
    tags: JSON.stringify(tagIds),
    create_time: t,
    update_time: t,
    remark: '',
    parent_id: parentId ? String(parentId) : '',
  };
  themes.value.unshift(item);
  currentThemeId.value = item.id;
  await loadConversations(item.id);
  return item;
}

/**
 * 按标题查找主题，不存在则新建。
 * 提醒「结束后记录」场景使用：同名提醒的情绪会汇总到同一主题下，
 * 而不是每次都新建重复主题。
 */
async function findOrCreateThemeByTitle(title: string) {
  await loadThemes();
  const existing = themes.value.find((t) => t.title === title);
  if (existing) {
    currentThemeId.value = existing.id;
    if (!conversations.value.length) await loadConversations(existing.id);
    return existing;
  }
  return await createTheme(title);
}

/** 更新主题（标题 / 标签 / 备注） */
async function updateTheme(id: number, patch: { title?: string; tags?: string[]; remark?: string }) {
  const data: any = { update_time: nowStr() };
  if (patch.title !== undefined) data.title = patch.title;
  if (patch.remark !== undefined) data.remark = patch.remark;
  if (patch.tags !== undefined) data.tags = JSON.stringify(patch.tags);
  await dbUpdate(TABLE.THEME, data, { id });
  await loadThemes();
  if (currentThemeId.value === id) await loadConversations(id);
}

/** 删除主题（同时删除其下全部对话；存在子主题时禁止删除） */
async function deleteTheme(id: number) {
  if (hasChildThemes(id)) {
    throw new Error('该主题下存在子主题，请先删除其下全部子主题后再删除');
  }
  await dbDelete(TABLE.CONVERSATION, { theme_id: id });
  await dbDelete(TABLE.THEME, { id });
  await loadThemes();
  if (currentThemeId.value === id) {
    currentThemeId.value = themes.value.length ? themes.value[0].id : null;
    if (currentThemeId.value) await loadConversations(currentThemeId.value);
  }
}

/**
 * 清空主题对话功能相关的全部数据库数据（对话 / 主题 / 标签），
 * 并重置内存状态。属不可逆的破坏性操作，调用方需先二次确认。
 */
async function clearAllData() {
  await dbExecute(`DELETE FROM ${TABLE.CONVERSATION}`);
  await dbExecute(`DELETE FROM ${TABLE.THEME}`);
  await dbExecute(`DELETE FROM ${TABLE.TAG}`);
  themes.value = [];
  themeCounts.value = {};
  tags.value = [];
  conversations.value = [];
  currentThemeId.value = null;
  await loadThemeCounts();
}

/* ============================ 子主题（层级） ============================ */

/** 主题树节点：{ theme, children } 递归结构，供树形渲染 */
interface ThemeNode {
  theme: any;
  children: ThemeNode[];
}

/** 折叠状态：存被收起的主题 id（仅含子主题的父主题可折叠） */
const collapsedIds = ref<Set<number>>(new Set());

/** 递归构建主题树（loadThemes 已按 update_time 倒序，子主题挂到对应父主题下） */
const themeTree = computed<ThemeNode[]>(() => {
  const map = new Map<number, ThemeNode>();
  themes.value.forEach((t) => {
    map.set(t.id, { theme: t, children: [] });
  });
  const roots: ThemeNode[] = [];
  map.forEach((node) => {
    const pid = node.theme.parent_id;
    const parent = pid ? map.get(Number(pid)) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  });
  return roots;
});

/** 平铺可见主题：按树顺序输出，含缩进深度；被折叠主题的子树跳过 */
const flatThemeTree = computed(() => {
  const out: Array<{ theme: any; depth: number; hasChildren: boolean; collapsed: boolean }> = [];
  const walk = (nodes: ThemeNode[], depth: number) => {
    nodes.forEach((node) => {
      const hasChildren = node.children.length > 0;
      const collapsed = collapsedIds.value.has(node.theme.id);
      out.push({ theme: node.theme, depth, hasChildren, collapsed });
      if (hasChildren && !collapsed) walk(node.children, depth + 1);
    });
  };
  walk(themeTree.value, 0);
  return out;
});

/** 展开 / 收起某主题（仅含子主题时有效） */
function toggleCollapse(id: number) {
  const s = new Set(collapsedIds.value);
  if (s.has(id)) s.delete(id);
  else s.add(id);
  collapsedIds.value = s;
}

/** 判断主题是否存在直接子主题（删除保护用：有子主题则禁止删除父主题） */
function hasChildThemes(id: number): boolean {
  return themes.value.some((t) => t.parent_id === String(id));
}

/** 子主题创建弹窗状态：sourceConvs 为预置到新主题输入框草稿的跨主题引用（发起子主题的源对话） */
const subThemeDialog = ref<{
  visible: boolean;
  sourceConvs: Array<{ themeId: number; convId: number }>;
}>({ visible: false, sourceConvs: [] });

/** 打开子主题创建弹窗（右键 / 多选传入源对话作为跨主题引用） */
function openSubThemeDialog(sourceConvs: Array<{ themeId: number; convId: number }> = []) {
  subThemeDialog.value = { visible: true, sourceConvs };
}

function closeSubThemeDialog() {
  subThemeDialog.value = { ...subThemeDialog.value, visible: false };
}

/** 确认创建子主题：建主题 -> 自动切换 -> 源对话预置为跨主题引用草稿 */
async function confirmSubTheme(title: string, tagIds: string[]) {
  const parentId = currentThemeId.value;
  if (!parentId) throw new Error('请先选择父主题');
  const refs = subThemeDialog.value.sourceConvs || [];
  await createTheme(title, tagIds, parentId);
  if (refs.length) addPendingCrossRefs(refs);
  closeSubThemeDialog();
}

/* ============================ 对话相关 ============================ */

/** 新建对话 */
async function createConversation(payload: {
  content: string;
  references?: string[];
  crossRefs?: Array<{ themeId: number; convId: number }>;
  tags?: string[];
  annotateTime?: string;
  pinned?: string;
}) {
  const themeId = currentThemeId.value;
  if (!themeId) throw new Error('请先选择或创建一个主题');
  const t = nowStr();
  // 按内容是否含实际格式归一化：富文本存 HTML，纯文本去标签存纯文本，并写 is_rich
  const rich = isRichContent(payload.content);
  const data = {
    theme_id: themeId,
    content: rich ? payload.content : stripTags(payload.content),
    is_rich: rich ? '1' : '0',
    // 注意：列名 ref_ids（避免用保留字 references 触发 SQLITE_ERROR）
    ref_ids: JSON.stringify(payload.references || []),
    // 跨主题引用：JSON 数组，元素为 { themeId, convId }
    cross_refs: JSON.stringify(payload.crossRefs || []),
    tags: JSON.stringify(payload.tags || []),
    create_time: t,
    annotate_time: payload.annotateTime || '',
    pinned: payload.pinned || '0',
    is_deleted: '0',
  };
  const res = await dbInsert(TABLE.CONVERSATION, data);
  const item = { id: res.lastID, ...data };
  conversations.value.push(item);
  // 同步刷新主题的更新时间
  await dbUpdate(TABLE.THEME, { update_time: t }, { id: themeId });
  await loadThemeCounts();
  return item;
}

/** 更新对话 */
async function updateConversation(id: number, patch: any) {
  const data: any = { ...patch };
  if (patch.tags !== undefined) data.tags = JSON.stringify(patch.tags);
  // 引用列 ref_ids 必须存字符串：兼容「references」与「ref_ids」两种传入形式
  if (patch.references !== undefined) {
    data.ref_ids = JSON.stringify(patch.references);
    delete data.references; // 防止 camelCase 键残留在更新数据里
  } else if (patch.ref_ids !== undefined && Array.isArray(patch.ref_ids)) {
    data.ref_ids = JSON.stringify(patch.ref_ids);
  }
  // 跨主题引用：存 JSON 数组（兼容传入 crossRefs 或 cross_refs）
  if (patch.crossRefs !== undefined) {
    data.cross_refs = JSON.stringify(patch.crossRefs);
    delete data.crossRefs;
  } else if (patch.cross_refs !== undefined && Array.isArray(patch.cross_refs)) {
    data.cross_refs = JSON.stringify(patch.cross_refs);
  }
  // 内容变更时按是否含格式归一化，并同步 is_rich
  if (patch.content !== undefined) {
    const rich = isRichContent(patch.content);
    data.content = rich ? patch.content : stripTags(patch.content);
    data.is_rich = rich ? '1' : '0';
  }
  await dbUpdate(TABLE.CONVERSATION, data, { id });
  const idx = conversations.value.findIndex((c) => c.id === id);
  if (idx >= 0) conversations.value[idx] = { ...conversations.value[idx], ...data };
}

/** 删除对话（软删除，便于后续追溯历史） */
async function deleteConversation(id: number) {
  await dbDelete(TABLE.CONVERSATION, { id });
  conversations.value = conversations.value.filter((c) => c.id !== id);
  await loadThemeCounts();
}

/* ============================ 标签相关 ============================ */

/** 新建标签 */
async function createTag(name: string, color: string, scope: string = TAG_SCOPE.CONVERSATION) {
  const res = await dbInsert(TABLE.TAG, { name, color, scope, create_time: nowStr() });
  const item = { id: res.lastID, name, color, scope, create_time: nowStr() };
  tags.value.push(item);
  return item;
}

/** 修改标签（重命名 / 改色）。引用该标签的主题与对话仅存 id，因此无需回写 */
async function updateTag(id: number, patch: { name?: string; color?: string }) {
  const data: any = {};
  if (patch.name !== undefined) data.name = patch.name;
  if (patch.color !== undefined) data.color = patch.color;
  await dbUpdate(TABLE.TAG, data, { id });
  await loadTags();
}

/** 删除标签，并从其关联的主题 / 对话的 tags 字段中移除该标签引用 */
async function deleteTag(id: number) {
  await dbDelete(TABLE.TAG, { id });
  // 主题 tags 字段移除
  const themeRows = await dbQuery({ tableName: TABLE.THEME });
  for (const th of themeRows) {
    const ids = parseArr(th.tags).filter((x) => x !== String(id));
    await dbUpdate(TABLE.THEME, { tags: JSON.stringify(ids) }, { id: th.id });
  }
  // 对话 tags 字段移除
  const convRows = await dbQuery({ tableName: TABLE.CONVERSATION });
  for (const cv of convRows) {
    const ids = parseArr(cv.tags).filter((x) => x !== String(id));
    await dbUpdate(TABLE.CONVERSATION, { tags: JSON.stringify(ids) }, { id: cv.id });
  }
  await loadTags();
  await loadThemes();
  if (currentThemeId.value) await loadConversations(currentThemeId.value);
}

function getTagById(id: any) {
  return tags.value.find((t) => t.id === Number(id));
}
function tagName(id: any): string {
  const t = getTagById(id);
  return t ? t.name : '';
}
function tagColor(id: any): string {
  const t = getTagById(id);
  return t ? t.color : '#94a3b8';
}

/* ============================ 搜索（主题字段 / 对话内容 / 标签） ============================ */

/**
 * 执行搜索：跨主题检索对话内容、标签、主题标题，并支持按标签 id 精确筛选。
 * 结果按创建时间倒序，便于快速回溯。
 */
async function runSearch() {
  const kw = searchKeyword.value.trim();
  const tagFilter = activeTagFilter.value;
  if (!kw && !tagFilter) {
    searchResults.value = [];
    return;
  }

  let sql = `SELECT c.*, t.title as theme_title FROM ${TABLE.CONVERSATION} c
             LEFT JOIN ${TABLE.THEME} t ON c.theme_id = t.id
             WHERE 1=1`;
  const params: any[] = [];

  if (kw) {
    // 关键字匹配：对话内容、主题标题，以及名称包含关键字的标签
    const matchedTagIds = tags.value
      .filter((t) => t.name.includes(kw))
      .map((t) => String(t.id));
    sql += ` AND (c.content LIKE ? OR t.title LIKE ?`;
    params.push(`%${kw}%`, `%${kw}%`);
    if (matchedTagIds.length) {
      const tagConds = matchedTagIds.map(() => `c.tags LIKE ?`).join(' OR ');
      sql += ` OR ${tagConds}`;
      matchedTagIds.forEach((id) => params.push(`%"${id}"%`));
    }
    sql += `)`;
  }

  if (tagFilter) {
    // 标签筛选：对话 tags 字段为 JSON 数组，如 ["3","5"]
    sql += ` AND c.tags LIKE ?`;
    params.push(`%"${tagFilter}"%`);
  }

  sql += ` ORDER BY c.create_time DESC`;
  searchResults.value = await dbExecute(sql, params);
  // 搜索态同样更新「被跨引用」标记（搜索结果可能跨主题）
  await loadCrossReferenced();
}

function clearSearch() {
  searchKeyword.value = '';
  activeTagFilter.value = '';
  searchResults.value = [];
}

/* ============================ 引用相关 ============================ */

/** 按 id 查询单条对话（跨主题，用于弹窗回填历史对话信息） */
async function getConversationById(id: number) {
  const rows = await dbQuery({ tableName: TABLE.CONVERSATION, conditions: { id } });
  return rows[0] || null;
}

/** 打开引用抽屉，展示某条对话引用的全部历史对话 */
async function showReferenceTargets(conv: any) {
  const ids = parseArr(conv.ref_ids);
  const items: any[] = [];
  for (const id of ids) {
    const found = conversations.value.find((c) => c.id === Number(id));
    items.push(found || (await getConversationById(Number(id))));
  }
  referenceDrawer.value = {
    open: true,
    title: `引用的历史对话（${items.filter(Boolean).length}）`,
    items: items.filter(Boolean),
  };
}

/** 打开引用抽屉，展示「引用了本条对话」的全部来源对话 */
async function showReferencedBy(conv: any) {
  const rows = await dbExecute(
    `SELECT c.*, t.title as theme_title FROM ${TABLE.CONVERSATION} c
     LEFT JOIN ${TABLE.THEME} t ON c.theme_id = t.id
     WHERE c.ref_ids LIKE ?`,
    [`%"${conv.id}"%`]
  );
  referenceDrawer.value = {
    open: true,
    title: `被 ${rows.length} 条对话引用`,
    items: rows,
  };
}

/** 内部：解析 cross_refs 字段为 [{ themeId, convId }]（与展示侧 ConversationBubble 逻辑一致） */
function parseCrossRefsValue(value: any): Array<{ themeId: number; convId: number }> {
  if (!value) return [];
  if (Array.isArray(value)) return value as Array<{ themeId: number; convId: number }>;
  try {
    const arr = JSON.parse(value);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/**
 * 加载「跨主题被引用」统计：
 * 扫描全部含跨主题引用的对话，解析出每个被引用目标对话（跨主题），
 * 构建 目标 convId -> 来源对话列表，供气泡显示「被跨引用」标记。
 * 在加载主题对话 / 搜索后调用，保证标记与当前列表同步。
 */
async function loadCrossReferenced() {
  try {
    const rows = await dbExecute(
      `SELECT c.*, t.title as theme_title FROM ${TABLE.CONVERSATION} c
       LEFT JOIN ${TABLE.THEME} t ON c.theme_id = t.id
       WHERE c.cross_refs IS NOT NULL AND c.cross_refs <> '' AND c.cross_refs <> '[]'`
    );
    const map: Record<number, any[]> = {};
    rows.forEach((src: any) => {
      parseCrossRefsValue(src.cross_refs).forEach((r) => {
        const tid = Number(r.convId);
        if (!map[tid]) map[tid] = [];
        map[tid].push(src);
      });
    });
    crossReferencedBy.value = map;
  } catch {
    crossReferencedBy.value = {};
  }
}

/** 打开引用抽屉，展示「以跨主题引用指向本条对话」的全部来源对话 */
function showCrossReferencedBy(conv: any) {
  const sources = crossReferencedBy.value[Number(conv.id)] || [];
  referenceDrawer.value = {
    open: true,
    title: `反向链接（被 ${sources.length} 条对话跨主题引用）`,
    items: sources,
  };
}

/**
 * 全局「同主题被引用」统计：目标对话 id -> 被 ref_ids 指向的次数。
 * 供跨主题引用选择抽屉等场景展示「被引用」徽标（与当前列表无关，全局准确）。
 */
const referencedByCounts = ref<Record<number, number>>({});
async function loadReferencedByCounts() {
  try {
    const rows = await dbExecute(
      `SELECT ref_ids FROM ${TABLE.CONVERSATION}
       WHERE ref_ids IS NOT NULL AND ref_ids <> '' AND ref_ids <> '[]'`
    );
    const map: Record<number, number> = {};
    rows.forEach((r: any) => {
      parseArr(r.ref_ids).forEach((id) => {
        const n = Number(id);
        map[n] = (map[n] || 0) + 1;
      });
    });
    referencedByCounts.value = map;
  } catch {
    referencedByCounts.value = {};
  }
}

/**
 * 打开引用抽屉，展示「本条对话的跨主题引用目标」对话记录（与同主题 showReferenceTargets 对应）。
 * ref 为空时展示全部目标（flag 点击），非空时仅展示该条（单个 chip 点击）。
 * 抽屉内点击记录由 ReferenceDrawer 的 locateConversation 负责：切换主题 + 滚动高亮定位。
 */
async function showCrossRefTargets(
  conv: any,
  ref?: { themeId: number; convId: number } | null,
) {
  const refs = ref ? [ref] : parseCrossRefsValue(conv?.cross_refs);
  const items: any[] = [];
  for (const r of refs) {
    const rows = await dbExecute(
      `SELECT c.*, t.title as theme_title FROM ${TABLE.CONVERSATION} c
       LEFT JOIN ${TABLE.THEME} t ON c.theme_id = t.id
       WHERE c.id = ?`,
      [r.convId]
    );
    if (rows[0]) items.push(rows[0]);
  }
  referenceDrawer.value = {
    open: true,
    title: `正向链接（跨主题引用了 ${items.length} 条对话）`,
    items,
  };
}

function closeReferenceDrawer() {
  referenceDrawer.value = { ...referenceDrawer.value, open: false };
}

/** 直接展示单条对话详情（如点击输入框中的引用 chip） */
function showConversationDetail(conv: any) {
  referenceDrawer.value = {
    open: true,
    title: '历史对话详情',
    items: conv ? [conv] : [],
  };
}

/**
 * 从引用弹窗「定位」某条对话：确保该对话出现在中间列表（必要时切换主题 / 退出搜索），
 * 关闭弹窗后让列表滚动到该项并高亮，便于从引用关系中回溯原始对话。
 */
async function locateConversation(id: number) {
  const numId = Number(id);
  const existing = displayConversations.value.find((c) => c.id === numId);
  let conv = existing;
  if (!conv) conv = await getConversationById(numId);
  if (!conv) return;

  // 若目标对话不在当前展示列表中，需先把它纳入列表（切换主题或退出搜索重载）
  if (!existing) {
    const themeId = conv.theme_id != null ? Number(conv.theme_id) : currentThemeId.value;
    if (themeId != null && themeId !== currentThemeId.value) {
      await selectTheme(themeId);
    } else {
      clearSearch();
      await loadConversations(currentThemeId.value as number);
    }
  }

  // 关闭弹窗，让列表可见；随后由 ConversationList 监听 highlightTick 滚动并高亮
  closeReferenceDrawer();
  highlightConvId.value = numId;
  highlightTick.value++;
}

/* ============================ 草稿引用 / 多选 ============================ */

/** 把一条历史对话加入输入框草稿引用（去重） */
function addPendingRef(id: number | string) {
  const sid = String(id);
  if (!pendingRefIds.value.includes(sid)) pendingRefIds.value.push(sid);
}

/** 批量加入草稿引用（多选批量引用场景） */
function addPendingRefs(ids: Array<number | string>) {
  ids.forEach((id) => {
    const sid = String(id);
    if (!pendingRefIds.value.includes(sid)) pendingRefIds.value.push(sid);
  });
}

/** 从草稿引用中移除某条 */
function removePendingRef(id: number | string) {
  const sid = String(id);
  pendingRefIds.value = pendingRefIds.value.filter((x) => x !== sid);
}

/** 清空草稿引用（发送新对话后调用） */
function clearPendingRefs() {
  pendingRefIds.value = [];
  pendingCrossRefs.value = [];
}

/* ============================ 跨主题引用 ============================ */

/** 按主题 id 查询该主题下的全部对话（升序），用于跨主题引用的选择 / 定位弹窗 */
async function getConversationsByTheme(themeId: number) {
  if (!themeId) return [];
  return dbQuery({
    tableName: TABLE.CONVERSATION,
    conditions: { theme_id: themeId },
    orderBy: 'create_time',
    orderByDesc: false,
  });
}

/** 打开跨主题引用选择弹窗 */
function openCrossRefPicker() {
  crossRefPickerOpen.value = true;
}
function closeCrossRefPicker() {
  crossRefPickerOpen.value = false;
}

/** 把选中的跨主题引用加入输入框草稿（按 themeId+convId 去重） */
function addPendingCrossRefs(refs: Array<{ themeId: number; convId: number }>) {
  refs.forEach((r) => {
    const exists = pendingCrossRefs.value.some(
      (x) => x.themeId === r.themeId && x.convId === r.convId,
    );
    if (!exists) pendingCrossRefs.value.push({ themeId: r.themeId, convId: r.convId });
  });
}

/** 从草稿移除某条跨主题引用 */
function removePendingCrossRef(ref: { themeId: number; convId: number }) {
  pendingCrossRefs.value = pendingCrossRefs.value.filter(
    (x) => !(x.themeId === ref.themeId && x.convId === ref.convId),
  );
}

/** 进入 / 退出多选模式（退出时自动清空已选，避免脏状态） */
function toggleMultiselect() {
  multiselect.value = !multiselect.value;
  if (!multiselect.value) selectedIds.value = [];
}

/** 切换某条对话的选中态（多选模式下） */
function toggleSelect(id: number | string) {
  const sid = String(id);
  const i = selectedIds.value.indexOf(sid);
  if (i >= 0) selectedIds.value.splice(i, 1);
  else selectedIds.value.push(sid);
}

/** 清空多选选择 */
function clearSelection() {
  selectedIds.value = [];
}

/* ============================ 初始化 ============================ */

/**
 * 确保三张业务表及其列存在。
 * newSql 在首次访问表时会用默认列（name/value/created_at）建表，
 * 为避免「表已建但业务列尚未存在」导致查询/统计报错，这里在初始化时
 * 用 ALTER TABLE 补齐各业务列（列已存在时忽略错误，幂等安全）。
 */
async function ensureSchema() {
  // 先触发建表（若无则按 newSql 默认列创建）
  await dbQuery({ tableName: TABLE.THEME, limit: 1 });
  await dbQuery({ tableName: TABLE.CONVERSATION, limit: 1 });
  await dbQuery({ tableName: TABLE.TAG, limit: 1 });

  const alters = [
    `ALTER TABLE ${TABLE.THEME} ADD COLUMN title TEXT`,
    `ALTER TABLE ${TABLE.THEME} ADD COLUMN tags TEXT`,
    `ALTER TABLE ${TABLE.THEME} ADD COLUMN create_time TEXT`,
    `ALTER TABLE ${TABLE.THEME} ADD COLUMN update_time TEXT`,
    `ALTER TABLE ${TABLE.THEME} ADD COLUMN remark TEXT`,
    `ALTER TABLE ${TABLE.THEME} ADD COLUMN parent_id TEXT`,
    `ALTER TABLE ${TABLE.CONVERSATION} ADD COLUMN theme_id TEXT`,
    `ALTER TABLE ${TABLE.CONVERSATION} ADD COLUMN content TEXT`,
    `ALTER TABLE ${TABLE.CONVERSATION} ADD COLUMN ref_ids TEXT`,
    `ALTER TABLE ${TABLE.CONVERSATION} ADD COLUMN tags TEXT`,
    `ALTER TABLE ${TABLE.CONVERSATION} ADD COLUMN create_time TEXT`,
    `ALTER TABLE ${TABLE.CONVERSATION} ADD COLUMN annotate_time TEXT`,
    `ALTER TABLE ${TABLE.CONVERSATION} ADD COLUMN pinned TEXT`,
    `ALTER TABLE ${TABLE.CONVERSATION} ADD COLUMN is_deleted TEXT`,
    `ALTER TABLE ${TABLE.CONVERSATION} ADD COLUMN is_rich TEXT`,
    `ALTER TABLE ${TABLE.CONVERSATION} ADD COLUMN cross_refs TEXT`,
    `ALTER TABLE ${TABLE.TAG} ADD COLUMN name TEXT`,
    `ALTER TABLE ${TABLE.TAG} ADD COLUMN color TEXT`,
    `ALTER TABLE ${TABLE.TAG} ADD COLUMN scope TEXT`,
    `ALTER TABLE ${TABLE.TAG} ADD COLUMN create_time TEXT`,
  ];
  for (const sql of alters) {
    try {
      await dbExecute(sql);
    } catch {
      // 列已存在时 SQLite 报 duplicate column name，忽略即可
    }
  }

  /**
   * 数据迁移：新增 is_rich 列后，按既有 content 是否含 HTML 标签回填，
   * 让历史富文本继续以富文本组件展示，其余标记为纯文本。
   * 幂等：仅处理 is_rich 仍为空的旧行，新写入的行已自带该字段。
   */
  try {
    await dbExecute(
      `UPDATE ${TABLE.CONVERSATION} SET is_rich = '1' WHERE is_rich IS NULL AND content LIKE '%<%'`
    );
    await dbExecute(
      `UPDATE ${TABLE.CONVERSATION} SET is_rich = '0' WHERE is_rich IS NULL`
    );
  } catch {
    // 忽略
  }

  /**
   * 数据迁移：早期版本曾用 SQLite 保留字 `references` 作为列名，
   * 该列从未成功写入（INSERT 直接报 SQLITE_ERROR），但部分旧库可能已建出空列。
   * 这里把旧列 `references` 的数据迁到 `ref_ids` 后保留旧列（不删除，
   * 因老版本 SQLite 不支持 DROP COLUMN，删除会报错）。旧列无数据则忽略。
   */
  try {
    await dbExecute(
      `UPDATE ${TABLE.CONVERSATION} SET ref_ids = "references"
       WHERE "references" IS NOT NULL AND "references" <> ''
         AND (ref_ids IS NULL OR ref_ids = '')`
    );
  } catch {
    // 旧列不存在时忽略
  }
}

/** 初始化：建表补列 -> 加载主题与标签 -> 选中第一个主题 */
async function init() {
  loading.value = true;
  try {
    await ensureSchema();
    await Promise.all([loadThemes(), loadTags()]);
    if (currentThemeId.value) await loadConversations(currentThemeId.value);
  } finally {
    loading.value = false;
  }
}

export function useThemeConversation() {
  return {
    // 状态
    themes,
    themeCounts,
    tags,
    currentThemeId,
    conversations,
    loading,
    searchKeyword,
    activeTagFilter,
    searchResults,
    isSearching,
    displayConversations,
    referencedIds,
    referenceDrawer,
    // 草稿引用 / 多选（引用按钮 / 右键 / 多选共用）
    pendingRefIds,
    multiselect,
    selectedIds,
    highlightConvId,
    highlightTick,
    addPendingRef,
    addPendingRefs,
    removePendingRef,
    clearPendingRefs,
    // 跨主题引用
    pendingCrossRefs,
    crossRefPickerOpen,
    openCrossRefPicker,
    closeCrossRefPicker,
    addPendingCrossRefs,
    removePendingCrossRef,
    getConversationsByTheme,
    // 跨主题「被引用」标记
    crossReferencedBy,
    loadCrossReferenced,
    showCrossReferencedBy,
    showCrossRefTargets,
    // 全局「同主题被引用」统计（选择抽屉等场景）
    referencedByCounts,
    loadReferencedByCounts,
    toggleMultiselect,
    toggleSelect,
    clearSelection,
    // 主题
    init,
    loadThemes,
    loadTags,
    selectTheme,
    loadConversations,
    loadThemeCounts,
    createTheme,
    findOrCreateThemeByTitle,
    updateTheme,
    deleteTheme,
    clearAllData,
    // 子主题（层级）
    themeTree,
    flatThemeTree,
    collapsedIds,
    toggleCollapse,
    hasChildThemes,
    subThemeDialog,
    openSubThemeDialog,
    closeSubThemeDialog,
    confirmSubTheme,
    // 对话
    createConversation,
    updateConversation,
    deleteConversation,
    // 标签
    createTag,
    updateTag,
    deleteTag,
    getTagById,
    tagName,
    tagColor,
    // 搜索
    runSearch,
    clearSearch,
    // 引用
    getConversationById,
    showReferenceTargets,
    showReferencedBy,
    showConversationDetail,
    locateConversation,
    closeReferenceDrawer,
    // 工具
    parseArr,
  };
}

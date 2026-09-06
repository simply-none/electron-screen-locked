/**
 * 文件互传 store（Pinia setup 风格）
 *
 * 职责：设备列表 / 已选文件 / 发送进度 / 历史 / 自动接收开关 的状态收敛与动作封装；
 * 页面与组件只消费 store，不直接触碰 IPC（数据层在 views/fileTransfer/api）。
 * 进度与接收事件来自主进程经 preload 的 file-transfer:* 通道（bindEvents 订阅）。
 */
import { defineStore } from "pinia";
import { ref, computed } from "vue";

import { fileTransferApi } from "@/views/fileTransfer/api/fileTransferApi";
import type {
  TransferPeerDevice,
  TransferProgress,
  TransferHistoryItem,
  TransferStatus,
  LocalFileItem,
  RecentPeer,
  SelectedEntry,
} from "@/views/fileTransfer/types";

export const useFileTransfer = defineStore("fileTransfer", () => {
  /** 本机服务状态 */
  const status = ref<TransferStatus | null>(null);
  /** 已知对端（扫描结果 + 手动添加），按 ip 去重 */
  const peers = ref<TransferPeerDevice[]>([]);
  /** 最近设备（持久化，离线也显示） */
  const recentPeers = ref<RecentPeer[]>([]);
  /** 当前选中设备 ip（发送目标） */
  const selectedDeviceIp = ref("");
  /** 本地已选待发文件（发送中由 progress 事件重建，供进度条展示） */
  const files = ref<LocalFileItem[]>([]);
  /** 选择结果（文件/文件夹，可多次累加、可单独勾选，默认全选） */
  const entries = ref<SelectedEntry[]>([]);
  /** 当前批次逐文件进度，key = `${tid}|${fid}` */
  const progress = ref<Record<string, TransferProgress>>({});
  /** 当前批次号 */
  const currentTid = ref("");
  /** 历史记录（新→旧） */
  const history = ref<TransferHistoryItem[]>([]);
  /** 自动接收开关（与主进程 store._transfer_auto_accept 同步） */
  const autoAccept = ref(true);
  /** 重名策略（与主进程 store._transfer_rename 同步） */
  const renameStrategy = ref<"rename" | "overwrite">("rename");
  /** 传输加密开关（与主进程 store._transfer_enc 同步） */
  const enc = ref(false);
  /** 询问模式：待用户答复的接收请求 */
  const incomingAsk = ref<{ tid: string; name: string; count: number; total: number } | null>(null);
  const scanning = ref(false);
  const sending = ref(false);
  /** 当前批次开始时间戳，用于计算速率/ETA */
  const batchStart = ref(0);

  /** 批次总字节数（所有文件 total 之和，来自进度事件） */
  const batchTotalBytes = computed(() =>
    Object.values(progress.value).reduce((s, p) => s + (p.total || 0), 0),
  );
  /** 批次已传字节数（所有文件 sent 之和；串行传输下等于累计进度） */
  const batchSentBytes = computed(() =>
    Object.values(progress.value).reduce((s, p) => s + (p.sent || 0), 0),
  );
  /** 批次总进度百分比 */
  const batchPercent = computed(() =>
    batchTotalBytes.value ? Math.min(100, Math.round((batchSentBytes.value / batchTotalBytes.value) * 100)) : 0,
  );
  /** 实时速率（字节/秒） */
  const batchRate = computed(() => {
    if (!batchStart.value) return 0;
    const sec = (Date.now() - batchStart.value) / 1000;
    return sec > 0 ? batchSentBytes.value / sec : 0;
  });
  /** 预计剩余秒数 */
  const batchEta = computed(() => {
    const rate = batchRate.value;
    if (rate <= 0) return 0;
    const remain = batchTotalBytes.value - batchSentBytes.value;
    return remain > 0 ? Math.ceil(remain / rate) : 0;
  });

  /** 已勾选的待发项（发送时只发这些） */
  const checkedEntries = computed(() => entries.value.filter((e) => e.checked));
  /** 已勾选项数 */
  const checkedCount = computed(() => checkedEntries.value.length);
  /** 已勾选包含的（拍平后）文件总数 */
  const totalFiles = computed(() =>
    checkedEntries.value.reduce((s, e) => s + (e.fileCount || 0), 0),
  );
  /** 已勾选总字节数 */
  const totalBytes = computed(() =>
    checkedEntries.value.reduce((s, e) => s + (e.size || 0), 0),
  );
  /** 是否全部勾选（「全选」勾选框状态） */
  const allChecked = computed(
    () => entries.value.length > 0 && entries.value.every((e) => e.checked),
  );
  /** 是否部分勾选（半选态） */
  const someChecked = computed(
    () => checkedCount.value > 0 && !allChecked.value,
  );

  /** 本机服务状态 */
  async function loadStatus() {
    try {
      const res = await fileTransferApi.status();
      if (res.success && res.data) {
        status.value = res.data;
        autoAccept.value = res.data.autoAccept;
        renameStrategy.value = res.data.rename ?? "rename";
        enc.value = !!res.data.enc;
      }
    } catch (e) {
      console.warn("[fileTransfer] status failed:", e);
    }
  }

  /** 拉取最近设备（#11） */
  async function loadRecent() {
    try {
      const res = await fileTransferApi.recentPeers();
      if (res.success && res.data) recentPeers.value = res.data;
    } catch (e) {
      console.warn("[fileTransfer] recentPeers failed:", e);
    }
  }

  /** UDP 广播扫描局域网对端 */
  async function scan() {
    scanning.value = true;
    try {
      const res = await fileTransferApi.scan();
      if (res.success && res.data) {
        // 保留手动添加的设备（platform === '-'），合并扫描结果
        const manual = peers.value.filter((p) => p.platform === "-");
        const merged = new Map<string, TransferPeerDevice>();
        for (const p of [...manual, ...res.data]) merged.set(p.ip, p);
        peers.value = [...merged.values()];
      }
    } catch (e) {
      console.warn("[fileTransfer] scan failed:", e);
    } finally {
      scanning.value = false;
      loadRecent();
    }
  }

  /** 手动添加设备（模拟器等广播不可达场景） */
  function addManual(ip: string) {
    const clean = ip.trim();
    if (!clean || peers.value.some((p) => p.ip === clean)) return;
    peers.value.push({ ip: clean, name: "手动添加", id: clean, platform: "-" });
    if (!selectedDeviceIp.value) selectedDeviceIp.value = clean;
  }

  /** 打开系统文件/文件夹多选对话框，结果【累加】到 entries（按 path 去重，默认勾选） */
  /** 把主进程返回的选择项累加到 entries（按 path 去重、默认 checked=true） */
  function addPicked(res: { success?: boolean; data?: SelectedEntry[] } | undefined) {
    if (!res || !res.success || !res.data || !res.data.length) return;
    const existing = new Set(entries.value.map((e) => e.path));
    const added: SelectedEntry[] = [];
    for (const e of res.data) {
      if (existing.has(e.path)) continue;
      existing.add(e.path);
      added.push({ ...e, checked: true });
    }
    if (added.length) entries.value = [...entries.value, ...added];
  }

  /** 打开系统「选文件」对话框，结果累加进 entries（文件可多选） */
  async function pickFiles() {
    try {
      const res = await fileTransferApi.pickFiles();
      addPicked(res);
    } catch (e) {
      console.warn("[fileTransfer] pick files failed:", e);
    }
  }

  /** 打开系统「选文件夹」对话框，结果累加进 entries（文件夹作为单独一行，发送时由主进程递归拍平） */
  async function pickFolders() {
    try {
      const res = await fileTransferApi.pickFolders();
      addPicked(res);
    } catch (e) {
      console.warn("[fileTransfer] pick folders failed:", e);
    }
  }

  /** 切换单条勾选（默认全选；可单独取消某条） */
  function toggleEntry(path: string) {
    const e = entries.value.find((x) => x.path === path);
    if (e) e.checked = !e.checked;
  }

  /** 全选 / 取消全选 */
  function toggleAll(checked: boolean) {
    entries.value.forEach((e) => (e.checked = checked));
  }

  /** 移除单条选择项 */
  function removeEntry(path: string) {
    entries.value = entries.value.filter((e) => e.path !== path);
  }

  /** 清空选择列表 */
  function clearEntries() {
    entries.value = [];
  }

  /** 切换自动接收开关（同时持久化到主进程） */
  async function setAutoAccept(v: boolean) {
    autoAccept.value = v;
    try {
      await fileTransferApi.setAutoAccept(v);
    } catch (e) {
      console.warn("[fileTransfer] setAutoAccept failed:", e);
    }
  }

  /** 切换重名策略（rename=追加 (n) / overwrite=覆盖） */
  async function setRename(v: "rename" | "overwrite") {
    renameStrategy.value = v;
    try {
      await fileTransferApi.setRename(v);
    } catch (e) {
      console.warn("[fileTransfer] setRename failed:", e);
    }
  }

  /** 切换传输加密开关 */
  async function setEnc(v: boolean) {
    enc.value = v;
    try {
      await fileTransferApi.setEnc(v);
    } catch (e) {
      console.warn("[fileTransfer] setEnc failed:", e);
    }
  }

  /** 询问模式（#15）：答复是否接收对方的发送请求 */
  async function answerAsk(accept: boolean) {
    const ask = incomingAsk.value;
    if (!ask) return;
    incomingAsk.value = null;
    try {
      await fileTransferApi.answerOffer(ask.tid, accept);
    } catch (e) {
      console.warn("[fileTransfer] answerOffer failed:", e);
    }
  }

  /** 忘记某最近设备 */
  async function forgetPeer(ip: string) {
    try {
      await fileTransferApi.forgetPeer(ip);
      await loadRecent();
    } catch (e) {
      console.warn("[fileTransfer] forgetPeer failed:", e);
    }
  }

  /** 批量发送到指定对端（只发已勾选的 entries；文件夹原样传出，由主进程递归拍平） */
  async function send(peerIp: string) {
    const checked = entries.value.filter((e) => e.checked);
    if (!peerIp || !checked.length) return;
    sending.value = true;
    progress.value = {};
    files.value = []; // 发送中由 progress 事件重建拍平列表
    batchStart.value = Date.now();
    try {
      const res = await fileTransferApi.send(
        peerIp,
        checked.map((e) => e.path),
      );
      if (res.success && res.data) {
        // 整批结束后才能拿到 tid；发送过程中靠 progress 事件设置（见 onProgress）
        if (res.data.tid) currentTid.value = res.data.tid;
        // 事件会刷新历史；这里兜底再拉一次
        await loadHistory();
      }
    } catch (e) {
      console.warn("[fileTransfer] send failed:", e);
    } finally {
      sending.value = false;
      // 保留最终进度态 1.5s，让用户看到完成/失败，再清空
      setTimeout(() => {
        if (!sending.value) {
          progress.value = {};
          files.value = [];
        }
      }, 1500);
    }
  }

  /**
   * 取消当前正在发送的批次。
   * tid 只能来自 progress 事件——transfer:send 的 handle 要等整批结束才返回，
   * 所以整批跑完之前，currentTid 由 onProgress 设置。
   * 主进程会中止流式上传、把当前文件记 canceled 并停止后续文件，再回传进度/历史。
   */
  async function cancel() {
    if (!currentTid.value) return;
    try {
      await fileTransferApi.cancel(currentTid.value);
    } catch (e) {
      console.warn("[fileTransfer] cancel failed:", e);
    }
  }

  /**
   * 拉取「当次传输」记录：只保留 created_at 最新的那条记录所属批次（tid），
   * 其余历史记录暂不展示（DB 仍全量写入，主进程侧不删）。
   */
  async function loadHistory() {
    try {
      const res = await fileTransferApi.history();
      if (res.success && res.data) {
        const rows = res.data as TransferHistoryItem[];
        if (!rows.length) {
          history.value = [];
          return;
        }
        const latest = rows.reduce((a, b) => (b.created_at > a.created_at ? b : a));
        history.value = rows.filter((r) => r.tid === latest.tid);
      }
    } catch (e) {
      console.warn("[fileTransfer] history failed:", e);
    }
  }

  /** 在资源管理器打开接收目录 */
  async function openReceived() {
    try {
      await fileTransferApi.openReceived();
    } catch (e) {
      console.warn("[fileTransfer] openReceived failed:", e);
    }
  }

  /** 按系统关联程序打开指定历史文件 */
  async function openFile(p: string) {
    try {
      await fileTransferApi.openFile(p);
    } catch (e) {
      console.warn("[fileTransfer] openFile failed:", e);
    }
  }

  /** 在资源管理器定位（显示所在文件夹并选中）指定文件 */
  async function openFolder(p: string) {
    try {
      await fileTransferApi.openFolder(p);
    } catch (e) {
      console.warn("[fileTransfer] openFolder failed:", e);
    }
  }

  // ---- 事件订阅（主进程 → 渲染端，仅 file-transfer: 前缀）----
  function onProgress(_e: unknown, p: TransferProgress) {
    // 新批次开始：清掉上一批的展示记录，记录区只显示当次传输
    if (history.value.length && history.value[0].tid !== p.tid) history.value = [];
    currentTid.value = p.tid;
    progress.value = { ...progress.value, [`${p.tid}|${p.fid}`]: p };
    // 由进度事件重建拍平文件列表（顺序 = fid 顺序），供逐文件进度条展示
    files.value = Object.values(progress.value)
      .filter((x) => x.tid === p.tid)
      .sort((a, b) => Number(a.fid) - Number(b.fid))
      .map((x) => ({ path: x.name, name: x.name, size: x.total }));
  }
  function onReceived(_e: unknown, _payload: { name: string; path: string; size: number; from: string }) {
    loadHistory();
  }
  function onBatchDone(_e: unknown, _payload: { tid: string; ok: number; fail: number }) {
    loadHistory();
  }
  function onIncomingAsk(_e: unknown, payload: { tid: string; name: string; count: number; total: number }) {
    incomingAsk.value = payload;
  }

  function bindEvents() {
    try {
      window.ipcRenderer.on("file-transfer:progress", onProgress as never);
      window.ipcRenderer.on("file-transfer:received", onReceived as never);
      window.ipcRenderer.on("file-transfer:batch-done", onBatchDone as never);
      window.ipcRenderer.on("file-transfer:incoming-ask", onIncomingAsk as never);
    } catch (e) {
      console.warn("[fileTransfer] bindEvents failed:", e);
    }
  }
  function unbindEvents() {
    try {
      window.ipcRenderer.off("file-transfer:progress", onProgress as never);
      window.ipcRenderer.off("file-transfer:received", onReceived as never);
      window.ipcRenderer.off("file-transfer:batch-done", onBatchDone as never);
      window.ipcRenderer.off("file-transfer:incoming-ask", onIncomingAsk as never);
    } catch (e) {
      console.warn("[fileTransfer] unbindEvents failed:", e);
    }
  }

  return {
    status,
    peers,
    recentPeers,
    selectedDeviceIp,
    files,
    entries,
    checkedCount,
    totalFiles,
    totalBytes,
    allChecked,
    someChecked,
    progress,
    currentTid,
    history,
    autoAccept,
    renameStrategy,
    enc,
    incomingAsk,
    scanning,
    sending,
    batchStart,
    batchTotalBytes,
    batchSentBytes,
    batchPercent,
    batchRate,
    batchEta,
    loadStatus,
    scan,
    loadRecent,
    addManual,
    pickFiles,
    pickFolders,
    toggleEntry,
    toggleAll,
    removeEntry,
    clearEntries,
    setAutoAccept,
    setRename,
    setEnc,
    answerAsk,
    forgetPeer,
    send,
    cancel,
    loadHistory,
    openReceived,
    openFile,
    openFolder,
    bindEvents,
    unbindEvents,
  };
});

/**
 * 局域网同步模块（LocalSend-like，PC 端）— 与 Flutter 移动端 core/sync 同协议
 * ----------------------------------------------------------------------------
 * 目标：PC 与移动端在同一局域网内互相发现，并按「表 + 主键幂等 upsert」同步业务数据。
 *
 * 协议 v1（与 mobile 端 core/sync/sync_discovery.dart 严格一致）：
 *   发现请求：UDP 广播（端口 47123）文本 "JIANLI_SYNC_DISCOVER_V1"
 *   应答：    UDP 回包 "JIANLI_SYNC_INFO_V1|{json: {name, id, platform}}"
 *   数据面：  HTTP 端口 47124；GET /ping → 设备信息；POST /sync → {table, rows}
 *
 * 设计约定：
 * - 同步表主键按表适配（tablePk）：TEXT 主键表用 key；主题对话三表为 INTEGER 自增 id（2026-09-05 加入），ON CONFLICT(id) 同样幂等。
 * - 白名单表，防任意表写入。
 * - 安全 TODO(P3)：当前明文 JSON，仅限受信局域网；后续加会话密钥。
 * - 本模块不改任何现有模块；新增初始化入口 initSync()（在 index.ts createWindow 末尾调用）。
 * - 改本文件必须重启 Electron。
 */
import dgram from "node:dgram";
import http from "node:http";
import os from "node:os";
import { ipcMain } from "electron";
import { store } from "../store.ts";
import { upsert, query } from "../newSql.ts";

const DISCOVERY_PORT = 47123;
const DATA_PORT = 47124;
const DISCOVER_PACKET = "JIANLI_SYNC_DISCOVER_V1";
const INFO_PREFIX = "JIANLI_SYNC_INFO_V1|";

/** 局域网对端设备（与移动端 PeerDevice 同构） */
export interface SyncPeer {
  ip: string;
  name: string;
  id: string;
  platform: string;
}

/** 单表同步结果（渲染端展示用） */
export interface SyncTableResult {
  table: string;
  ok: boolean;
  count: number;
  error?: string;
}

/** 可同步表白名单（主键按 TABLE_PKS 适配；主题对话三表为 INTEGER 自增 id，2026-09-05 加入） */
const SYNCABLE_TABLES = new Set([
  "habit_def",
  "habit_checkin",
  "todo_list",
  "todo_tags",
  "note_book",
  "basic_info",
  "countdown",
  "qr_history",
  "qr_template",
  // 主题对话三表（INTEGER 自增 id 主键，见 tablePk）
  "conversation_theme",
  "conversation",
  "conversation_tag",
]);

/** 按表主键映射：缺省 key（旧 SQL 层遗留）；主题对话三表为自增 id */
function tablePk(table: string): string {
  return table.startsWith("conversation") ? "id" : "key";
}

/** 本机设备 id（主机名稳定哈希，与移动端一致） */
function deviceId(): string {
  const host = os.hostname();
  let h = 0;
  for (let i = 0; i < host.length; i++) {
    h = (h * 31 + host.charCodeAt(i)) >>> 0;
  }
  return String(h);
}

// ---------------------------------------------------------------------------
// 数据面可插拔路由：文件互传等模块向 47124 注入自定义端点（不新开端口）
// ---------------------------------------------------------------------------

/** 可插拔路由处理器（与内置 /ping /sync /export 同签名） */
export type DataRouteHandler = (
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
) => Promise<void> | void;

interface DataRoute {
  method: string;
  prefix: string;
  handler: DataRouteHandler;
}

/** 已注册的可插拔路由（模块级单例，server 每个请求动态查询） */
const dataRoutes: DataRoute[] = [];

/**
 * 注册一个数据面路由：命中 method + url 前缀即交由 handler 处理。
 * 文件互传模块据此注入 /file/offer、/file/data、/file/end，/ping /sync /export 行为不变。
 */
export function registerDataRoute(
  method: string,
  prefix: string,
  handler: DataRouteHandler,
): void {
  dataRoutes.push({ method, prefix, handler });
}

function deviceInfo() {
  return {
    name: os.hostname(),
    id: deviceId(),
    platform: `win32-electron`,
  };
}

/** UDP 发现应答（可被发现） */
function startDiscoveryResponder(): dgram.Socket {
  const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
  sock.on("message", (buf, rinfo) => {
    const msg = buf.toString("utf8");
    if (msg !== DISCOVER_PACKET) return;
    const reply = Buffer.from(INFO_PREFIX + JSON.stringify(deviceInfo()), "utf8");
    sock.send(reply, rinfo.port, rinfo.address, (err) => {
      if (err) console.warn("[sync] reply failed:", err.message);
    });
  });
  sock.on("error", (e) => console.warn("[sync] udp error:", e.message));
  sock.bind(DISCOVERY_PORT, () => {
    try {
      sock.setBroadcast(true);
    } catch {
      /* 某些环境无需设置 */
    }
    console.log(`[sync] discovery responder on :${DISCOVERY_PORT}`);
  });
  return sock;
}

/** HTTP 数据面：/ping + /sync */
function startDataServer(): http.Server {
  const server = http.createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    // 先走可插拔路由（文件互传 /file/* 等），命中即处理并结束响应
    for (const r of dataRoutes) {
      if (req.method === r.method && req.url?.startsWith(r.prefix)) {
        await r.handler(req, res);
        return;
      }
    }
    if (req.method === "GET" && req.url === "/ping") {
      res.end(JSON.stringify(deviceInfo()));
      return;
    }
    // 拉取端点：移动端主动拉 PC 数据（GET /export?table=xxx）
    if (req.method === "GET" && req.url?.startsWith("/export")) {
      const url = new URL(req.url, "http://localhost");
      const table = url.searchParams.get("table");
      if (!table || !SYNCABLE_TABLES.has(table)) {
        res.statusCode = 400;
        res.end(JSON.stringify({ ok: false, error: "table 不在白名单" }));
        return;
      }
      try {
        const rows = (await query({ tableName: table })) as Record<string, unknown>[];
        res.end(JSON.stringify({ ok: true, table, rows }));
        console.log(`[sync] exported table=${table} rows=${rows.length}`);
      } catch (e) {
        res.statusCode = 500;
        res.end(JSON.stringify({ ok: false, error: String(e) }));
      }
      return;
    }
    if (req.method === "POST" && req.url === "/sync") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", async () => {
        try {
          const payload = JSON.parse(body) as { table?: string; rows?: Record<string, unknown>[] };
          const table = payload.table;
          if (!table || !SYNCABLE_TABLES.has(table)) {
            res.statusCode = 400;
            res.end(JSON.stringify({ ok: false, error: "table 不在白名单" }));
            return;
          }
          let written = 0;
          for (const row of payload.rows ?? []) {
            if (!row || typeof row !== "object") continue;
            await upsert({
              tableName: table,
              data: row,
              config: { primaryKey: tablePk(table) },
            });
            written++;
          }
          res.end(JSON.stringify({ ok: true, written }));
          console.log(`[sync] received table=${table} rows=${written}`);
        } catch (e) {
          res.statusCode = 500;
          res.end(JSON.stringify({ ok: false, error: String(e) }));
        }
      });
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ ok: false, error: "not found" }));
  });
  server.listen(DATA_PORT, () => console.log(`[sync] data server on :${DATA_PORT}`));
  return server;
}

// ---------------------------------------------------------------------------
// 主动同步能力（PC 作为客户端）：扫描 / 推送 / 拉取
// ---------------------------------------------------------------------------

/**
 * 发现请求的目标地址集合（解决「PC 连手机热点时 255.255.255.255 受限广播走默认路由、
 * 到不了热点网段」的发现盲区，与移动端 sync_discovery.dart 的 broadcastCandidates 思路一致）：
 *   - 全网受限广播 255.255.255.255（普通同网段场景兜底）
 *   - 每个 IPv4 非回环接口的「定向广播 x.y.z.255」（按真实子网掩码计算，比移动端 /24 假设更准）
 *   - 各接口网关 x.y.z.1 单播（手机开热点时手机即网关，单播必达，热点场景关键兜底）
 */
function discoveryTargets(): string[] {
  const set = new Set<string>(["255.255.255.255"]);
  const ifaces = os.networkInterfaces();
  for (const list of Object.values(ifaces)) {
    if (!list) continue;
    for (const ni of list) {
      if (ni.family !== "IPv4" || ni.internal) continue;
      const octets = ni.address.split(".");
      if (octets.length !== 4) continue;
      // 定向广播 = ip | ~mask（按真实子网掩码逐字节计算）
      const mask = ni.netmask.split(".").map(Number);
      if (mask.length === 4) {
        const bc = octets.map((o, i) => (Number(o) | (~mask[i] & 255)) & 255);
        set.add(bc.join("."));
      }
      // 网关单播（常见 .1，手机热点即网关）
      set.add(`${octets[0]}.${octets[1]}.${octets[2]}.1`);
    }
  }
  return [...set];
}

/** 扫描局域网对端：向多个目标地址发送 UDP 发现包，收集 3 秒应答，按 ip 去重并排除自身 */
export function scanPeers(timeoutMs = 3000): Promise<SyncPeer[]> {
  return new Promise((resolve) => {
    const found = new Map<string, SyncPeer>();
    const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
    const done = () => {
      try { sock.close(); } catch { /* 已关闭 */ }
      resolve([...found.values()]);
    };
    sock.on("message", (buf, rinfo) => {
      const msg = buf.toString("utf8");
      if (!msg.startsWith(INFO_PREFIX)) return;
      try {
        const info = JSON.parse(msg.slice(INFO_PREFIX.length)) as Omit<SyncPeer, "ip">;
        if (info.id === deviceId()) return; // 排除自身
        found.set(rinfo.address, { ip: rinfo.address, name: info.name, id: info.id, platform: info.platform });
      } catch {
        /* 非法应答忽略 */
      }
    });
    sock.on("error", () => done());
    const packet = Buffer.from(DISCOVER_PACKET, "utf8");
    sock.bind(() => {
      try { sock.setBroadcast(true); } catch { /* 部分 平台无需 */ }
      for (const target of discoveryTargets()) {
        sock.send(packet, DISCOVERY_PORT, target, (err) => {
          if (err) console.warn("[sync] scan send failed:", target, err.message);
        });
      }
      setTimeout(done, timeoutMs);
    });
  });
}

/** 构造对端 URL；peerIp 支持 `ip` 或 `ip:port`（如 adb reverse 场景 `127.0.0.1:47125`） */
function peerUrl(peerIp: string, path: string): string {
  const [host, portStr] = peerIp.split(":");
  const port = portStr ? Number(portStr) : DATA_PORT;
  return `http://${host}:${port}${path}`;
}

/** 带超时的对端 HTTP 请求（5s），返回解析后的 JSON 或抛错 */
async function peerRequest(peerIp: string, method: "GET" | "POST", path: string, body?: unknown): Promise<any> {
  const res = await fetch(peerUrl(peerIp, path), {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(5000),
  });
  return (await res.json()) as any;
}

/** 推送：读本地表 → POST 对端 /sync（对端幂等 upsert 到它自己的库） */
export async function pushTables(peerIp: string, tables: string[]): Promise<SyncTableResult[]> {
  const results: SyncTableResult[] = [];
  for (const table of tables) {
    if (!SYNCABLE_TABLES.has(table)) continue;
    try {
      const rows = (await query({ tableName: table })) as Record<string, unknown>[];
      const resp = (await peerRequest(peerIp, "POST", "/sync", { table, rows })) as { ok: boolean; written?: number; error?: string };
      results.push({ table, ok: !!resp.ok, count: resp.written ?? 0, error: resp.error });
    } catch (e) {
      results.push({ table, ok: false, count: 0, error: String(e) });
    }
  }
  return results;
}

/** 拉取：GET 对端 /export?table=x → 逐行幂等 upsert 到本地 */
export async function pullTables(peerIp: string, tables: string[]): Promise<SyncTableResult[]> {
  const results: SyncTableResult[] = [];
  for (const table of tables) {
    if (!SYNCABLE_TABLES.has(table)) continue;
    try {
      const resp = (await peerRequest(peerIp, "GET", `/export?table=${table}`)) as {
        ok: boolean; rows?: Record<string, unknown>[]; error?: string;
      };
      if (!resp.ok) {
        results.push({ table, ok: false, count: 0, error: resp.error });
        continue;
      }
      let count = 0;
      for (const row of resp.rows ?? []) {
        if (!row || typeof row !== "object") continue;
        await upsert({ tableName: table, data: row, config: { primaryKey: "key" } });
        count++;
      }
      results.push({ table, ok: true, count });
    } catch (e) {
      results.push({ table, ok: false, count: 0, error: String(e) });
    }
  }
  return results;
}

/** 初始化（index.ts createWindow 末尾调用一次） */
export function initSync(): void {
  try {
    store.get("_sync_enabled"); // 预留：设置页开关（默认开启；TODO(P2): 接设置页 UI）
    startDiscoveryResponder();
    startDataServer();
    // 渲染端同步页 IPC（状态 / 扫描 / 推送 / 拉取）
    ipcMain.handle("sync:status", () => ({
      success: true,
      data: { ...deviceInfo(), discoveryPort: DISCOVERY_PORT, dataPort: DATA_PORT },
    }));
    ipcMain.handle("sync:scan", async () => {
      const peers = await scanPeers();
      return { success: true, data: peers };
    });
    ipcMain.handle("sync:push", async (_e, args: { peerIp: string; tables: string[] }) => ({
      success: true,
      data: await pushTables(args.peerIp, args.tables),
    }));
    ipcMain.handle("sync:pull", async (_e, args: { peerIp: string; tables: string[] }) => ({
      success: true,
      data: await pullTables(args.peerIp, args.tables),
    }));
  } catch (e) {
    console.warn("[sync] init failed:", e);
  }
}

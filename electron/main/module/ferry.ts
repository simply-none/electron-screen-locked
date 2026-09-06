/**
 * 隔空互传模块（QRFerry 本地集成）
 * ----------------------------------------------------------------------------
 * 把打包内的 qyferry 静态站（屏幕→摄像头、fountain 码动态二维码文件传输，
 * 纯客户端、不经过服务器/局域网）作为「内置资源」托管到本机 http://127.0.0.1，
 * 由独立 BrowserWindow 加载；网页自带扫码识别 + 解码，本模块只负责：
 *   - 起一个随机端口的本地静态服务（dev 读项目内 electron/resources/qyferry；
 *     打包后读 process.resourcesPath/qyferry）；
 *   - 独立窗口加载该 URL，并对 localhost 源自动放行摄像头权限；
 *   - 接收文件落盘（will-download → 文档/隔空互传）。
 * 入口：渲染端调用 ferry:open IPC 打开窗口。
 * ⚠️ 改本文件必须重启 Electron。
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { BrowserWindow, app, ipcMain } from "electron";
import { preload } from "../variables.ts";

/** qyferry 静态目录：dev / 打包后自动切换 */
function ferryDir(): string {
  if (app.isPackaged) {
    const packed = path.join(process.resourcesPath, "qyferry");
    if (fs.existsSync(packed)) return packed;
  }
  return path.join(app.getAppPath(), "electron", "resources", "qyferry");
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
  ".map": "application/json",
};

let ferryServer: http.Server | null = null;
let ferryPort = 0;
let ferryWin: BrowserWindow | null = null;

/** 起本地静态服务，返回端口（仅起一次） */
function ensureServer(): Promise<number> {
  if (ferryPort) return Promise.resolve(ferryPort);
  const root = ferryDir();
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        if (!fs.existsSync(root)) {
          res.statusCode = 500;
          res.end("qyferry resource missing: " + root);
          return;
        }
        let urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
        if (urlPath === "/" || urlPath === "") urlPath = "/index.html";
        // 防目录穿越
        const safe = path
          .normalize(urlPath)
          .replace(/^(\.\.[/\\])+/, "")
          .replace(/^[/\\]+/, "");
        const filePath = path.join(root, safe);
        if (!filePath.startsWith(root)) {
          res.statusCode = 403;
          res.end("forbidden");
          return;
        }
        fs.readFile(filePath, (err, data) => {
          if (err) {
            res.statusCode = 404;
            res.end("not found");
            return;
          }
          const ext = path.extname(filePath).toLowerCase();
          res.setHeader("Content-Type", MIME[ext] || "application/octet-stream");
          res.setHeader("Access-Control-Allow-Origin", "*");
          res.setHeader("Cache-Control", "no-cache");
          res.end(data);
        });
      } catch (e) {
        res.statusCode = 500;
        res.end(String(e));
      }
    });
    server.listen(0, "127.0.0.1", () => {
      ferryServer = server;
      ferryPort = (server.address() as { port: number }).port;
      console.log("[ferry] static server on http://127.0.0.1:" + ferryPort);
      resolve(ferryPort);
    });
    server.on("error", reject);
  });
}

/** 接收目录：文档/隔空互传/ */
function receiveDir(): string {
  const dir = path.join(app.getPath("documents"), "隔空互传");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 打开/聚焦隔空互传独立窗口 */
async function openFerry(): Promise<void> {
  await ensureServer();
  const url = `http://127.0.0.1:${ferryPort}/`;
  if (ferryWin && !ferryWin.isDestroyed()) {
    ferryWin.show();
    ferryWin.focus();
    return;
  }
  ferryWin = new BrowserWindow({
    title: "隔空互传",
    width: 920,
    height: 760,
    minWidth: 480,
    minHeight: 600,
    frame: true,
    transparent: false,
    resizable: true,
    backgroundColor: "#f3f0e8",
    webPreferences: {
      preload,
      devTools: true,
      nodeIntegration: false,
      contextIsolation: true,
      // 独立 session 分区：摄像头权限仅对本窗口放行，不影响主浏览器会话
      partition: "ferry",
    },
  });

  // 摄像头权限：对 localhost 源自动放行 media（getUserMedia）
  const ferrySession = ferryWin.webContents.session;
  ferrySession.setPermissionRequestHandler((_wc, permission, callback) => {
    if (permission === "media" || permission === "camera" || permission === "microphone") {
      callback(true);
    } else {
      callback(false);
    }
  });
  // 接收文件：网页触发下载时落盘到「文档/隔空互传/」
  ferrySession.on("will-download", (_event, item) => {
    const filename = item.getFilename() || `ferry-${Date.now()}`;
    const target = path.join(receiveDir(), filename);
    item.setSavePath(target);
    item.on("done", (_e, state) => {
      if (state === "completed") {
        console.log("[ferry] received file saved:", target);
      } else {
        console.warn("[ferry] download not completed:", state);
      }
    });
  });

  ferryWin.loadURL(url);
  ferryWin.on("closed", () => {
    ferryWin = null;
  });
}

export function initFerry(): void {
  try {
    ipcMain.handle("ferry:open", async () => {
      try {
        await openFerry();
        return { success: true };
      } catch (e) {
        return { success: false, error: String(e) };
      }
    });
    // 启动期预热静态服务（失败不阻塞启动）
    ensureServer().catch((e) => console.warn("[ferry] server start failed:", e));
    console.log("[ferry] module initialized");
  } catch (e) {
    console.warn("[ferry] init failed:", e);
  }
}

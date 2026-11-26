/**
 * 苍蓝流笺（Azure Drop）— Sidecar HTTP Server + CDP 守护入口
 * 零第三方依赖，纯 Node.js 原生 ESM 实现
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { checkGithubUpdate } from "../../lib/update-checker.mjs";
import {
  isLeftSidebarEnabled,
  setLeftSidebarEnabled,
  listOwnedPluginsNavState,
  registerSidecarRuntime,
  refreshAntigravityMcpServers,
  injectSidebarToggleWidget,
} from "../../lib/sidebar-nav.mjs";
import { handleAzureThemeHttp } from "../../lib/azure-theme.mjs";
import { injectAzureUiKit } from "../../lib/azure-ui-kit.mjs";
import {
  loadConfig,
  saveConfig,
  loadStats,
  listSavedImages,
  resolveSafeImagePath,
  deleteSavedImage,
  cleanupOldImages,
  inspectLocalPaths,
  openDirectoryInExplorer,
} from "../../lib/store.mjs";
import { AzureDropInjector } from "../../lib/cdp-injector.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, "../..");
const INDEX_HTML_PATH = path.join(__dirname, "index.html");
const PORT = Number(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || process.env.PORT || 19896);
const HOST = "127.0.0.1";
const TOKEN = (
  process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN ||
  process.env.ANTIGRAVITY_SIDECAR_AUTH_TOKEN ||
  process.env.ANTIGRAVITY_SIDECAR_WEB_TOKEN ||
  ""
).trim();

const injector = new AzureDropInjector();
injector.start();

function isAllowedLocalOrigin(req) {
  const origin = String(req.headers?.origin || "").trim();
  if (!origin || origin === "null") return true;
  try {
    const u = new URL(origin);
    const h = u.hostname.toLowerCase();
    return h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "[::1]";
  } catch {
    return false;
  }
}

function safeTokenEqual(a, b) {
  const ba = Buffer.from(String(a || ""), "utf8");
  const bb = Buffer.from(String(b || ""), "utf8");
  if (ba.length !== bb.length || ba.length === 0) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function checkAuth(req, url) {
  if (!isAllowedLocalOrigin(req)) return false;
  if (!TOKEN) return true;
  const hdr = req.headers["x-codeium-sidecar-token"] || req.headers["x-sidecar-token"];
  const q = url.searchParams.get("token");
  return safeTokenEqual(hdr, TOKEN) || safeTokenEqual(q, TOKEN);
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    req.on("data", (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > 512 * 1024) {
        settled = true;
        req.destroy();
        reject(Object.assign(new Error("Request body too large"), { statusCode: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text.trim()) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(Object.assign(new Error("Invalid JSON"), { statusCode: 400 }));
      }
    });
    req.on("error", (e) => {
      if (settled) return;
      settled = true;
      reject(e);
    });
  });
}

function getPluginVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, "plugin.json"), "utf8")).version || "1.0.0";
  } catch {
    return "1.0.0";
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);
    const pathname = url.pathname;

    if (req.method === "GET" && pathname === "/healthz") {
      return sendJson(res, 200, { ok: true, service: "azure-drop", cdp: injector.getStatus() });
    }

    if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
      const html = fs.readFileSync(INDEX_HTML_PATH, "utf8");
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(injectAzureUiKit(injectSidebarToggleWidget(html, "azure-drop"), "azure-drop"));
      return;
    }

    if (pathname.startsWith("/api/")) {
      if (!checkAuth(req, url)) {
        return sendJson(res, 401, { ok: false, error: "Unauthorized" });
      }
    }

    if (await handleAzureThemeHttp(req, res)) return;

    if (req.method === "GET" && pathname === "/api/check-update") {
      const force = url.searchParams.get("force") === "1";
      const info = await checkGithubUpdate({ pluginRoot: PLUGIN_ROOT, repo: "A16Nights/antigravity-azure-drop", force });
      return sendJson(res, 200, info);
    }

    if (req.method === "GET" && pathname === "/api/sidebar-nav") {
      return sendJson(res, 200, {
        ok: true,
        pluginId: "azure-drop",
        showInLeftSidebar: isLeftSidebarEnabled("azure-drop"),
        plugins: listOwnedPluginsNavState(),
      });
    }

    if (req.method === "POST" && pathname === "/api/sidebar-nav") {
      const body = await readBody(req);
      const targetId = String(body.pluginId || "azure-drop").trim();
      const nextVal = Boolean(body.showInLeftSidebar);
      setLeftSidebarEnabled(targetId, nextVal);
      const rf = await refreshAntigravityMcpServers();
      return sendJson(res, 200, {
        ok: true,
        pluginId: targetId,
        showInLeftSidebar: nextVal,
        refreshed: Boolean(rf?.ok),
        plugins: listOwnedPluginsNavState(),
      });
    }

    if (req.method === "GET" && pathname === "/api/state") {
      const limit = Number(url.searchParams.get("limit") || 60);
      return sendJson(res, 200, {
        ok: true,
        version: getPluginVersion(),
        config: loadConfig(),
        stats: loadStats(),
        cdp: injector.getStatus(),
        gallery: listSavedImages(limit),
        webUrl: `http://${HOST}:${PORT}/` + (TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : ""),
      });
    }

    if (req.method === "POST" && pathname === "/api/config") {
      const body = await readBody(req);
      const nextCfg = saveConfig(body);
      await injector.pushConfig(nextCfg);
      return sendJson(res, 200, { ok: true, config: nextCfg, cdp: injector.getStatus() });
    }

    if (req.method === "POST" && pathname === "/api/reinject") {
      const status = await injector.pollNow({ forceReinject: true });
      return sendJson(res, 200, { ok: true, cdp: status });
    }

    if (req.method === "POST" && pathname === "/api/insert") {
      const body = await readBody(req);
      const filePath = String(body.filePath || "").trim();
      if (!filePath) return sendJson(res, 400, { ok: false, error: "缺少 filePath" });
      const [item] = inspectLocalPaths([filePath]);
      const resInsert = await injector.insertItemIntoActivePage(item || { path: filePath, isDirectory: false });
      return sendJson(res, 200, resInsert);
    }

    if (req.method === "POST" && pathname === "/api/open-dir") {
      const body = await readBody(req);
      return sendJson(res, 200, openDirectoryInExplorer(body.dir));
    }

    if (req.method === "POST" && pathname === "/api/cleanup") {
      const body = await readBody(req);
      const result = cleanupOldImages(body.days);
      return sendJson(res, 200, { ok: true, ...result, gallery: listSavedImages(60) });
    }

    if (req.method === "DELETE" && pathname.startsWith("/api/image/")) {
      const name = decodeURIComponent(pathname.slice("/api/image/".length));
      const del = deleteSavedImage(name);
      return sendJson(res, 200, { ok: true, ...del, gallery: listSavedImages(60) });
    }

    if (req.method === "GET" && pathname.startsWith("/api/image/")) {
      const name = decodeURIComponent(pathname.slice("/api/image/".length));
      const { full, mime } = resolveSafeImagePath(name);
      if (!fs.existsSync(full)) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      const buf = fs.readFileSync(full);
      res.writeHead(200, {
        "Content-Type": mime,
        "Content-Length": buf.length,
        "Cache-Control": "private, max-age=300",
      });
      res.end(buf);
      return;
    }

    sendJson(res, 404, { ok: false, error: "Not found" });
  } catch (err) {
    sendJson(res, err?.statusCode || 500, { ok: false, error: String(err?.message || err) });
  }
});

server.listen(PORT, HOST, () => {
  try {
    const webUrl = `http://${HOST}:${PORT}/` + (TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : "");
    registerSidecarRuntime("azure-drop", { port: PORT, url: webUrl });
  } catch {}
});

function shutdown() {
  injector.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1200).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

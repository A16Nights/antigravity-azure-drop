/**
 * 苍蓝流笺（Azure Drop）— 纯 Node.js 原生零依赖 CDP 多窗口自动注入引擎
 * 自动发现 Antigravity DevToolsActivePort，连接所有主窗口并建立 Runtime.addBinding 私有通道
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadConfig,
  saveLosslessImage,
  inspectLocalPaths,
  recordStat,
  readLocalImagePreview,
  openImageInSystem,
  revealInFileManager,
} from "./store.mjs";
import { buildPageInjectionScript, PAGE_SCRIPT_VERSION } from "./page-script.mjs";

export function getDevToolsActivePortCandidates() {
  const home = os.homedir();
  const list = [];
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    const localAppData = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    list.push(path.join(appData, "Antigravity", "DevToolsActivePort"));
    list.push(path.join(localAppData, "Antigravity", "DevToolsActivePort"));
  } else if (process.platform === "darwin") {
    list.push(path.join(home, "Library", "Application Support", "Antigravity", "DevToolsActivePort"));
  } else {
    const xdg = process.env.XDG_CONFIG_HOME || path.join(home, ".config");
    list.push(path.join(xdg, "Antigravity", "DevToolsActivePort"));
  }
  list.push(path.join(home, ".gemini", "antigravity", "DevToolsActivePort"));
  return list;
}

export function discoverCdpPort(cfg = loadConfig()) {
  if (Number(cfg.cdpPortOverride) > 0) {
    return { port: Number(cfg.cdpPortOverride), source: "manual_override", portFile: null };
  }
  const envPort = Number(process.env.ANTIGRAVITY_CDP_PORT || 0);
  if (envPort > 0) {
    return { port: envPort, source: "env", portFile: null };
  }
  for (const fp of getDevToolsActivePortCandidates()) {
    try {
      if (!fs.existsSync(fp)) continue;
      const firstLine = fs.readFileSync(fp, "utf8").trim().split(/\r?\n/)[0];
      const port = Number(firstLine);
      if (Number.isInteger(port) && port > 0 && port <= 65535) {
        return { port, source: "DevToolsActivePort", portFile: fp };
      }
    } catch {}
  }
  return { port: 0, source: "not_found", portFile: null };
}

function isMainAntigravityPage(target) {
  if (!target || target.type !== "page") return false;
  if (!target.webSocketDebuggerUrl) return false;
  const url = String(target.url || "");
  if (!/^https?:\/\/(127\.0\.0\.1|localhost):/i.test(url)) return false;
  if (url.startsWith("devtools://") || url.startsWith("data:")) return false;
  return true;
}

class PageCdpSession {
  constructor(target, onClose, onEvent) {
    this.targetId = target.id;
    this.title = target.title || "Antigravity";
    this.url = target.url || "";
    this.wsUrl = target.webSocketDebuggerUrl;
    this.onClose = onClose;
    this.onEvent = onEvent;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.connectedAt = 0;
    this.injectedVersion = "";
    this.lastError = "";
    this.closed = false;
  }

  async connect() {
    if (typeof globalThis.WebSocket !== "function") {
      throw new Error("当前 Node.js 版本不支持原生 WebSocket（需要 Node.js >= 22）");
    }
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      const timer = setTimeout(() => {
        try { ws.close(); } catch {}
        reject(new Error("CDP WebSocket 连接超时"));
      }, 6000);

      ws.onopen = () => {
        clearTimeout(timer);
        this.connectedAt = Date.now();
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error("CDP WebSocket 握手失败"));
      };
      ws.onmessage = (ev) => this._handleMessage(ev.data);
      ws.onclose = () => {
        this.closed = true;
        for (const [, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new Error("CDP 连接已断开"));
        }
        this.pending.clear();
        this.onClose?.(this.targetId);
      };
    });
  }

  _handleMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (msg.id && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message || "CDP error"));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method === "Runtime.bindingCalled" && msg.params?.name === "__azureDropBridge") {
      this._handleBridgeCall(msg.params.payload);
    }
  }

  async _handleBridgeCall(rawPayload) {
    let req;
    try {
      req = JSON.parse(String(rawPayload || "{}"));
    } catch {
      return;
    }
    const { reqId, kind } = req;
    try {
      if (kind === "inspect-paths") {
        const items = inspectLocalPaths(req.paths || []);
        await this._resolvePageReq(reqId, { ok: true, items });
      } else if (kind === "save-image") {
        const res = saveLosslessImage({ dataBase64: req.dataBase64, mime: req.mime });
        this.onEvent?.({ type: "image-saved", ...res });
        await this._resolvePageReq(reqId, res);
      } else if (kind === "read-image") {
        const res = readLocalImagePreview(req.filePath);
        await this._resolvePageReq(reqId, res);
      } else if (kind === "open-image") {
        const res = openImageInSystem(req.filePath);
        await this._resolvePageReq(reqId, res);
      } else if (kind === "reveal-path") {
        const res = revealInFileManager(req.path || req.fileUri, { openDirDirectly: Boolean(req.openDirDirectly) });
        await this._resolvePageReq(reqId, res);
      } else if (kind === "stat") {
        const stats = recordStat({ pathInserts: req.pathInserts || 0 });
        this.onEvent?.({ type: "stat", stats });
      }
    } catch (err) {
      if (reqId) {
        await this._resolvePageReq(reqId, { ok: false, error: String(err?.message || err) });
      }
    }
  }

  async _resolvePageReq(reqId, payload) {
    if (!reqId || this.closed) return;
    const expr = `window.__azureDropResolve && window.__azureDropResolve(${JSON.stringify(reqId)}, ${JSON.stringify(payload)});`;
    try {
      await this.send("Runtime.evaluate", { expression: expr, silent: true });
    } catch {}
  }

  send(method, params = {}, timeoutMs = 8000) {
    if (this.closed || !this.ws || this.ws.readyState !== 1) {
      return Promise.reject(new Error("CDP 会话未连接"));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 调用超时: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  async install(cfg) {
    await this.send("Runtime.enable");
    await this.send("Page.enable");
    await this.send("Runtime.addBinding", { name: "__azureDropBridge" });
    const script = buildPageInjectionScript(cfg);
    await this.send("Page.addScriptToEvaluateOnNewDocument", { source: script });
    const evalRes = await this.send("Runtime.evaluate", {
      expression: script,
      returnByValue: true,
    });
    if (evalRes?.exceptionDetails) {
      throw new Error(evalRes.exceptionDetails.text || "页面脚本注入异常");
    }
    this.injectedVersion = evalRes?.result?.value?.version || PAGE_SCRIPT_VERSION;
    this.lastError = "";
  }

  async pushConfig(cfg) {
    if (this.closed) return;
    const expr = `window.__azureDropUpdateConfig ? window.__azureDropUpdateConfig(${JSON.stringify(cfg)}) : null`;
    const res = await this.send("Runtime.evaluate", { expression: expr, returnByValue: true });
    if (!res?.result?.value?.ok) {
      await this.install(cfg);
    }
  }

  async insertItem(item) {
    const expr = `window.__azureDropInsertItem ? window.__azureDropInsertItem(${JSON.stringify(item)}) : { ok: false }`;
    const res = await this.send("Runtime.evaluate", { expression: expr, returnByValue: true });
    return Boolean(res?.result?.value?.ok);
  }

  close() {
    this.closed = true;
    try { this.ws?.close(); } catch {}
  }
}

export class AzureDropInjector {
  constructor() {
    this.sessions = new Map();
    this.timer = null;
    this.polling = false;
    this.cdpPort = 0;
    this.cdpSource = "not_found";
    this.cdpPortFile = null;
    this.lastError = "";
    this.lastPollAt = 0;
    this.listeners = new Set();
  }

  onEvent(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _emit(evt) {
    for (const fn of this.listeners) {
      try { fn(evt); } catch {}
    }
  }

  start() {
    if (this.timer) return;
    this.pollNow().catch(() => {});
    this.timer = setInterval(() => {
      this.pollNow().catch(() => {});
    }, 3500);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const s of this.sessions.values()) s.close();
    this.sessions.clear();
  }

  async pollNow({ forceReinject = false } = {}) {
    if (this.polling) return this.getStatus();
    this.polling = true;
    this.lastPollAt = Date.now();
    try {
      const cfg = loadConfig();
      const info = discoverCdpPort(cfg);
      this.cdpPort = info.port;
      this.cdpSource = info.source;
      this.cdpPortFile = info.portFile;

      if (!info.port) {
        this.lastError = "未发现 DevToolsActivePort（启动 Antigravity 时需携带 --remote-debugging-port=0）";
        return this.getStatus();
      }

      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 3000);
      let targets;
      try {
        const resp = await fetch(`http://127.0.0.1:${info.port}/json/list`, { signal: ac.signal });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        targets = await resp.json();
      } finally {
        clearTimeout(t);
      }

      const pages = Array.isArray(targets) ? targets.filter(isMainAntigravityPage) : [];
      const liveIds = new Set(pages.map((p) => p.id));

      for (const [id, sess] of this.sessions.entries()) {
        if (!liveIds.has(id) || sess.closed) {
          sess.close();
          this.sessions.delete(id);
        }
      }

      for (const page of pages) {
        const existing = this.sessions.get(page.id);
        if (existing && !existing.closed) {
          existing.title = page.title || existing.title;
          existing.url = page.url || existing.url;
          if (forceReinject) {
            try {
              await existing.install(cfg);
            } catch (err) {
              existing.lastError = String(err?.message || err);
            }
          }
          continue;
        }
        const sess = new PageCdpSession(
          page,
          (id) => this.sessions.delete(id),
          (evt) => this._emit(evt)
        );
        try {
          await sess.connect();
          await sess.install(cfg);
          this.sessions.set(page.id, sess);
        } catch (err) {
          sess.close();
          this.lastError = String(err?.message || err);
        }
      }

      if (this.sessions.size > 0) this.lastError = "";
    } catch (err) {
      this.lastError = String(err?.message || err);
    } finally {
      this.polling = false;
    }
    return this.getStatus();
  }

  async pushConfig(cfg = loadConfig()) {
    const tasks = [];
    for (const sess of this.sessions.values()) {
      tasks.push(sess.pushConfig(cfg).catch(() => {}));
    }
    await Promise.all(tasks);
  }

  async insertItemIntoActivePage(item) {
    if (!this.sessions.size) {
      await this.pollNow();
    }
    for (const sess of this.sessions.values()) {
      try {
        const ok = await sess.insertItem(item);
        if (ok) return { ok: true, targetTitle: sess.title };
      } catch {}
    }
    return { ok: false, error: "未找到已连接的 Antigravity 主窗口输入框" };
  }

  getStatus() {
    const pages = Array.from(this.sessions.values()).map((s) => ({
      id: s.targetId,
      title: s.title,
      url: s.url,
      version: s.injectedVersion,
      connectedAt: s.connectedAt,
      lastError: s.lastError,
    }));
    return {
      connected: pages.length > 0,
      cdpPort: this.cdpPort,
      cdpSource: this.cdpSource,
      cdpPortFile: this.cdpPortFile,
      pageCount: pages.length,
      pages,
      lastError: this.lastError,
      lastPollAt: this.lastPollAt,
    };
  }
}

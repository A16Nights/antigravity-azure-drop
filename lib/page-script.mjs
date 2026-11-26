/**
 * 苍蓝流笺（Azure Drop）— 注入 Antigravity 主窗口的轻量客户端脚本生成器
 * 核心机制：
 * 1. 0ms 路径解析：window.electronNative.getPathForFile(file) + file.path 兜底
 * 2. 原生青色标签（默认）：通过 Lexical 原生剪贴板协议 application/x-lexical-editor 插入 contextScopeItemMention（📁 文件夹/ 与 文件名），不附完整路径（支持开关切换）
 * 3. Shift 键放行原生附件；纯内存截图 Ctrl+V 经 CDP Runtime.addBinding 无损落盘 PNG 后插入原生标签
 * 4. 输入框上方原生风格图片缩略图条 + 无损高清可缩放灯箱预览（点击看大图、右上角 × 联动删标签、发送/清空自动消失）
 * 5. 单次 ClipboardEvent('paste') + isSyntheticPaste 防递归锁，不吞换行不重复插入
 */

export const PAGE_SCRIPT_VERSION = "1.0.4";

export function buildPageInjectionScript(initialConfig = {}) {
  const cfgJson = JSON.stringify(initialConfig);
  return `(() => {
  const VERSION = ${JSON.stringify(PAGE_SCRIPT_VERSION)};
  const INITIAL_CFG = ${cfgJson};

  try {
    if (window.__azureDropInstance && typeof window.__azureDropInstance.destroy === "function") {
      window.__azureDropInstance.destroy();
    }
  } catch {}

  let cfg = Object.assign({
    enabled: true,
    insertMode: "mention",
    appendPlainPath: false,
    showImagePreviewBar: true,
    breadcrumbContextMenu: true,
    dragInsertPath: true,
    pasteFilePath: true,
    pasteLosslessImage: true,
    quotePathsWithSpaces: true,
    trailingSpace: true,
    pathSeparator: "auto",
    showPageToast: true,
  }, INITIAL_CFG);

  let isSyntheticPaste = false;
  let reqSeq = 1;
  let previewSeq = 1;
  const pendingReqs = new Map();
  let dragDepth = 0;

  // 输入框上方与已发消息气泡上方图片缩略图状态
  const IMAGE_EXT_RE = /\\.(png|jpe?g|webp|gif|bmp|tiff?|avif)$/i;
  let previewItems = [];
  const imageDataCache = new Map(); // uriKey -> { dataUrl, bytes, fileName, path, fileUri, error }
  const imageLoadingPromises = new Map();
  let msgScanObserver = null;
  let msgScanTimer = null;
  let watchedEditor = null;
  let unregisterLexical = null;
  let syncTimer = null;
  let needsWakeScan = false;
  let lightboxState = {
    open: false,
    items: null, // 若为 null 则默认使用 previewItems
    activeId: null,
    scale: 1,
    tx: 0,
    ty: 0,
    fitMode: true,
    dragging: false,
    dragMoved: false,
    startX: 0,
    startY: 0,
    origTx: 0,
    origTy: 0,
  };

  window.__azureDropResolve = function(reqId, payload) {
    const entry = pendingReqs.get(reqId);
    if (!entry) return;
    pendingReqs.delete(reqId);
    clearTimeout(entry.timer);
    entry.resolve(payload);
  };

  window.__azureDropUpdateConfig = function(nextCfg) {
    if (nextCfg && typeof nextCfg === "object") {
      cfg = Object.assign({}, cfg, nextCfg);
    }
    renderPreviewStrip();
    scheduleScanSentMessages();
    if (!cfg.enabled || !cfg.breadcrumbContextMenu) hideContextMenu();
    return { ok: true, version: VERSION };
  };

  function ensureStyles() {
    if (document.getElementById("__azure-drop-style")) return;
    const style = document.createElement("style");
    style.id = "__azure-drop-style";
    style.textContent = [
      "#__azure-drop-preview-strip {",
      "  order: -10;",
      "  display: flex;",
      "  flex-wrap: wrap;",
      "  align-items: center;",
      "  gap: 8px;",
      "  padding: 6px 8px 4px;",
      "  width: 100%;",
      "  box-sizing: border-box;",
      "}",
      "#__azure-drop-preview-strip.azdrop-hidden { display: none !important; }",
      ".azdrop-thumb-card {",
      "  position: relative;",
      "  width: 64px;",
      "  height: 64px;",
      "  border-radius: 10px;",
      "  overflow: hidden;",
      "  cursor: zoom-in;",
      "  flex-shrink: 0;",
      "  border: 1px solid rgba(148, 163, 184, 0.3);",
      "  background: rgba(15, 23, 42, 0.62);",
      "  transition: transform 0.16s ease, border-color 0.16s ease, box-shadow 0.16s ease;",
      "  user-select: none;",
      "}",
      ".azdrop-thumb-card:hover {",
      "  border-color: rgba(56, 189, 248, 0.78);",
      "  box-shadow: 0 4px 14px rgba(14, 165, 233, 0.25);",
      "  transform: translateY(-1px);",
      "}",
      ".azdrop-thumb-card img {",
      "  width: 100%;",
      "  height: 100%;",
      "  object-fit: cover;",
      "  display: block;",
      "  pointer-events: none;",
      "}",
      ".azdrop-thumb-loading {",
      "  width: 100%;",
      "  height: 100%;",
      "  display: flex;",
      "  align-items: center;",
      "  justify-content: center;",
      "  font-size: 11px;",
      "  color: #93c5fd;",
      "  background: linear-gradient(135deg, rgba(30, 41, 59, 0.8), rgba(15, 23, 42, 0.9));",
      "}",
      ".azdrop-thumb-badge {",
      "  position: absolute;",
      "  left: 0;",
      "  right: 0;",
      "  bottom: 0;",
      "  padding: 2px 4px;",
      "  font-size: 9.5px;",
      "  line-height: 1.2;",
      "  color: #e0f2fe;",
      "  background: linear-gradient(to top, rgba(2, 6, 23, 0.86), rgba(2, 6, 23, 0));",
      "  white-space: nowrap;",
      "  overflow: hidden;",
      "  text-overflow: ellipsis;",
      "  text-align: center;",
      "  pointer-events: none;",
      "}",
      ".azdrop-thumb-close {",
      "  position: absolute;",
      "  top: 3px;",
      "  right: 3px;",
      "  width: 18px;",
      "  height: 18px;",
      "  border-radius: 999px;",
      "  border: 1px solid rgba(255, 255, 255, 0.28);",
      "  background: rgba(15, 23, 42, 0.82);",
      "  color: #f8fafc;",
      "  font-size: 12px;",
      "  line-height: 1;",
      "  display: flex;",
      "  align-items: center;",
      "  justify-content: center;",
      "  cursor: pointer;",
      "  padding: 0;",
      "  opacity: 0.85;",
      "  transition: background 0.14s ease, opacity 0.14s ease, transform 0.14s ease;",
      "}",
      ".azdrop-thumb-close:hover {",
      "  opacity: 1;",
      "  background: rgba(239, 68, 68, 0.92);",
      "  border-color: rgba(254, 202, 202, 0.7);",
      "  transform: scale(1.06);",
      "}",
      "#__azure-drop-lightbox {",
      "  position: fixed;",
      "  inset: 0;",
      "  z-index: 2147483645;",
      "  background: rgba(3, 7, 18, 0.86);",
      "  backdrop-filter: blur(12px);",
      "  -webkit-backdrop-filter: blur(12px);",
      "  display: flex;",
      "  flex-direction: column;",
      "  font-family: system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;",
      "  color: #e2e8f0;",
      "  user-select: none;",
      "}",
      "#__azure-drop-lightbox.azdrop-hidden { display: none !important; }",
      ".azdrop-lb-bar {",
      "  display: flex;",
      "  align-items: center;",
      "  justify-content: space-between;",
      "  gap: 12px;",
      "  padding: 10px 16px;",
      "  background: rgba(15, 23, 42, 0.72);",
      "  border-bottom: 1px solid rgba(96, 165, 250, 0.22);",
      "  flex-shrink: 0;",
      "}",
      ".azdrop-lb-info {",
      "  display: flex;",
      "  align-items: center;",
      "  gap: 10px;",
      "  min-width: 0;",
      "  font-size: 12.5px;",
      "}",
      ".azdrop-lb-name {",
      "  font-weight: 600;",
      "  color: #f0f9ff;",
      "  white-space: nowrap;",
      "  overflow: hidden;",
      "  text-overflow: ellipsis;",
      "  max-width: 36vw;",
      "}",
      ".azdrop-lb-meta { color: #94a3b8; font-size: 11.5px; white-space: nowrap; }",
      ".azdrop-lb-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }",
      ".azdrop-lb-btn {",
      "  cursor: pointer;",
      "  border-radius: 999px;",
      "  border: 1px solid rgba(148, 163, 184, 0.3);",
      "  background: rgba(30, 41, 59, 0.8);",
      "  color: #e2e8f0;",
      "  padding: 4px 10px;",
      "  font-size: 12px;",
      "  line-height: 1.4;",
      "  transition: all 0.15s ease;",
      "}",
      ".azdrop-lb-btn:hover { border-color: rgba(56, 189, 248, 0.7); background: rgba(56, 189, 248, 0.2); color: #ffffff; }",
      ".azdrop-lb-btn.close:hover { border-color: rgba(248, 113, 113, 0.7); background: rgba(239, 68, 68, 0.28); }",
      ".azdrop-lb-stage {",
      "  position: relative;",
      "  flex: 1;",
      "  overflow: hidden;",
      "  display: flex;",
      "  align-items: center;",
      "  justify-content: center;",
      "  cursor: grab;",
      "}",
      ".azdrop-lb-stage.dragging { cursor: grabbing; }",
      ".azdrop-lb-img {",
      "  max-width: 90vw;",
      "  max-height: 82vh;",
      "  object-fit: contain;",
      "  border-radius: 8px;",
      "  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.65);",
      "  transform-origin: center center;",
      "  transition: transform 0.08s ease-out;",
      "  -webkit-user-drag: none;",
      "}",
      ".azdrop-lb-img.raw-size { max-width: none; max-height: none; }",
      ".azdrop-lb-nav {",
      "  position: absolute;",
      "  top: 50%;",
      "  transform: translateY(-50%);",
      "  width: 40px;",
      "  height: 40px;",
      "  border-radius: 999px;",
      "  border: 1px solid rgba(148, 163, 184, 0.32);",
      "  background: rgba(15, 23, 42, 0.72);",
      "  color: #f8fafc;",
      "  font-size: 20px;",
      "  display: flex;",
      "  align-items: center;",
      "  justify-content: center;",
      "  cursor: pointer;",
      "  z-index: 2;",
      "}",
      ".azdrop-lb-nav:hover { border-color: rgba(56, 189, 248, 0.75); background: rgba(14, 165, 233, 0.35); }",
      ".azdrop-lb-nav.prev { left: 16px; }",
      ".azdrop-lb-nav.next { right: 16px; }",
      ".azdrop-lb-tip {",
      "  text-align: center;",
      "  padding: 6px 12px 10px;",
      "  font-size: 11px;",
      "  color: #94a3b8;",
      "  flex-shrink: 0;",
      "}",
      ".azdrop-msg-thumbs {",
      "  order: -10;",
      "  display: flex;",
      "  flex-wrap: wrap;",
      "  justify-content: flex-end;",
      "  gap: 6px;",
      "  margin-bottom: 2px;",
      "  max-width: 100%;",
      "}",
      ".azdrop-msg-thumbs.azdrop-hidden { display: none !important; }",
      ".azdrop-msg-thumb {",
      "  position: relative;",
      "  width: 68px;",
      "  height: 68px;",
      "  border-radius: 10px;",
      "  overflow: hidden;",
      "  cursor: zoom-in;",
      "  flex-shrink: 0;",
      "  border: 1px solid rgba(255, 255, 255, 0.14);",
      "  background: rgba(15, 23, 42, 0.55);",
      "  transition: transform 0.16s ease, border-color 0.16s ease, box-shadow 0.16s ease;",
      "}",
      ".azdrop-msg-thumb:hover {",
      "  border-color: rgba(56, 189, 248, 0.78);",
      "  box-shadow: 0 4px 14px rgba(14, 165, 233, 0.24);",
      "  transform: translateY(-1px);",
      "}",
      ".azdrop-msg-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }",
      "#__azure-drop-ctxmenu {",
      "  position: fixed;",
      "  z-index: 2147483646;",
      "  min-width: 176px;",
      "  padding: 5px;",
      "  border-radius: 10px;",
      "  background: rgba(34, 38, 48, 0.96);",
      "  border: 1px solid rgba(255, 255, 255, 0.13);",
      "  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.55);",
      "  backdrop-filter: blur(14px);",
      "  -webkit-backdrop-filter: blur(14px);",
      "  font-family: system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;",
      "  color: #e5e7eb;",
      "  user-select: none;",
      "}",
      "#__azure-drop-ctxmenu.azdrop-hidden { display: none !important; }",
      ".azdrop-ctx-item {",
      "  display: flex;",
      "  align-items: center;",
      "  gap: 9px;",
      "  width: 100%;",
      "  padding: 7px 10px;",
      "  border: none;",
      "  border-radius: 7px;",
      "  background: transparent;",
      "  color: #e5e7eb;",
      "  font-size: 13px;",
      "  line-height: 1.35;",
      "  text-align: left;",
      "  cursor: pointer;",
      "  transition: background 0.12s ease, color 0.12s ease;",
      "}",
      ".azdrop-ctx-item:hover { background: rgba(255, 255, 255, 0.1); color: #ffffff; }",
      ".azdrop-ctx-item svg { width: 15px; height: 15px; flex-shrink: 0; opacity: 0.88; }",
      ".azdrop-ctx-sep { height: 1px; margin: 4px 6px; background: rgba(255, 255, 255, 0.08); }"
    ].join("\\n");
    (document.head || document.documentElement).appendChild(style);
  }

  function sendBridge(payload, expectReply = false, timeoutMs = 15000) {
    if (typeof window.__azureDropBridge !== "function") {
      return Promise.reject(new Error("Azure Drop CDP bridge 未就绪"));
    }
    const reqId = "ad_" + Date.now() + "_" + (reqSeq++);
    const body = JSON.stringify(Object.assign({ reqId }, payload));
    if (!expectReply) {
      try { window.__azureDropBridge(body); } catch {}
      return Promise.resolve({ ok: true });
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingReqs.delete(reqId);
        reject(new Error("本机桥接响应超时"));
      }, timeoutMs);
      pendingReqs.set(reqId, { resolve, reject, timer });
      try {
        window.__azureDropBridge(body);
      } catch (err) {
        clearTimeout(timer);
        pendingReqs.delete(reqId);
        reject(err);
      }
    });
  }

  function showToast(text, isError = false) {
    if (!cfg.showPageToast && !isError) return;
    try {
      let el = document.getElementById("__azure-drop-toast");
      if (!el) {
        el = document.createElement("div");
        el.id = "__azure-drop-toast";
        Object.assign(el.style, {
          position: "fixed",
          right: "20px",
          bottom: "76px",
          zIndex: "2147483640",
          padding: "8px 14px",
          borderRadius: "10px",
          fontSize: "12.5px",
          fontWeight: "500",
          fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif",
          color: "#e0f2fe",
          background: "rgba(15, 23, 42, 0.86)",
          border: "1px solid rgba(56, 189, 248, 0.45)",
          boxShadow: "0 8px 24px rgba(2, 6, 23, 0.45)",
          backdropFilter: "blur(12px)",
          WebkitBackdropFilter: "blur(12px)",
          pointerEvents: "none",
          transition: "opacity 0.22s ease, transform 0.22s ease",
          opacity: "0",
          transform: "translateY(6px)",
          maxWidth: "380px",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        });
        document.body.appendChild(el);
      }
      el.style.borderColor = isError ? "rgba(248, 113, 113, 0.65)" : "rgba(56, 189, 248, 0.45)";
      el.style.color = isError ? "#fecaca" : "#e0f2fe";
      el.textContent = "🌊 苍蓝流笺 · " + text;
      el.style.opacity = "1";
      el.style.transform = "translateY(0)";
      clearTimeout(el.__hideTimer);
      el.__hideTimer = setTimeout(() => {
        el.style.opacity = "0";
        el.style.transform = "translateY(6px)";
      }, isError ? 3200 : 1900);
    } catch {}
  }

  function setDragHint(visible, shiftHeld = false) {
    try {
      let el = document.getElementById("__azure-drop-hint");
      if (!visible) {
        if (el) el.style.opacity = "0";
        return;
      }
      if (!cfg.showPageToast) return;
      if (!el) {
        el = document.createElement("div");
        el.id = "__azure-drop-hint";
        Object.assign(el.style, {
          position: "fixed",
          left: "50%",
          bottom: "86px",
          transform: "translateX(-50%)",
          zIndex: "2147483639",
          padding: "7px 14px",
          borderRadius: "999px",
          fontSize: "12px",
          fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif",
          color: "#bae6fd",
          background: "rgba(15, 23, 42, 0.88)",
          border: "1px solid rgba(56, 189, 248, 0.5)",
          boxShadow: "0 8px 24px rgba(2, 6, 23, 0.45)",
          backdropFilter: "blur(10px)",
          pointerEvents: "none",
          transition: "opacity 0.15s ease",
          opacity: "0",
        });
        document.body.appendChild(el);
      }
      const modeTip = cfg.insertMode === "mention" ? "插入原生文件标签" : "插入原始绝对路径";
      el.textContent = shiftHeld
        ? "📎 已按住 Shift：松开将走 Antigravity 原生附件"
        : ("🌊 松开" + modeTip + "（按住 Shift 放行原生附件）");
      el.style.opacity = "1";
    } catch {}
  }

  function resolveFilePath(file) {
    if (!file) return "";
    try {
      if (window.electronNative && typeof window.electronNative.getPathForFile === "function") {
        const p = window.electronNative.getPathForFile(file);
        if (p && typeof p === "string") return p;
      }
    } catch {}
    if (typeof file.path === "string" && file.path.trim()) return file.path.trim();
    return "";
  }

  function formatPath(raw) {
    let p = String(raw || "").trim();
    if (!p) return "";
    if (cfg.pathSeparator === "posix") p = p.replace(/\\\\/g, "/");
    else if (cfg.pathSeparator === "win32") p = p.replace(/\\//g, "\\\\");
    if (cfg.quotePathsWithSpaces && /\\s/.test(p) && !(/^["'].*["']$/.test(p))) {
      p = '"' + p + '"';
    }
    return p;
  }

  function localPathToFileUri(raw) {
    let p = String(raw || "").replace(/\\\\/g, "/");
    if (/^[a-zA-Z]:\\//.test(p)) p = "/" + p;
    const encoded = p.split("/").map((seg, i) => (i === 1 && /^[a-zA-Z]:$/.test(seg)) ? seg : encodeURIComponent(seg)).join("/");
    return "file://" + (encoded.startsWith("/") ? encoded : "/" + encoded);
  }

  function fileUriToLocalPath(uri) {
    let s = String(uri || "").trim();
    if (!/^file:/i.test(s)) return s;
    s = s.replace(/^file:\\/\\//i, "");
    try { s = decodeURIComponent(s); } catch {}
    if (/^\\/[a-zA-Z]:(?:\\/|$)/.test(s)) {
      s = s.slice(1).replace(/\\//g, "\\\\");
      s = s[0].toUpperCase() + s.slice(1);
    }
    return s;
  }

  function normalizeUriKey(uriOrPath) {
    let s = String(uriOrPath || "").trim();
    if (!s) return "";
    if (!/^file:/i.test(s)) s = localPathToFileUri(s);
    try { s = decodeURIComponent(s); } catch {}
    s = s.replace(/^file:\\/\\/+/i, "/").replace(/\\\\/g, "/").replace(/\\/+$/, "").toLowerCase();
    return s;
  }

  function basenameOf(raw) {
    const s = String(raw || "").replace(/[\\\\/]+$/, "");
    const idx = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\\\"));
    return idx >= 0 ? s.slice(idx + 1) : s;
  }

  function isImageItem(item) {
    if (!item || item.isDirectory) return false;
    return IMAGE_EXT_RE.test(String(item.path || item.fileName || ""));
  }

  function formatKB(bytes) {
    const n = Number(bytes || 0);
    if (!n) return "";
    if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(2) + " MB";
    return Math.max(1, Math.round(n / 1024)) + " KB";
  }

  function findChatEditor(preferTarget) {
    if (preferTarget && preferTarget.closest) {
      const hit = preferTarget.closest('[data-lexical-editor="true"][contenteditable="true"], [contenteditable="true"][aria-label*="Message" i]');
      if (hit) return hit;
    }
    const active = document.activeElement;
    if (active && active.matches && active.matches('[data-lexical-editor="true"][contenteditable="true"]')) {
      return active;
    }
    const candidates = Array.from(document.querySelectorAll('[data-lexical-editor="true"][contenteditable="true"]'));
    const visible = candidates.filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 40 && r.height > 10;
    });
    if (visible.length) {
      const msgBox = visible.find((el) => /message/i.test(el.getAttribute("aria-label") || ""));
      return msgBox || visible[visible.length - 1];
    }
    return candidates[0] || null;
  }

  function findComposerCard(editor) {
    if (!editor) return null;
    return editor.closest(".surface-composer-card") || editor.closest(".surface-composer") || editor.parentElement;
  }

  function ensurePreviewStrip(editor) {
    ensureStyles();
    const card = findComposerCard(editor || findChatEditor());
    if (!card) return null;
    let strip = document.getElementById("__azure-drop-preview-strip");
    if (!strip) {
      strip = document.createElement("div");
      strip.id = "__azure-drop-preview-strip";
      strip.setAttribute("data-azure-drop-ui", "1");
    }
    if (strip.parentElement !== card) {
      card.appendChild(strip);
    }
    return strip;
  }

  function renderPreviewStrip(preferEditor) {
    const editor = preferEditor || watchedEditor || findChatEditor();
    const strip = ensurePreviewStrip(editor);
    if (!strip) return;

    if (!cfg.enabled || !cfg.showImagePreviewBar || !previewItems.length) {
      strip.classList.add("azdrop-hidden");
      strip.innerHTML = "";
      return;
    }

    strip.classList.remove("azdrop-hidden");
    strip.innerHTML = "";

    for (const item of previewItems) {
      const card = document.createElement("div");
      card.className = "azdrop-thumb-card";
      card.dataset.id = item.id;
      const dimText = item.naturalWidth && item.naturalHeight ? (item.naturalWidth + "×" + item.naturalHeight) : "";
      const sizeText = formatKB(item.bytes);
      const subParts = [dimText, sizeText].filter(Boolean).join(" · ");
      card.title = item.fileName + (subParts ? (" (" + subParts + ")") : "") + " — 点击查看大图";

      if (item.dataUrl) {
        const img = document.createElement("img");
        img.src = item.dataUrl;
        img.alt = item.fileName;
        img.onload = () => {
          if (!item.naturalWidth && img.naturalWidth) {
            item.naturalWidth = img.naturalWidth;
            item.naturalHeight = img.naturalHeight;
            const badge = card.querySelector(".azdrop-thumb-badge");
            if (badge) badge.textContent = img.naturalWidth + "×" + img.naturalHeight;
            const nextSub = [img.naturalWidth + "×" + img.naturalHeight, formatKB(item.bytes)].filter(Boolean).join(" · ");
            card.title = item.fileName + (nextSub ? (" (" + nextSub + ")") : "") + " — 点击查看大图";
            if (lightboxState.open && lightboxState.activeId === item.id) {
              updateLightboxContent();
            }
          }
        };
        card.appendChild(img);
      } else {
        const ld = document.createElement("div");
        ld.className = "azdrop-thumb-loading";
        ld.textContent = item.error ? "预览失败" : "加载中";
        card.appendChild(ld);
      }

      const badge = document.createElement("div");
      badge.className = "azdrop-thumb-badge";
      badge.textContent = dimText || (item.fileName.split(".").pop() || "IMG").toUpperCase();
      card.appendChild(badge);

      const closeBtn = document.createElement("button");
      closeBtn.type = "button";
      closeBtn.className = "azdrop-thumb-close";
      closeBtn.title = "移除图片并删除输入框引用";
      closeBtn.textContent = "×";
      closeBtn.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        removePreviewItem(item.id, true);
      });
      card.appendChild(closeBtn);

      card.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        openLightbox(item.id);
      });

      strip.appendChild(card);
    }
  }

  function removeEntryFromEditor(entry) {
    const editor = watchedEditor || findChatEditor();
    const lex = editor && editor.__lexicalEditor;
    if (!lex || typeof lex.update !== "function") return;
    const targetKey = entry.uriKey || normalizeUriKey(entry.fileUri || entry.path);
    const formattedPath = formatPath(entry.path);
    const rawPath = String(entry.path || "");
    try {
      lex.update(() => {
        const nodeMap = (lex._pendingEditorState && lex._pendingEditorState._nodeMap)
          || (lex.getEditorState && lex.getEditorState()._nodeMap);
        if (!nodeMap || typeof nodeMap.values !== "function") return;
        let removedMention = false;
        for (const node of Array.from(nodeMap.values())) {
          if (!node || typeof node.getType !== "function") continue;
          if (node.getType() === "contextScopeItemMention") {
            let uri = "";
            try {
              const exported = typeof node.exportJSON === "function" ? node.exportJSON() : null;
              const rawData = exported?.data?.data || node.__data?.data;
              if (rawData) {
                const parsed = typeof rawData === "string" ? JSON.parse(rawData) : rawData;
                uri = parsed?.file?.absoluteUri || parsed?.directory?.absoluteUri || "";
              }
            } catch {}
            if (uri && normalizeUriKey(uri) === targetKey) {
              try {
                const next = typeof node.getNextSibling === "function" ? node.getNextSibling() : null;
                node.remove();
                if (next && typeof next.getType === "function" && next.getType() === "text" && typeof next.getTextContent === "function") {
                  const t = next.getTextContent();
                  if (t === " ") next.remove();
                  else if (t.startsWith(" ") && typeof next.setTextContent === "function") next.setTextContent(t.slice(1));
                }
                removedMention = true;
                break;
              } catch {}
            }
          }
        }
        if (!removedMention && (formattedPath || rawPath)) {
          for (const node of Array.from(nodeMap.values())) {
            if (!node || typeof node.getType !== "function" || node.getType() !== "text") continue;
            if (typeof node.getTextContent !== "function" || typeof node.setTextContent !== "function") continue;
            const txt = node.getTextContent();
            const candidate = formattedPath && txt.includes(formattedPath) ? formattedPath : (rawPath && txt.includes(rawPath) ? rawPath : "");
            if (candidate) {
              const nextTxt = txt.replace(candidate + " ", "").replace(candidate, "");
              if (!nextTxt) node.remove();
              else node.setTextContent(nextTxt);
              break;
            }
          }
        }
      }, { discrete: true });
    } catch {}
  }

  function removePreviewItem(id, alsoRemoveFromEditor = false) {
    const idx = previewItems.findIndex((x) => x.id === id);
    if (idx < 0) return;
    const [removed] = previewItems.splice(idx, 1);
    if (alsoRemoveFromEditor && removed) {
      removeEntryFromEditor(removed);
    }
    renderPreviewStrip();
    if (lightboxState.open && lightboxState.activeId === id) {
      if (previewItems.length) {
        const nextIdx = Math.min(idx, previewItems.length - 1);
        openLightbox(previewItems[nextIdx].id);
      } else {
        closeLightbox();
      }
    }
  }

  function addPreviewItems(items, preferEditor) {
    if (!Array.isArray(items) || !items.length) return;
    const editor = preferEditor || findChatEditor();
    if (editor) attachEditorWatcher(editor);

    const addedForLoad = [];
    for (const raw of items) {
      if (!isImageItem(raw)) continue;
      const filePath = String(raw.path || raw.filePath || "").trim();
      if (!filePath) continue;
      const fileUri = raw.fileUri || localPathToFileUri(filePath);
      const uriKey = normalizeUriKey(fileUri);
      const existing = previewItems.find((x) => x.uriKey === uriKey);
      if (existing) {
        existing.addedAt = Date.now();
        if (raw.dataUrl && !existing.dataUrl) existing.dataUrl = raw.dataUrl;
        if (raw.bytes && !existing.bytes) existing.bytes = raw.bytes;
        continue;
      }
      const entry = {
        id: "adp_" + Date.now() + "_" + (previewSeq++),
        path: filePath,
        fileUri,
        uriKey,
        fileName: raw.fileName || basenameOf(filePath),
        bytes: Number(raw.bytes || 0),
        dataUrl: raw.dataUrl || "",
        error: false,
        naturalWidth: 0,
        naturalHeight: 0,
        addedAt: Date.now(),
      };
      previewItems.push(entry);
      if (entry.dataUrl) {
        cacheImageData(entry.uriKey, entry);
      } else {
        const cached = imageDataCache.get(entry.uriKey);
        if (cached && cached.dataUrl) {
          entry.dataUrl = cached.dataUrl;
          entry.bytes = cached.bytes || entry.bytes;
        } else {
          addedForLoad.push(entry);
        }
      }
    }

    renderPreviewStrip(editor);

    for (const entry of addedForLoad) {
      loadImageDataCached(entry.path, entry.fileUri)
        .then((res) => {
          if (res && res.dataUrl) {
            entry.dataUrl = res.dataUrl;
            entry.bytes = Number(res.bytes || entry.bytes || 0);
            entry.fileName = res.fileName || entry.fileName;
          } else {
            entry.error = true;
          }
          renderPreviewStrip(editor);
          if (lightboxState.open && lightboxState.activeId === entry.id) {
            updateLightboxContent();
          }
        })
        .catch(() => {
          entry.error = true;
          renderPreviewStrip(editor);
        });
    }
  }

  function cacheImageData(uriKey, data) {
    if (!uriKey || !data) return;
    if (imageDataCache.size >= 60 && !imageDataCache.has(uriKey)) {
      const firstKey = imageDataCache.keys().next().value;
      if (firstKey) imageDataCache.delete(firstKey);
    }
    imageDataCache.set(uriKey, {
      dataUrl: data.dataUrl || "",
      bytes: Number(data.bytes || 0),
      fileName: data.fileName || "",
      path: data.path || data.filePath || "",
      fileUri: data.fileUri || "",
      error: Boolean(data.error),
    });
  }

  function loadImageDataCached(filePath, fileUri) {
    const uriKey = normalizeUriKey(fileUri || filePath);
    const cached = imageDataCache.get(uriKey);
    if (cached && (cached.dataUrl || cached.error)) {
      return Promise.resolve(cached);
    }
    if (imageLoadingPromises.has(uriKey)) {
      return imageLoadingPromises.get(uriKey);
    }
    const p = sendBridge({ kind: "read-image", filePath }, true, 15000)
      .then((res) => {
        const val = (res && res.ok && res.dataUrl)
          ? { dataUrl: res.dataUrl, bytes: Number(res.bytes || 0), fileName: res.fileName || basenameOf(filePath), path: res.filePath || filePath, fileUri: res.fileUri || fileUri, error: false }
          : { dataUrl: "", bytes: 0, fileName: basenameOf(filePath), path: filePath, fileUri, error: true };
        cacheImageData(uriKey, val);
        return val;
      })
      .catch(() => {
        const val = { dataUrl: "", bytes: 0, fileName: basenameOf(filePath), path: filePath, fileUri, error: true };
        cacheImageData(uriKey, val);
        return val;
      })
      .finally(() => {
        imageLoadingPromises.delete(uriKey);
      });
    imageLoadingPromises.set(uriKey, p);
    return p;
  }

  function collectEditorRefs(stateJson) {
    const uris = new Set();
    const texts = [];
    function walk(node) {
      if (!node || typeof node !== "object") return;
      if (node.type === "contextScopeItemMention") {
        try {
          const raw = node.data?.data;
          const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
          const u = parsed?.file?.absoluteUri || parsed?.directory?.absoluteUri;
          if (u) uris.add(normalizeUriKey(u));
        } catch {}
      } else if (node.type === "text" && typeof node.text === "string") {
        texts.push(node.text);
      }
      if (Array.isArray(node.children)) {
        for (const ch of node.children) walk(ch);
      }
    }
    walk(stateJson?.root || stateJson);
    return { uris, fullText: texts.join(" ") };
  }

  function syncPreviewsWithEditor(editor, editorState) {
    if (!previewItems.length) return;
    const lex = editor && editor.__lexicalEditor;
    if (!lex) return;
    let json = null;
    try {
      const st = editorState || (typeof lex.getEditorState === "function" ? lex.getEditorState() : null);
      if (!st || typeof st.toJSON !== "function") return;
      json = st.toJSON();
    } catch {
      return;
    }

    const { uris, fullText } = collectEditorRefs(json);
    const fullLower = fullText.toLowerCase();
    const now = Date.now();
    const nextList = previewItems.filter((item) => {
      if (now - item.addedAt < 750) return true;
      if (uris.has(item.uriKey)) return true;
      const pLower = String(item.path || "").toLowerCase();
      const pPosix = pLower.replace(/\\\\/g, "/");
      if (pLower && (fullLower.includes(pLower) || fullLower.includes(pPosix))) return true;
      return false;
    });

    if (nextList.length !== previewItems.length) {
      previewItems = nextList;
      renderPreviewStrip(editor);
      if (lightboxState.open && !previewItems.some((x) => x.id === lightboxState.activeId)) {
        if (previewItems.length) openLightbox(previewItems[0].id);
        else closeLightbox();
      }
    }
  }

  function attachEditorWatcher(editor) {
    if (!editor || editor === watchedEditor) return;
    if (typeof unregisterLexical === "function") {
      try { unregisterLexical(); } catch {}
      unregisterLexical = null;
    }
    watchedEditor = editor;
    const lex = editor.__lexicalEditor;
    if (lex && typeof lex.registerUpdateListener === "function") {
      try {
        unregisterLexical = lex.registerUpdateListener(({ editorState }) => {
          syncPreviewsWithEditor(editor, editorState);
        });
      } catch {}
    }
  }

  // ===== 无损高清大图灯箱 =====
  function ensureLightbox() {
    ensureStyles();
    let lb = document.getElementById("__azure-drop-lightbox");
    if (lb) return lb;
    lb = document.createElement("div");
    lb.id = "__azure-drop-lightbox";
    lb.className = "azdrop-hidden";
    lb.setAttribute("data-azure-drop-ui", "1");
    lb.innerHTML = [
      '<div class="azdrop-lb-bar">',
      '  <div class="azdrop-lb-info">',
      '    <span class="azdrop-lb-name" id="azdrop-lb-name"></span>',
      '    <span class="azdrop-lb-meta" id="azdrop-lb-meta"></span>',
      '  </div>',
      '  <div class="azdrop-lb-actions">',
      '    <button type="button" class="azdrop-lb-btn" data-act="zoom-out" title="缩小 (-)">－</button>',
      '    <button type="button" class="azdrop-lb-btn" data-act="zoom-toggle" id="azdrop-lb-zoom-btn" title="切换 适应窗口 / 1:1 原图 (0)">适应</button>',
      '    <button type="button" class="azdrop-lb-btn" data-act="zoom-in" title="放大 (+)">＋</button>',
      '    <button type="button" class="azdrop-lb-btn" data-act="copy-path" title="复制本地绝对路径">复制路径</button>',
      '    <button type="button" class="azdrop-lb-btn" data-act="open-sys" title="用系统默认看图器打开原图">系统打开</button>',
      '    <button type="button" class="azdrop-lb-btn close" data-act="close" title="关闭 (Esc)">✕ 关闭</button>',
      '  </div>',
      '</div>',
      '<div class="azdrop-lb-stage" id="azdrop-lb-stage">',
      '  <button type="button" class="azdrop-lb-nav prev" data-act="prev" id="azdrop-lb-prev" title="上一张 (←)">‹</button>',
      '  <img class="azdrop-lb-img" id="azdrop-lb-img" alt="" />',
      '  <button type="button" class="azdrop-lb-nav next" data-act="next" id="azdrop-lb-next" title="下一张 (→)">›</button>',
      '</div>',
      '<div class="azdrop-lb-tip">滚轮缩放 · 拖拽平移 · 双击切换 1:1 原图 · Esc 或点击空白关闭</div>'
    ].join("");

    lb.addEventListener("click", (ev) => {
      const btn = ev.target && ev.target.closest ? ev.target.closest("[data-act]") : null;
      if (btn) {
        ev.preventDefault();
        ev.stopPropagation();
        const act = btn.getAttribute("data-act");
        if (act === "close") closeLightbox();
        else if (act === "zoom-in") setLightboxZoom(lightboxState.scale * 1.25);
        else if (act === "zoom-out") setLightboxZoom(lightboxState.scale / 1.25);
        else if (act === "zoom-toggle") toggleLightboxFit();
        else if (act === "prev") stepLightbox(-1);
        else if (act === "next") stepLightbox(1);
        else if (act === "copy-path") {
          const item = getActiveLightboxItem();
          if (item && item.path) {
            navigator.clipboard?.writeText(item.path).then(
              () => showToast("已复制图片路径"),
              () => showToast(item.path)
            );
          }
        } else if (act === "open-sys") {
          const item = getActiveLightboxItem();
          if (item && item.path) {
            sendBridge({ kind: "open-image", filePath: item.path }, true, 8000).then(
              () => showToast("已调用系统看图器打开"),
              (err) => showToast("打开失败：" + (err?.message || err), true)
            );
          }
        }
        return;
      }
      if (ev.target && ev.target.id === "azdrop-lb-stage" && !lightboxState.dragMoved) {
        closeLightbox();
      }
    });

    const stage = lb.querySelector("#azdrop-lb-stage");
    const imgEl = lb.querySelector("#azdrop-lb-img");

    stage.addEventListener("wheel", (ev) => {
      ev.preventDefault();
      const factor = ev.deltaY < 0 ? 1.15 : 1 / 1.15;
      setLightboxZoom(lightboxState.scale * factor);
    }, { passive: false });

    stage.addEventListener("mousedown", (ev) => {
      if (ev.button !== 0) return;
      if (ev.target && ev.target.closest && ev.target.closest("button")) return;
      lightboxState.dragging = true;
      lightboxState.dragMoved = false;
      lightboxState.startX = ev.clientX;
      lightboxState.startY = ev.clientY;
      lightboxState.origTx = lightboxState.tx;
      lightboxState.origTy = lightboxState.ty;
      stage.classList.add("dragging");
    });

    imgEl.addEventListener("dblclick", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      toggleLightboxFit();
    });

    document.body.appendChild(lb);
    return lb;
  }

  function onGlobalMouseMove(ev) {
    if (!lightboxState.open || !lightboxState.dragging) return;
    const dx = ev.clientX - lightboxState.startX;
    const dy = ev.clientY - lightboxState.startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) lightboxState.dragMoved = true;
    lightboxState.tx = lightboxState.origTx + dx;
    lightboxState.ty = lightboxState.origTy + dy;
    applyLightboxTransform();
  }

  function onGlobalMouseUp() {
    if (!lightboxState.dragging) return;
    lightboxState.dragging = false;
    const stage = document.getElementById("azdrop-lb-stage");
    if (stage) stage.classList.remove("dragging");
    setTimeout(() => { lightboxState.dragMoved = false; }, 30);
  }

  function onGlobalKeyDown(ev) {
    if (ev.key === "Escape") hideContextMenu();
    if (!lightboxState.open) return;
    if (ev.key === "Escape") {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      closeLightbox();
    } else if (ev.key === "ArrowLeft") {
      ev.preventDefault();
      stepLightbox(-1);
    } else if (ev.key === "ArrowRight") {
      ev.preventDefault();
      stepLightbox(1);
    } else if (ev.key === "+" || ev.key === "=") {
      ev.preventDefault();
      setLightboxZoom(lightboxState.scale * 1.25);
    } else if (ev.key === "-" || ev.key === "_") {
      ev.preventDefault();
      setLightboxZoom(lightboxState.scale / 1.25);
    } else if (ev.key === "0") {
      ev.preventDefault();
      toggleLightboxFit();
    }
  }

  function getLightboxList() {
    return Array.isArray(lightboxState.items) ? lightboxState.items : previewItems;
  }

  function getActiveLightboxItem() {
    const list = getLightboxList();
    return list.find((x) => x.id === lightboxState.activeId) || null;
  }

  function applyLightboxTransform() {
    const imgEl = document.getElementById("azdrop-lb-img");
    const zoomBtn = document.getElementById("azdrop-lb-zoom-btn");
    if (!imgEl) return;
    imgEl.classList.toggle("raw-size", !lightboxState.fitMode);
    imgEl.style.transform = "translate(" + Math.round(lightboxState.tx) + "px, " + Math.round(lightboxState.ty) + "px) scale(" + lightboxState.scale.toFixed(3) + ")";
    if (zoomBtn) {
      if (lightboxState.fitMode && Math.abs(lightboxState.scale - 1) < 0.01) {
        zoomBtn.textContent = "适应";
      } else {
        zoomBtn.textContent = Math.round(lightboxState.scale * 100) + "%";
      }
    }
  }

  function setLightboxZoom(nextScale) {
    const clamped = Math.max(0.25, Math.min(6, Number(nextScale) || 1));
    lightboxState.scale = clamped;
    applyLightboxTransform();
  }

  function toggleLightboxFit() {
    lightboxState.fitMode = !lightboxState.fitMode;
    lightboxState.scale = 1;
    lightboxState.tx = 0;
    lightboxState.ty = 0;
    applyLightboxTransform();
  }

  function updateLightboxContent() {
    const item = getActiveLightboxItem();
    if (!item) return closeLightbox();
    const list = getLightboxList();
    const lb = ensureLightbox();
    const idx = list.findIndex((x) => x.id === item.id);
    const nameEl = lb.querySelector("#azdrop-lb-name");
    const metaEl = lb.querySelector("#azdrop-lb-meta");
    const imgEl = lb.querySelector("#azdrop-lb-img");
    const prevBtn = lb.querySelector("#azdrop-lb-prev");
    const nextBtn = lb.querySelector("#azdrop-lb-next");

    nameEl.textContent = item.fileName || "图片预览";
    const metaParts = [];
    if (item.naturalWidth && item.naturalHeight) metaParts.push(item.naturalWidth + " × " + item.naturalHeight);
    if (item.bytes) metaParts.push(formatKB(item.bytes));
    if (list.length > 1) metaParts.push((idx + 1) + " / " + list.length);
    metaEl.textContent = metaParts.join(" · ");

    imgEl.src = item.dataUrl || "";
    imgEl.alt = item.fileName || "";
    const showNav = list.length > 1;
    prevBtn.style.display = showNav ? "flex" : "none";
    nextBtn.style.display = showNav ? "flex" : "none";
    applyLightboxTransform();
  }

  function openLightbox(itemId, customList = null) {
    const list = Array.isArray(customList) ? customList : previewItems;
    const item = list.find((x) => x.id === itemId);
    if (!item || !item.dataUrl) {
      if (item && !item.dataUrl) showToast("图片预览加载中，请稍候");
      return;
    }
    const lb = ensureLightbox();
    lightboxState.open = true;
    lightboxState.items = Array.isArray(customList) ? customList : null;
    lightboxState.activeId = itemId;
    lightboxState.scale = 1;
    lightboxState.tx = 0;
    lightboxState.ty = 0;
    lightboxState.fitMode = true;
    lb.classList.remove("azdrop-hidden");
    updateLightboxContent();
  }

  function stepLightbox(delta) {
    const list = getLightboxList();
    if (list.length <= 1) return;
    const idx = list.findIndex((x) => x.id === lightboxState.activeId);
    const nextIdx = (idx + delta + list.length) % list.length;
    openLightbox(list[nextIdx].id, lightboxState.items);
  }

  function closeLightbox() {
    lightboxState.open = false;
    lightboxState.items = null;
    lightboxState.activeId = null;
    lightboxState.dragging = false;
    const lb = document.getElementById("__azure-drop-lightbox");
    if (lb) lb.classList.add("azdrop-hidden");
  }

  // ===== 已发消息气泡上方右对齐图片缩略图 =====
  function scanSentMessages() {
    if (document.hidden) {
      needsWakeScan = true;
      return;
    }
    const bubbles = document.querySelectorAll('[data-testid="user-message-bubble"]');
    if (!bubbles.length) return;
    ensureStyles();

    for (const bubble of bubbles) {
      const frame = bubble.closest(".agy-user-bubble-frame");
      const host = frame ? frame.parentElement : null;
      if (!host) continue;

      let strip = host.querySelector(":scope > .azdrop-msg-thumbs");
      if (!cfg.enabled || !cfg.showImagePreviewBar) {
        if (strip) strip.classList.add("azdrop-hidden");
        continue;
      }

      // 先做零布局开销的 [data-uri] 扫描，99% 无图片消息直接跳过，彻底避免同步 getBoundingClientRect 回流
      const mentionEls = Array.from(bubble.querySelectorAll('bdi.context-scope-mention [data-uri], [data-uri]'));
      const seen = new Set();
      const imgRefs = [];
      for (const el of mentionEls) {
        const uri = el.getAttribute("data-uri");
        if (!uri || !/^file:/i.test(uri)) continue;
        const localPath = fileUriToLocalPath(uri);
        if (!IMAGE_EXT_RE.test(localPath)) continue;
        const key = normalizeUriKey(uri);
        if (seen.has(key)) continue;
        seen.add(key);
        imgRefs.push({
          id: "msgimg_" + key,
          uriKey: key,
          fileUri: uri,
          path: localPath,
          fileName: basenameOf(localPath),
          bytes: 0,
          dataUrl: "",
          naturalWidth: 0,
          naturalHeight: 0,
        });
      }

      if (!imgRefs.length) {
        if (strip) strip.remove();
        continue;
      }

      const sig = imgRefs.map((x) => x.uriKey).join("|");
      if (strip && strip.dataset.sig === sig) {
        strip.classList.remove("azdrop-hidden");
        continue;
      }

      // 仅对确有未渲染图片标签的气泡，检查一次是否已有原生附件图避免重复
      const stepWrap = host.closest('[data-testid="user-input-step"]') || host.parentElement;
      const nativeImgs = stepWrap
        ? Array.from(stepWrap.querySelectorAll("img")).filter((im) => {
            if (im.closest("[data-azure-drop-ui]") || bubble.contains(im)) return false;
            const r = im.getBoundingClientRect();
            return r.width >= 36 || r.height >= 36;
          })
        : [];
      if (nativeImgs.length > 0) {
        if (strip) strip.remove();
        continue;
      }

      if (!strip) {
        strip = document.createElement("div");
        strip.className = "azdrop-msg-thumbs";
        strip.setAttribute("data-azure-drop-ui", "1");
        host.appendChild(strip);
      }
      strip.classList.remove("azdrop-hidden");
      strip.dataset.sig = sig;
      strip.innerHTML = "";

      for (const ref of imgRefs) {
        const box = document.createElement("div");
        box.className = "azdrop-msg-thumb";
        box.title = ref.fileName + " — 点击查看大图";
        const ld = document.createElement("div");
        ld.className = "azdrop-thumb-loading";
        ld.textContent = "加载中";
        box.appendChild(ld);

        box.addEventListener("click", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          openLightbox(ref.id, imgRefs);
        });
        strip.appendChild(box);

        loadImageDataCached(ref.path, ref.fileUri).then((res) => {
          if (!box.isConnected) return;
          if (!res || !res.dataUrl) {
            box.remove();
            if (!strip.children.length) strip.classList.add("azdrop-hidden");
            return;
          }
          ref.dataUrl = res.dataUrl;
          ref.bytes = res.bytes || 0;
          ref.fileName = res.fileName || ref.fileName;
          box.innerHTML = "";
          const im = document.createElement("img");
          im.src = res.dataUrl;
          im.alt = ref.fileName;
          im.onload = () => {
            if (im.naturalWidth) {
              ref.naturalWidth = im.naturalWidth;
              ref.naturalHeight = im.naturalHeight;
              box.title = ref.fileName + " (" + im.naturalWidth + "×" + im.naturalHeight + (ref.bytes ? (" · " + formatKB(ref.bytes)) : "") + ") — 点击查看大图";
            }
          };
          box.appendChild(im);
        });
      }
    }
  }

  function scheduleScanSentMessages() {
    clearTimeout(msgScanTimer);
    msgScanTimer = setTimeout(() => {
      try { scanSentMessages(); } catch {}
    }, 180);
  }

  // ===== 顶栏文件路径面包屑右键菜单 =====
  function ensureContextMenu() {
    ensureStyles();
    let menu = document.getElementById("__azure-drop-ctxmenu");
    if (!menu) {
      menu = document.createElement("div");
      menu.id = "__azure-drop-ctxmenu";
      menu.className = "azdrop-hidden";
      menu.setAttribute("data-azure-drop-ui", "1");
      document.body.appendChild(menu);
    }
    return menu;
  }

  function hideContextMenu() {
    const menu = document.getElementById("__azure-drop-ctxmenu");
    if (menu) menu.classList.add("azdrop-hidden");
  }

  const CTX_ICONS = {
    clip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>',
    folderOpen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1H3V7z"/><path d="M3 10h18l-1.5 8a2 2 0 0 1-2 1.6H6.5a2 2 0 0 1-2-1.6L3 10z"/></svg>',
    folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg>',
    link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
  };

  function showBreadcrumbContextMenu(x, y, info) {
    const menu = ensureContextMenu();
    const isDir = Boolean(info.isDirectory);
    const isDriveRoot = /^[a-zA-Z]:\\\\?$/.test(info.path) || info.path === "/";

    const rows = [
      {
        icon: CTX_ICONS.clip,
        label: "引用到输入框",
        action: () => {
          const editor = findChatEditor();
          if (insertItemsIntoEditor([info], editor)) {
            if (isImageItem(info)) addPreviewItems([info], editor);
            sendBridge({ kind: "stat", pathInserts: 1 }, false);
            showToast(cfg.insertMode === "mention" ? "已引用到输入框" : "已插入路径到输入框");
          }
        },
      },
    ];

    if (isDir) {
      rows.push({
        icon: CTX_ICONS.folderOpen,
        label: "打开此文件夹",
        action: () => {
          sendBridge({ kind: "reveal-path", path: info.path, fileUri: info.fileUri, openDirDirectly: true }, true, 8000)
            .then(() => showToast("已打开文件夹"))
            .catch((err) => showToast("打开失败：" + (err?.message || err), true));
        },
      });
      if (!isDriveRoot) {
        rows.push({
          icon: CTX_ICONS.folder,
          label: "打开所在文件夹",
          action: () => {
            sendBridge({ kind: "reveal-path", path: info.path, fileUri: info.fileUri, openDirDirectly: false }, true, 8000)
              .then(() => showToast("已定位至所在文件夹"))
              .catch((err) => showToast("打开失败：" + (err?.message || err), true));
          },
        });
      }
    } else {
      rows.push({
        icon: CTX_ICONS.folder,
        label: "打开所在文件夹",
        action: () => {
          sendBridge({ kind: "reveal-path", path: info.path, fileUri: info.fileUri, openDirDirectly: false }, true, 8000)
            .then(() => showToast("已定位至所在文件夹"))
            .catch((err) => showToast("打开失败：" + (err?.message || err), true));
        },
      });
    }

    rows.push({ sep: true });
    rows.push({
      icon: CTX_ICONS.link,
      label: "复制路径",
      action: () => {
        navigator.clipboard?.writeText(info.path).then(
          () => showToast("已复制路径"),
          () => showToast(info.path)
        );
      },
    });

    menu.innerHTML = "";
    for (const r of rows) {
      if (r.sep) {
        const sep = document.createElement("div");
        sep.className = "azdrop-ctx-sep";
        menu.appendChild(sep);
        continue;
      }
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "azdrop-ctx-item";
      btn.innerHTML = r.icon + "<span>" + r.label + "</span>";
      btn.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        hideContextMenu();
        r.action();
      });
      menu.appendChild(btn);
    }

    menu.classList.remove("azdrop-hidden");
    menu.style.left = "0px";
    menu.style.top = "0px";
    const mw = menu.offsetWidth || 184;
    const mh = menu.offsetHeight || 150;
    const left = Math.max(8, Math.min(x, window.innerWidth - mw - 8));
    const top = Math.max(8, Math.min(y, window.innerHeight - mh - 8));
    menu.style.left = left + "px";
    menu.style.top = top + "px";
  }

  function onContextMenu(e) {
    if (!cfg.enabled || !cfg.breadcrumbContextMenu) return;
    const target = e.target;
    if (!target || !target.closest) return;
    const nav = target.closest('nav[aria-label="File path breadcrumbs"]');
    if (!nav) return;

    let seg = target.closest("[data-uri]");
    if (!seg || !nav.contains(seg)) {
      const allSegs = nav.querySelectorAll("[data-uri]");
      seg = allSegs.length ? allSegs[allSegs.length - 1] : null;
    }
    const uri = seg ? seg.getAttribute("data-uri") : "";
    if (!uri || !/^file:/i.test(uri)) return;

    e.preventDefault();
    e.stopImmediatePropagation();

    const localPath = fileUriToLocalPath(uri);
    const cx = e.clientX;
    const cy = e.clientY;
    (async () => {
      const [inspected] = await resolveItemsWithBridge([localPath]);
      const info = inspected || { path: localPath, fileUri: uri, isDirectory: false };
      showBreadcrumbContextMenu(cx, cy, info);
    })();
  }

  function onGlobalPointerDown(e) {
    const menu = document.getElementById("__azure-drop-ctxmenu");
    if (!menu || menu.classList.contains("azdrop-hidden")) return;
    if (e.target && menu.contains(e.target)) return;
    hideContextMenu();
  }

  function focusEditorSelection(editor) {
    editor.focus();
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !editor.contains(sel.anchorNode)) {
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
  }

  function makeTextNode(text) {
    return {
      detail: 0,
      format: 0,
      mode: "normal",
      style: "",
      text,
      type: "text",
      version: 1,
    };
  }

  function makeMentionNode(item) {
    const uri = item.fileUri || localPathToFileUri(item.path);
    const scopeItem = item.isDirectory
      ? { directory: { absoluteUri: uri } }
      : { file: { absoluteUri: uri } };
    return {
      trigger: "@",
      value: "contextScopeItemMention",
      data: { data: JSON.stringify(scopeItem) },
      type: "contextScopeItemMention",
      version: 1,
    };
  }

  /**
   * 写入 Lexical 编辑器：
   * - mention 模式：仅设置 application/x-lexical-editor，不附带 text/plain，彻底避免双插完整路径
   * - path 模式：单次 text/plain 合成粘贴
   */
  function insertItemsIntoEditor(items, preferTarget, forceMode = null) {
    const editor = findChatEditor(preferTarget);
    if (!editor || !Array.isArray(items) || !items.length) return false;
    attachEditorWatcher(editor);

    const mode = forceMode || cfg.insertMode || "mention";
    const plainList = items.map((it) => formatPath(it.path)).filter(Boolean);
    const plainText = plainList.join(plainList.length > 1 ? "\\n" : "");
    const finalPlain = cfg.trailingSpace && plainText && !/[\\s\\n]$/.test(plainText) ? plainText + " " : plainText;

    const ed = editor.__lexicalEditor;
    const hasMentionNode = Boolean(ed && ed._nodes && typeof ed._nodes.has === "function" && ed._nodes.has("contextScopeItemMention"));
    const ns = ed?._config?.namespace || "Input";

    try {
      focusEditorSelection(editor);
      isSyntheticPaste = true;
      try {
        const dt = new DataTransfer();
        const usedMention = mode === "mention" && hasMentionNode;
        if (usedMention) {
          const nodes = [];
          items.forEach((it, idx) => {
            nodes.push(makeMentionNode(it));
            if (cfg.appendPlainPath) {
              const formatted = formatPath(it.path);
              if (formatted) nodes.push(makeTextNode(" " + formatted));
            }
            if (idx < items.length - 1) nodes.push(makeTextNode(" "));
          });
          dt.setData("application/x-lexical-editor", JSON.stringify({ namespace: ns, nodes }));
        } else {
          dt.setData("text/plain", finalPlain);
        }
        const ev = new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData: dt,
        });
        editor.dispatchEvent(ev);
        // Lexical 会丢弃 application/x-lexical-editor 数组末尾的单独空格节点，需在落盘后通过 insertText 补齐一个空格
        if (usedMention && cfg.trailingSpace) {
          setTimeout(() => {
            try {
              if (!editor.isConnected) return;
              focusEditorSelection(editor);
              const okExec = typeof document.execCommand === "function" && document.execCommand("insertText", false, " ");
              if (!okExec) {
                isSyntheticPaste = true;
                try {
                  const dtSpace = new DataTransfer();
                  dtSpace.setData("text/plain", " ");
                  editor.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dtSpace }));
                } finally {
                  isSyntheticPaste = false;
                }
              }
            } catch {}
          }, 20);
        }
      } finally {
        isSyntheticPaste = false;
      }
      return true;
    } catch {
      isSyntheticPaste = false;
      return false;
    }
  }

  // 允许侧栏画廊直接经 CDP 回插到当前主窗口输入框（图片自动挂出上方缩略图）
  window.__azureDropInsertItem = function(item) {
    const normalized = typeof item === "string"
      ? { path: item, isDirectory: false, fileUri: localPathToFileUri(item) }
      : item;
    const editor = findChatEditor();
    const ok = insertItemsIntoEditor([normalized], editor);
    if (ok) {
      if (isImageItem(normalized)) addPreviewItems([normalized], editor);
      showToast(cfg.insertMode === "mention" ? "已回插原生标签到输入框" : "已回插路径到输入框");
    }
    return { ok };
  };

  async function resolveItemsWithBridge(rawPaths) {
    try {
      const res = await sendBridge({ kind: "inspect-paths", paths: rawPaths }, true, 5000);
      if (res && res.ok && Array.isArray(res.items) && res.items.length) {
        return res.items;
      }
    } catch {}
    return rawPaths.map((p) => ({
      path: p,
      isDirectory: false,
      fileUri: localPathToFileUri(p),
    }));
  }

  function isFromExternalFiles(dt) {
    if (!dt) return false;
    const types = Array.from(dt.types || []);
    return types.includes("Files");
  }

  function onDragEnter(e) {
    if (!cfg.enabled || !cfg.dragInsertPath) return;
    if (!isFromExternalFiles(e.dataTransfer)) return;
    dragDepth++;
    setDragHint(true, e.shiftKey);
  }

  function onDragOver(e) {
    if (!cfg.enabled || !cfg.dragInsertPath) return;
    if (!isFromExternalFiles(e.dataTransfer)) return;
    if (!e.shiftKey) {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    }
    setDragHint(true, e.shiftKey);
  }

  function onDragLeave() {
    if (dragDepth > 0) dragDepth--;
    if (dragDepth === 0) setDragHint(false);
  }

  function onDrop(e) {
    dragDepth = 0;
    setDragHint(false);
    if (!cfg.enabled || !cfg.dragInsertPath) return;
    if (e.shiftKey) return;
    const files = Array.from(e.dataTransfer?.files || []);
    if (!files.length) return;

    const rawPaths = files.map(resolveFilePath).filter(Boolean);
    if (!rawPaths.length) return;

    e.preventDefault();
    e.stopImmediatePropagation();

    const dropTarget = e.target;
    (async () => {
      const items = cfg.insertMode === "mention"
        ? await resolveItemsWithBridge(rawPaths)
        : rawPaths.map((p) => ({ path: p, isDirectory: false, fileUri: localPathToFileUri(p) }));
      const editor = findChatEditor(dropTarget);
      if (insertItemsIntoEditor(items, editor)) {
        const imgItems = items.filter(isImageItem);
        if (imgItems.length) addPreviewItems(imgItems, editor);
        sendBridge({ kind: "stat", pathInserts: items.length }, false);
        const label = cfg.insertMode === "mention" ? "原生标签" : "绝对路径";
        showToast(items.length > 1 ? ("已插入 " + items.length + " 个" + label) : ("已插入" + label));
      }
    })();
  }

  function readBlobAsDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(reader.error || new Error("读取剪贴板图片失败"));
      reader.readAsDataURL(blob);
    });
  }

  function onPaste(e) {
    if (isSyntheticPaste) return;
    if (!cfg.enabled) return;

    const editor = findChatEditor(e.target);
    if (!editor) return;
    const targetInEditor = e.target && editor.contains(e.target);
    const activeInEditor = document.activeElement && editor.contains(document.activeElement);
    if (!targetInEditor && !activeInEditor) return;

    const cd = e.clipboardData;
    if (!cd) return;

    const files = Array.from(cd.files || []);
    if (!files.length) return;

    // 情况 A：资源管理器 / QQ / 微信等复制的本地磁盘文件/文件夹
    const diskPaths = files.map(resolveFilePath).filter(Boolean);
    if (diskPaths.length > 0) {
      if (!cfg.pasteFilePath) return;
      if (e.shiftKey) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      (async () => {
        const items = cfg.insertMode === "mention"
          ? await resolveItemsWithBridge(diskPaths)
          : diskPaths.map((p) => ({ path: p, isDirectory: false, fileUri: localPathToFileUri(p) }));
        if (insertItemsIntoEditor(items, editor)) {
          const imgItems = items.filter(isImageItem);
          if (imgItems.length) addPreviewItems(imgItems, editor);
          sendBridge({ kind: "stat", pathInserts: items.length }, false);
          const label = cfg.insertMode === "mention" ? "原生标签" : "绝对路径";
          showToast(items.length > 1 ? ("已粘贴 " + items.length + " 个" + label) : ("已粘贴" + label));
        }
      })();
      return;
    }

    // 情况 B：纯内存截图（无磁盘路径，且为 image/*）→ 无损 PNG 落盘 + 插入原生标签 + 立即展示上方缩略图
    const memImages = files.filter((f) => String(f.type || "").startsWith("image/"));
    if (memImages.length > 0 && cfg.pasteLosslessImage) {
      e.preventDefault();
      e.stopImmediatePropagation();
      showToast("正在无损保存截图...");
      (async () => {
        try {
          const savedItems = [];
          let totalBytes = 0;
          for (const img of memImages) {
            const dataUrl = await readBlobAsDataUrl(img);
            const res = await sendBridge({
              kind: "save-image",
              mime: img.type || "image/png",
              dataBase64: dataUrl,
            }, true);
            if (!res || !res.ok || !res.filePath) {
              throw new Error(res?.error || "落盘失败");
            }
            savedItems.push({
              path: res.filePath,
              fileUri: res.fileUri,
              fileName: res.fileName,
              bytes: res.bytes,
              dataUrl: "",
              isDirectory: false,
            });
            totalBytes += Number(res.bytes || 0);
          }
          if (savedItems.length) {
            addPreviewItems(savedItems, editor);
            insertItemsIntoEditor(savedItems, editor);
            sendBridge({ kind: "stat", pathInserts: savedItems.length }, false);
            showToast("无损 PNG 已落盘 · " + formatKB(totalBytes));
          }
        } catch (err) {
          showToast("无损落盘失败：" + (err?.message || err), true);
        }
      })();
    }
  }

  function onVisibilityChange() {
    if (!document.hidden && needsWakeScan) {
      needsWakeScan = false;
      scheduleScanSentMessages();
    }
  }

  // 轻量兜底巡检：后台隐藏自动休眠；前台切换会话时自动重绑输入框、补扫已发消息图片
  syncTimer = setInterval(() => {
    if (document.hidden) {
      needsWakeScan = true;
      return;
    }
    try { scanSentMessages(); } catch {}
    const cur = findChatEditor();
    if (!cur) return;
    if (cur !== watchedEditor) {
      previewItems = [];
      closeLightbox();
      attachEditorWatcher(cur);
      renderPreviewStrip(cur);
      return;
    }
    if (previewItems.length) {
      const strip = document.getElementById("__azure-drop-preview-strip");
      if (!strip || !strip.isConnected) renderPreviewStrip(cur);
      syncPreviewsWithEditor(cur, null);
    }
  }, 1200);

  // 监听对话区域新增消息并自动渲染已发消息气泡上方的图片缩略图（后台隐藏时休眠）
  try {
    msgScanObserver = new MutationObserver((mutations) => {
      if (document.hidden) {
        needsWakeScan = true;
        return;
      }
      for (const m of mutations) {
        if (m.target && m.target.closest && m.target.closest("[data-azure-drop-ui]")) continue;
        if (m.addedNodes && m.addedNodes.length) {
          scheduleScanSentMessages();
          return;
        }
      }
    });
    if (document.body) {
      msgScanObserver.observe(document.body, { childList: true, subtree: true });
    }
  } catch {}
  scheduleScanSentMessages();

  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("dragenter", onDragEnter, true);
  window.addEventListener("dragover", onDragOver, true);
  window.addEventListener("dragleave", onDragLeave, true);
  window.addEventListener("drop", onDrop, true);
  document.addEventListener("paste", onPaste, true);
  document.addEventListener("contextmenu", onContextMenu, true);
  window.addEventListener("mousedown", onGlobalPointerDown, true);
  window.addEventListener("blur", hideContextMenu, true);
  window.addEventListener("mousemove", onGlobalMouseMove, true);
  window.addEventListener("mouseup", onGlobalMouseUp, true);
  window.addEventListener("keydown", onGlobalKeyDown, true);

  window.__azureDropInstance = {
    version: VERSION,
    getPreviewCount() { return previewItems.length; },
    scanSentMessages() { scanSentMessages(); return document.querySelectorAll(".azdrop-msg-thumb").length; },
    destroy() {
      if (syncTimer) { clearInterval(syncTimer); syncTimer = null; }
      clearTimeout(msgScanTimer);
      if (msgScanObserver) { try { msgScanObserver.disconnect(); } catch {} msgScanObserver = null; }
      if (typeof unregisterLexical === "function") {
        try { unregisterLexical(); } catch {}
        unregisterLexical = null;
      }
      watchedEditor = null;
      previewItems = [];
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("dragenter", onDragEnter, true);
      window.removeEventListener("dragover", onDragOver, true);
      window.removeEventListener("dragleave", onDragLeave, true);
      window.removeEventListener("drop", onDrop, true);
      document.removeEventListener("paste", onPaste, true);
      document.removeEventListener("contextmenu", onContextMenu, true);
      window.removeEventListener("mousedown", onGlobalPointerDown, true);
      window.removeEventListener("blur", hideContextMenu, true);
      window.removeEventListener("mousemove", onGlobalMouseMove, true);
      window.removeEventListener("mouseup", onGlobalMouseUp, true);
      window.removeEventListener("keydown", onGlobalKeyDown, true);
      setDragHint(false);
      document.getElementById("__azure-drop-preview-strip")?.remove();
      document.getElementById("__azure-drop-lightbox")?.remove();
      document.getElementById("__azure-drop-ctxmenu")?.remove();
      document.querySelectorAll(".azdrop-msg-thumbs").forEach((el) => el.remove());
      document.getElementById("__azure-drop-style")?.remove();
    },
  };

  return { ok: true, version: VERSION };
})();`;
}

/**
 * 苍蓝流笺（Azure Drop）— 配置持久化、路径解析、无损图片落盘与画廊管理
 * 零第三方依赖，纯 Node.js 原生 ESM 实现
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL, fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

export const DATA_DIR = path.join(os.homedir(), ".gemini", "azure-drop");
export const CONFIG_PATH = path.join(DATA_DIR, "config.json");
export const STATS_PATH = path.join(DATA_DIR, "stats.json");
export const DEFAULT_IMAGE_DIR = path.join(os.homedir(), ".gemini", "antigravity", "pasted-images");

export const MAX_IMAGE_BYTES = 50 * 1024 * 1024; // 50 MB 安全上限

export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  insertMode: "mention", // "mention" (原生青色标签 📁 文件夹/ / 文件名) | "path" (纯文本绝对路径)
  appendPlainPath: false, // 原生标签模式下是否在标签后附带完整纯文本路径（默认关闭，保持输入框清爽）
  showImagePreviewBar: true, // 粘贴/拖入图片时在输入框上方展示缩略图，点击可弹出无损高清大图灯箱
  breadcrumbContextMenu: true, // 顶栏文件路径面包屑右键菜单（打开所在文件夹 / 打开此文件夹 / 引用到输入框 / 复制路径）
  dragInsertPath: true,
  pasteFilePath: true,
  pasteLosslessImage: true,
  quotePathsWithSpaces: true,
  trailingSpace: true,
  pathSeparator: "auto", // "auto" | "posix" | "win32"
  imageDir: DEFAULT_IMAGE_DIR,
  autoCleanupDays: 14, // 0 = 关闭自动清理
  showPageToast: true,
  cdpPortOverride: 0, // 0 = 自动发现 DevToolsActivePort
});

const MIME_TO_EXT = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/bmp": ".bmp",
  "image/tiff": ".tiff",
  "image/avif": ".avif",
};

const EXT_TO_MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".tiff": "image/tiff",
  ".avif": "image/avif",
};

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function writeJsonAtomic(filePath, data) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, filePath);
}

export function expandUserPath(raw) {
  const s = String(raw || "").trim();
  if (!s) return DEFAULT_IMAGE_DIR;
  if (s === "~") return os.homedir();
  if (s.startsWith("~/") || s.startsWith("~\\")) {
    return path.join(os.homedir(), s.slice(2));
  }
  return path.resolve(s);
}

export function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return { ...DEFAULT_CONFIG };
    const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    return sanitizeConfig({ ...DEFAULT_CONFIG, ...parsed });
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function sanitizeConfig(raw = {}) {
  const mode = ["mention", "path"].includes(raw.insertMode) ? raw.insertMode : "mention";
  const sep = ["auto", "posix", "win32"].includes(raw.pathSeparator) ? raw.pathSeparator : "auto";
  const cleanupDays = Number.isFinite(Number(raw.autoCleanupDays))
    ? Math.max(0, Math.min(365, Math.round(Number(raw.autoCleanupDays))))
    : DEFAULT_CONFIG.autoCleanupDays;
  const cdpOverride = Number.isFinite(Number(raw.cdpPortOverride))
    ? Math.max(0, Math.min(65535, Math.round(Number(raw.cdpPortOverride))))
    : 0;
  const imgDir = expandUserPath(raw.imageDir || DEFAULT_IMAGE_DIR);
  return {
    enabled: raw.enabled !== false,
    insertMode: mode,
    appendPlainPath: raw.appendPlainPath === true,
    showImagePreviewBar: raw.showImagePreviewBar !== false,
    breadcrumbContextMenu: raw.breadcrumbContextMenu !== false,
    dragInsertPath: raw.dragInsertPath !== false,
    pasteFilePath: raw.pasteFilePath !== false,
    pasteLosslessImage: raw.pasteLosslessImage !== false,
    quotePathsWithSpaces: raw.quotePathsWithSpaces !== false,
    trailingSpace: raw.trailingSpace !== false,
    pathSeparator: sep,
    imageDir: imgDir,
    autoCleanupDays: cleanupDays,
    showPageToast: raw.showPageToast !== false,
    cdpPortOverride: cdpOverride,
  };
}

export function saveConfig(patch = {}) {
  const merged = sanitizeConfig({ ...loadConfig(), ...patch });
  writeJsonAtomic(CONFIG_PATH, merged);
  return merged;
}

export function loadStats() {
  const empty = { pathInsertCount: 0, imageSaveCount: 0, totalImageBytes: 0, lastEventAt: 0 };
  try {
    if (!fs.existsSync(STATS_PATH)) return empty;
    return { ...empty, ...JSON.parse(fs.readFileSync(STATS_PATH, "utf8")) };
  } catch {
    return empty;
  }
}

export function recordStat({ pathInserts = 0, imageSaves = 0, imageBytes = 0 } = {}) {
  const cur = loadStats();
  cur.pathInsertCount += Number(pathInserts) || 0;
  cur.imageSaveCount += Number(imageSaves) || 0;
  cur.totalImageBytes += Number(imageBytes) || 0;
  cur.lastEventAt = Date.now();
  try {
    writeJsonAtomic(STATS_PATH, cur);
  } catch {}
  return cur;
}

/**
 * 精确识别本机路径是文件还是文件夹，并生成合规 file:/// URI（用于 Antigravity 原生青色标签）
 */
export function inspectLocalPaths(rawPaths = []) {
  const results = [];
  for (const raw of Array.isArray(rawPaths) ? rawPaths : []) {
    const p = String(raw || "").trim();
    if (!p) continue;
    let resolved = p;
    let isDirectory = false;
    let exists = false;
    try {
      resolved = path.resolve(p);
      const st = fs.statSync(resolved);
      exists = true;
      isDirectory = st.isDirectory();
    } catch {}
    let fileUri = "";
    try {
      fileUri = pathToFileURL(resolved).href;
    } catch {}
    results.push({
      path: resolved,
      basename: path.basename(resolved) || resolved,
      isDirectory,
      exists,
      fileUri,
    });
  }
  return results;
}

function detectExtFromMagic(buf, fallbackMime = "image/png") {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return ".png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return ".jpg";
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return ".webp";
  if (buf.length >= 6 && (buf.toString("ascii", 0, 6) === "GIF89a" || buf.toString("ascii", 0, 6) === "GIF87a")) return ".gif";
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) return ".bmp";
  return MIME_TO_EXT[String(fallbackMime || "").toLowerCase()] || ".png";
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function formatStamp(d = new Date()) {
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

const lastAutoCleanupState = { at: 0 };
const PROCESS_PREVIEW_NONCE = crypto.randomBytes(8).toString("hex");
const MAX_PREVIEW_TICKETS = 400;
const MAX_INLINE_FALLBACK_BYTES = 2 * 1024 * 1024;
const previewTickets = new Map();

/**
 * 为本地白名单图片注册轻量流式预览票据（零内存拷贝，不把原图转为巨型 Base64 字符串）
 */
export function registerLocalImagePreview(rawPath) {
  const p = String(rawPath || "").trim();
  if (!p) throw new Error("缺少图片路径");
  const resolved = path.resolve(p);
  const ext = path.extname(resolved).toLowerCase();
  const mime = EXT_TO_MIME[ext];
  if (!mime) throw new Error("仅支持常见图片格式预览");
  if (!fs.existsSync(resolved)) throw new Error("图片文件不存在");
  const st = fs.statSync(resolved);
  if (!st.isFile()) throw new Error("目标不是图片文件");
  if (st.size > MAX_IMAGE_BYTES) {
    throw new Error(`图片体积过大 (${(st.size / 1024 / 1024).toFixed(1)} MB)`);
  }
  const ticketId = crypto
    .createHash("sha256")
    .update(`${resolved}|${Math.round(st.mtimeMs)}|${st.size}|${PROCESS_PREVIEW_NONCE}`)
    .digest("hex")
    .slice(0, 24);
  if (!previewTickets.has(ticketId) && previewTickets.size >= MAX_PREVIEW_TICKETS) {
    const oldestKey = previewTickets.keys().next().value;
    if (oldestKey) previewTickets.delete(oldestKey);
  }
  previewTickets.set(ticketId, {
    fullPath: resolved,
    fileName: path.basename(resolved),
    mime,
    bytes: st.size,
  });
  return {
    ok: true,
    ticketId,
    fileName: path.basename(resolved),
    filePath: resolved,
    fileUri: pathToFileURL(resolved).href,
    mime,
    bytes: st.size,
  };
}

export function resolvePreviewTicket(ticketId) {
  const id = String(ticketId || "").trim();
  if (!/^[0-9a-f]{24}$/.test(id)) return null;
  const entry = previewTickets.get(id);
  if (!entry) return null;
  try {
    if (!fs.existsSync(entry.fullPath)) {
      previewTickets.delete(id);
      return null;
    }
    const st = fs.statSync(entry.fullPath);
    if (!st.isFile()) return null;
    return { ...entry, bytes: st.size };
  } catch {
    return null;
  }
}

let lastAutoCleanupAt = 0;

/**
 * 无损保存剪贴板原始图片字节（PNG 原样直写，零压缩）
 */
export function saveLosslessImage({ dataBase64, mime = "image/png" } = {}) {
  const cfg = loadConfig();
  const cleanB64 = String(dataBase64 || "").replace(/^data:[^;]+;base64,/, "").trim();
  if (!cleanB64) throw new Error("图片数据为空");

  const buf = Buffer.from(cleanB64, "base64");
  if (!buf.length) throw new Error("无法解码图片字节");
  if (buf.length > MAX_IMAGE_BYTES) {
    throw new Error(`图片体积超限 (${(buf.length / 1024 / 1024).toFixed(1)} MB > 50 MB)`);
  }

  const ext = detectExtFromMagic(buf, mime);
  const dir = expandUserPath(cfg.imageDir);
  ensureDir(dir);

  const rand = crypto.randomBytes(2).toString("hex");
  const fileName = `drop-${formatStamp()}-${rand}${ext}`;
  const fullPath = path.join(dir, fileName);
  const tmpPath = `${fullPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, buf);
  fs.renameSync(tmpPath, fullPath);

  recordStat({ imageSaves: 1, imageBytes: buf.length });

  if (cfg.autoCleanupDays > 0 && Date.now() - lastAutoCleanupAt > 3600_000) {
    lastAutoCleanupAt = Date.now();
    try {
      cleanupOldImages(cfg.autoCleanupDays);
    } catch {}
  }

  return {
    ok: true,
    fileName,
    filePath: fullPath,
    fileUri: pathToFileURL(fullPath).href,
    isDirectory: false,
    bytes: buf.length,
    ext,
    createdAt: Date.now(),
  };
}

export function listSavedImages(limit = 60) {
  const cfg = loadConfig();
  const dir = expandUserPath(cfg.imageDir);
  if (!fs.existsSync(dir)) return { dir, total: 0, totalBytes: 0, items: [] };

  const items = [];
  let totalBytes = 0;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!ent.isFile()) continue;
    const ext = path.extname(ent.name).toLowerCase();
    if (!EXT_TO_MIME[ext]) continue;
    const fp = path.join(dir, ent.name);
    try {
      const st = fs.statSync(fp);
      totalBytes += st.size;
      items.push({
        fileName: ent.name,
        filePath: fp,
        fileUri: pathToFileURL(fp).href,
        bytes: st.size,
        ext,
        mime: EXT_TO_MIME[ext],
        mtimeMs: Math.round(st.mtimeMs),
      });
    } catch {}
  }

  items.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return {
    dir,
    total: items.length,
    totalBytes,
    items: items.slice(0, Math.max(1, Math.min(200, Number(limit) || 60))),
  };
}

export function resolveSafeImagePath(fileName) {
  const safe = path.basename(String(fileName || ""));
  if (!safe || safe !== fileName || safe.includes("..")) {
    throw new Error("非法文件名");
  }
  const cfg = loadConfig();
  const dir = expandUserPath(cfg.imageDir);
  const full = path.resolve(dir, safe);
  const dirNorm = path.resolve(dir) + path.sep;
  if (!full.startsWith(dirNorm)) throw new Error("路径越界");
  return { full, ext: path.extname(safe).toLowerCase(), mime: EXT_TO_MIME[path.extname(safe).toLowerCase()] || "application/octet-stream" };
}

export function deleteSavedImage(fileName) {
  const { full } = resolveSafeImagePath(fileName);
  if (!fs.existsSync(full)) return { deleted: false };
  fs.unlinkSync(full);
  return { deleted: true, fileName };
}

export function cleanupOldImages(days) {
  const cfg = loadConfig();
  const d = Number(days ?? cfg.autoCleanupDays);
  if (!Number.isFinite(d) || d <= 0) return { removed: 0, freedBytes: 0 };
  const dir = expandUserPath(cfg.imageDir);
  if (!fs.existsSync(dir)) return { removed: 0, freedBytes: 0 };

  const cutoff = Date.now() - d * 86400_000;
  let removed = 0;
  let freedBytes = 0;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!ent.isFile()) continue;
    const ext = path.extname(ent.name).toLowerCase();
    if (!EXT_TO_MIME[ext]) continue;
    const fp = path.join(dir, ent.name);
    try {
      const st = fs.statSync(fp);
      if (st.mtimeMs < cutoff) {
        fs.unlinkSync(fp);
        removed++;
        freedBytes += st.size;
      }
    } catch {}
  }
  return { removed, freedBytes };
}

export function formatPathForInsert(rawPath, cfg = loadConfig()) {
  let p = String(rawPath || "").trim();
  if (!p) return "";
  if (cfg.pathSeparator === "posix") p = p.replace(/\\/g, "/");
  else if (cfg.pathSeparator === "win32") p = p.replace(/\//g, "\\");
  if (cfg.quotePathsWithSpaces && /\s/.test(p) && !(/^["'].*["']$/.test(p))) {
    p = `"${p}"`;
  }
  return p;
}

export function openDirectoryInExplorer(targetDir) {
  const dir = expandUserPath(targetDir || loadConfig().imageDir);
  ensureDir(dir);
  if (process.platform === "win32") {
    spawn("explorer.exe", [dir], { detached: true, stdio: "ignore" }).unref();
  } else if (process.platform === "darwin") {
    spawn("open", [dir], { detached: true, stdio: "ignore" }).unref();
  } else {
    spawn("xdg-open", [dir], { detached: true, stdio: "ignore" }).unref();
  }
  return { ok: true, dir };
}

/**
 * 读取本地白名单图片文件为 Data URL，供主窗口输入框上方缩略图与无损灯箱高清展示
 */
export function readLocalImagePreview(rawPath) {
  const p = String(rawPath || "").trim();
  if (!p) throw new Error("缺少图片路径");
  const resolved = path.resolve(p);
  const ext = path.extname(resolved).toLowerCase();
  const mime = EXT_TO_MIME[ext];
  if (!mime) throw new Error("仅支持常见图片格式预览");
  if (!fs.existsSync(resolved)) throw new Error("图片文件不存在");
  const st = fs.statSync(resolved);
  if (!st.isFile()) throw new Error("目标不是图片文件");
  if (st.size > MAX_INLINE_FALLBACK_BYTES) {
    throw new Error(`图片体积较大 (${(st.size / 1024 / 1024).toFixed(1)} MB)，已限制内联 Base64 预览`);
  }
  const buf = fs.readFileSync(resolved);
  return {
    ok: true,
    fileName: path.basename(resolved),
    filePath: resolved,
    fileUri: pathToFileURL(resolved).href,
    mime,
    bytes: buf.length,
    dataUrl: `data:${mime};base64,${buf.toString("base64")}`,
  };
}

/**
 * 使用系统默认看图器打开白名单图片文件
 */
export function openImageInSystem(rawPath) {
  const p = String(rawPath || "").trim();
  if (!p) throw new Error("缺少图片路径");
  const resolved = path.resolve(p);
  const ext = path.extname(resolved).toLowerCase();
  if (!EXT_TO_MIME[ext]) throw new Error("仅允许打开白名单图片文件");
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new Error("图片文件不存在");
  }
  if (process.platform === "win32") {
    spawn("cmd.exe", ["/c", "start", "", resolved], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  } else if (process.platform === "darwin") {
    spawn("open", [resolved], { detached: true, stdio: "ignore" }).unref();
  } else {
    spawn("xdg-open", [resolved], { detached: true, stdio: "ignore" }).unref();
  }
  return { ok: true, filePath: resolved };
}

/**
 * 在系统文件管理器中打开文件夹或定位选中指定文件/文件夹
 * - openDirDirectly = true：当目标为目录时直接进入该目录
 * - openDirDirectly = false（默认）：打开其所在文件夹并高亮选中该目标
 */
export function revealInFileManager(rawPathOrUri, { openDirDirectly = false } = {}) {
  let raw = String(rawPathOrUri || "").trim();
  if (!raw) throw new Error("缺少路径");
  if (/^file:/i.test(raw)) {
    raw = fileURLToPath(raw);
  }
  let resolved = path.resolve(raw);

  // 若目标已不存在，自动向上回退至最近存在的父目录
  if (!fs.existsSync(resolved)) {
    let cur = path.dirname(resolved);
    while (cur && cur !== path.dirname(cur) && !fs.existsSync(cur)) {
      cur = path.dirname(cur);
    }
    if (!cur || !fs.existsSync(cur)) throw new Error("路径不存在");
    resolved = cur;
    openDirDirectly = true;
  }

  const st = fs.statSync(resolved);
  const isDir = st.isDirectory();
  const isRoot = path.dirname(resolved) === resolved;

  if (process.platform === "win32") {
    if ((isDir && openDirDirectly) || isRoot) {
      spawn("explorer.exe", [resolved], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("explorer.exe", [`/select,"${resolved}"`], {
        detached: true,
        stdio: "ignore",
        windowsVerbatimArguments: true,
      }).unref();
    }
  } else if (process.platform === "darwin") {
    if ((isDir && openDirDirectly) || isRoot) {
      spawn("open", [resolved], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("open", ["-R", resolved], { detached: true, stdio: "ignore" }).unref();
    }
  } else {
    const targetDir = isDir && openDirDirectly ? resolved : path.dirname(resolved);
    spawn("xdg-open", [targetDir], { detached: true, stdio: "ignore" }).unref();
  }
  return { ok: true, path: resolved, isDirectory: isDir, openDirDirectly: Boolean((isDir && openDirDirectly) || isRoot) };
}

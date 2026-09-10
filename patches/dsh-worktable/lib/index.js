// src/index.ts
import { execFile } from "node:child_process";
import { readdirSync, realpathSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve as pathResolve, sep } from "node:path";
import { createRequire } from "node:module";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

// template/dshell.css
var dshell_default = `/* dsh-worktable \u539F\u751F\u76AE\u80A4 \xB7 DSH \u8BBE\u8BA1\u7CFB\u7EDF\u7EC4\u4EF6\u5E93
   \u7528\u6CD5\uFF1A<link rel="stylesheet" href="/api/worktable/template/dshell.css">
   \u6240\u6709\u989C\u8272\u8D70 DSH \u4E3B\u9898\u53D8\u91CF\uFF08--dsw-alias-*\uFF09\uFF0C\u81EA\u52A8\u9002\u914D\u660E\u6697\u4E3B\u9898\u3002 */
:root { color-scheme: dark; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  background: var(--dsw-alias-bg-base, #0b0e14);
  color: var(--dsw-alias-label-primary, #e6e8eb);
  font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  font-size: 13px;
  line-height: 1.6;
}
.dshell { display: flex; flex-direction: column; gap: 12px; padding: 14px 16px; min-height: 100%; }
/* \u6587\u5B57\u5C42\u7EA7 */
.dshell-title { margin: 0; font-size: 16px; font-weight: 600; color: var(--dsw-alias-label-primary, #e6e8eb); }
.dshell-sub { margin: 0; font-size: 12px; color: var(--dsw-alias-label-secondary, #9aa4b2); }
.dshell-muted { color: var(--dsw-alias-label-tertiary, #6b7280); font-size: 11.5px; }
/* \u5361\u7247 */
.dshell-card { border: 1px solid var(--dsw-alias-border-l1, #262b36); border-radius: 10px; background: var(--dsw-alias-fill-l1, rgba(255,255,255,.02)); padding: 12px 14px; }
.dshell-card + .dshell-card { margin-top: 10px; }
/* \u6309\u94AE\uFF08\u7EFF\u8272\u4E3B\u6309\u94AE / \u5E7D\u7075\u6309\u94AE / \u5371\u9669\uFF09 */
.dshell-btn { display: inline-flex; align-items: center; gap: 6px; padding: 6px 14px; border-radius: 999px; border: 1px solid transparent; background: #3fb950; color: #0b0e14; font: inherit; font-size: 12.5px; font-weight: 600; cursor: pointer; }
.dshell-btn:hover { filter: brightness(1.08); }
.dshell-btnGhost { background: transparent; border-color: var(--dsw-alias-border-l1, #262b36); color: var(--dsw-alias-label-secondary, #9aa4b2); }
.dshell-btnGhost:hover { color: var(--dsw-alias-label-primary, #e6e8eb); border-color: var(--dsw-alias-border-l2, #3a4150); }
.dshell-btnDanger { background: transparent; border-color: #f85149; color: #f85149; }
/* \u72B6\u6001\u5FBD\u6807\uFF08\u5706\u70B9 + \u6587\u5B57\uFF1B\u7EFF=\u5DF2\u5B8C\u6210 \u9EC4=\u5F85\u529E/\u5F85\u53D1\u5E03 \u7070=\u672A\u5F00\u59CB\uFF09 */
.dshell-badge { display: inline-flex; align-items: center; gap: 6px; padding: 2px 10px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l1, #262b36); font-size: 11.5px; color: var(--dsw-alias-label-secondary, #9aa4b2); background: var(--dsw-alias-fill-l1, rgba(255,255,255,.03)); }
.dshell-badge::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-label-tertiary, #6b7280); }
.dshell-badgeDone { color: #3fb950; border-color: rgba(63,185,80,.4); }
.dshell-badgeDone::before { background: #3fb950; box-shadow: 0 0 5px #3fb950; }
.dshell-badgeWait { color: #d29922; border-color: rgba(210,153,34,.4); }
.dshell-badgeWait::before { background: #d29922; box-shadow: 0 0 5px #d29922; }
.dshell-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--dsw-alias-label-tertiary, #6b7280); }
.dshell-dotDone { background: #3fb950; box-shadow: 0 0 5px #3fb950; }
.dshell-dotWait { background: #d29922; box-shadow: 0 0 5px #d29922; }
/* \u6807\u7B7E\u9875 */
.dshell-tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--dsw-alias-border-l1, #262b36); }
.dshell-tab { padding: 7px 12px; font-size: 12.5px; color: var(--dsw-alias-label-secondary, #9aa4b2); cursor: pointer; border: none; background: none; font: inherit; border-bottom: 2px solid transparent; margin-bottom: -1px; }
.dshell-tabOn { color: var(--dsw-alias-label-primary, #e6e8eb); border-bottom-color: var(--dsw-alias-state-accent-primary, #4f8ef7); }
/* \u5217\u8868 */
.dshell-list { display: flex; flex-direction: column; gap: 6px; }
.dshell-listItem { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 8px 12px; border: 1px solid var(--dsw-alias-border-l1, #262b36); border-radius: 8px; background: var(--dsw-alias-fill-l1, rgba(255,255,255,.02)); cursor: pointer; }
.dshell-listItem:hover { border-color: var(--dsw-alias-border-l2, #3a4150); background: var(--dsw-alias-fill-l1, rgba(255,255,255,.05)); }
.dshell-listItemTitle { font-size: 12.5px; color: var(--dsw-alias-label-primary, #e6e8eb); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshell-listItemMeta { flex: none; font-size: 11px; color: var(--dsw-alias-label-tertiary, #6b7280); }
/* \u7F51\u683C / \u7EDF\u8BA1 */
.dshell-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; }
.dshell-stat { padding: 10px 12px; border: 1px solid var(--dsw-alias-border-l1, #262b36); border-radius: 10px; background: var(--dsw-alias-fill-l1, rgba(255,255,255,.02)); }
.dshell-statLabel { font-size: 11px; color: var(--dsw-alias-label-secondary, #9aa4b2); }
.dshell-statValue { font-size: 20px; font-weight: 600; color: var(--dsw-alias-label-primary, #e6e8eb); }
.dshell-statDelta { font-size: 11px; color: #3fb950; }
/* \u8FDB\u5EA6\u6761 */
.dshell-progress { height: 6px; border-radius: 3px; background: var(--dsw-alias-fill-l1, rgba(255,255,255,.06)); overflow: hidden; }
.dshell-progressBar { height: 100%; border-radius: 3px; background: #3fb950; }
/* \u8F93\u5165 */
.dshell-input, .dshell-textarea { width: 100%; padding: 7px 10px; border: 1px solid var(--dsw-alias-border-l1, #262b36); border-radius: 8px; background: var(--dsw-alias-fill-l1, rgba(255,255,255,.03)); color: var(--dsw-alias-label-primary, #e6e8eb); font: inherit; font-size: 12.5px; outline: none; }
.dshell-input:focus, .dshell-textarea:focus { border-color: var(--dsw-alias-state-accent-primary, #4f8ef7); }
/* \u8868\u683C */
.dshell-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.dshell-table th, .dshell-table td { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--dsw-alias-border-l1, #262b36); }
.dshell-table th { color: var(--dsw-alias-label-secondary, #9aa4b2); font-weight: 500; }
/* \u952E\u503C\u5BF9 */
.dshell-kv { display: flex; flex-direction: column; gap: 6px; }
.dshell-kvRow { display: flex; justify-content: space-between; gap: 10px; font-size: 12px; }
.dshell-kvKey { color: var(--dsw-alias-label-secondary, #9aa4b2); }
.dshell-kvValue { color: var(--dsw-alias-label-primary, #e6e8eb); text-align: right; }
/* \u5206\u5272\u7EBF */
.dshell-divider { height: 1px; background: var(--dsw-alias-border-l1, #262b36); margin: 6px 0; }
/* \u6EDA\u52A8\u6761 */
::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-thumb { background: rgba(255,255,255,.14); border-radius: 5px; }
::-webkit-scrollbar-track { background: transparent; }
`;

// template/dshell.html
var dshell_default2 = '<!doctype html>\n<!-- dsh-worktable \u539F\u751F\u76AE\u80A4\u6A21\u677F\uFF1A\u65B0\u9875\u9762\u4EE5\u6B64\u4E3A\u57FA\u7840\uFF0C\u66FF\u6362\u4E0B\u9762\u793A\u4F8B\u5185\u5BB9\u5373\u53EF\u3002\n     \u6837\u5F0F\u8868\u7531\u63D2\u4EF6\u63D0\u4F9B\uFF08\u968F\u4E3B\u9898\u81EA\u52A8\u9002\u914D\uFF09\uFF0C\u4E0D\u8981\u590D\u5236\u6216\u6539\u5199\u5B83\u3002 -->\n<html lang="zh-CN">\n<head>\n  <meta charset="utf-8" />\n  <meta name="viewport" content="width=device-width, initial-scale=1" />\n  <title>\u6211\u7684\u7A97\u53E3</title>\n  <link rel="stylesheet" href="/api/worktable/template/dshell.css" />\n</head>\n<body>\n  <div class="dshell">\n    <!-- \u6807\u9898\u533A -->\n    <h1 class="dshell-title">\u7A97\u53E3\u6807\u9898</h1>\n    <p class="dshell-sub">\u4E00\u53E5\u8BDD\u8BF4\u660E\u8FD9\u4E2A\u7A97\u53E3\u505A\u4EC0\u4E48\u3002</p>\n\n    <!-- \u72B6\u6001\u5FBD\u6807\uFF1A\u5DF2\u5B8C\u6210 dshell-badgeDone / \u8FDB\u884C\u4E2D dshell-badgeWait / \u9ED8\u8BA4 -->\n    <div>\n      <span class="dshell-badge dshell-badgeDone">\u5DF2\u5B8C\u6210</span>\n      <span class="dshell-badge dshell-badgeWait">\u8FDB\u884C\u4E2D</span>\n      <span class="dshell-badge">\u672A\u5F00\u59CB</span>\n    </div>\n\n    <!-- \u6807\u7B7E\u9875 -->\n    <div class="dshell-tabs">\n      <button class="dshell-tab dshell-tabOn">\u6982\u89C8</button>\n      <button class="dshell-tab">\u8BE6\u60C5</button>\n      <button class="dshell-tab">\u8BBE\u7F6E</button>\n    </div>\n\n    <!-- \u7EDF\u8BA1\u5361\u7247\u7F51\u683C -->\n    <div class="dshell-grid">\n      <div class="dshell-stat">\n        <div class="dshell-statLabel">\u603B\u6570</div>\n        <div class="dshell-statValue">128</div>\n        <div class="dshell-statDelta">+12.4%</div>\n      </div>\n      <div class="dshell-stat">\n        <div class="dshell-statLabel">\u8FDB\u884C\u4E2D</div>\n        <div class="dshell-statValue">7</div>\n      </div>\n      <div class="dshell-stat">\n        <div class="dshell-statLabel">\u5DF2\u5B8C\u6210</div>\n        <div class="dshell-statValue">121</div>\n      </div>\n    </div>\n\n    <!-- \u5217\u8868 -->\n    <div class="dshell-list">\n      <div class="dshell-listItem">\n        <span class="dshell-listItemTitle">\u6761\u76EE\u4E00\uFF1A\u793A\u4F8B\u5185\u5BB9\u6807\u9898</span>\n        <span class="dshell-listItemMeta">\u6628\u5929</span>\n      </div>\n      <div class="dshell-listItem">\n        <span class="dshell-listItemTitle">\u6761\u76EE\u4E8C\uFF1A\u793A\u4F8B\u5185\u5BB9\u6807\u9898</span>\n        <span class="dshell-badge dshell-badgeDone">\u5DF2\u53D1\u5E03</span>\n      </div>\n    </div>\n\n    <!-- \u5361\u7247 + \u952E\u503C\u5BF9 -->\n    <div class="dshell-card">\n      <h2 class="dshell-sub" style="margin:0 0 8px">\u8BE6\u60C5</h2>\n      <div class="dshell-kv">\n        <div class="dshell-kvRow"><span class="dshell-kvKey">\u5B57\u6BB5 A</span><span class="dshell-kvValue">\u503C A</span></div>\n        <div class="dshell-kvRow"><span class="dshell-kvKey">\u5B57\u6BB5 B</span><span class="dshell-kvValue">\u503C B</span></div>\n      </div>\n      <div class="dshell-divider"></div>\n      <div class="dshell-progress"><div class="dshell-progressBar" style="width:72%"></div></div>\n    </div>\n\n    <!-- \u64CD\u4F5C\u533A -->\n    <div style="display:flex;gap:8px">\n      <button class="dshell-btn">\u4E3B\u8981\u64CD\u4F5C</button>\n      <button class="dshell-btn dshell-btnGhost">\u6B21\u8981\u64CD\u4F5C</button>\n    </div>\n  </div>\n</body>\n</html>\n';

// src/index.ts
var PLUGIN_VERSION = false ? "dev" : "0.2.3";
var name = "dsh-worktable";
var inject = ["webServer", "sessions"];
var HEALTH_PATH = "/api/worktable/health";
var MAX_ENTRIES = 500;
var FILE_TYPES = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  map: "application/json; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  markdown: "text/markdown; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  log: "text/plain; charset=utf-8",
  pdf: "application/pdf",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  wasm: "application/wasm",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  webm: "video/webm"
};
var SITE_PREFIX = "/api/worktable/site";
var TEMPLATE_PREFIX = "/api/worktable/template";
function loadPkg(pkg) {
  const starts = /* @__PURE__ */ new Set();
  try {
    starts.add(dirname(fileURLToPath(import.meta.url)));
  } catch {
  }
  try {
    starts.add(realpathSync(dirname(fileURLToPath(import.meta.url))));
  } catch {
  }
  for (const start of starts) {
    let dir = start;
    while (dir && dir !== pathResolve(dir, "..")) {
      try {
        const req = createRequire(pathToFileURL(pathResolve(dir, "__wt_probe__.js")).href);
        return req(pkg);
      } catch {
      }
      dir = pathResolve(dir, "..");
    }
  }
  try {
    const profilesDir = pathResolve(homedir(), ".dsh", "profiles");
    for (const profile of readdirSync(profilesDir, { withFileTypes: true })) {
      if (!profile.isDirectory() && !profile.isSymbolicLink()) continue;
      const nm = pathResolve(profilesDir, profile.name, "node_modules");
      try {
        const req = createRequire(pathToFileURL(pathResolve(nm, "__wt_probe__.js")).href);
        return req(pkg);
      } catch {
      }
    }
  } catch {
  }
  return null;
}
function serverCwd(ctx, sessionId, clientCwd) {
  if (sessionId) {
    try {
      const headerCwd = ctx.sessions?.get?.(sessionId)?.header?.cwd;
      if (typeof headerCwd === "string" && headerCwd) return headerCwd;
    } catch {
    }
  }
  if (typeof clientCwd === "string" && clientCwd) return clientCwd;
  return process.cwd();
}
function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}
async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}
async function listDirectory(path) {
  const abs = pathResolve(path);
  const dirents = await readdir(abs, { withFileTypes: true });
  const entries = dirents.map((d) => ({ name: d.name, path: abs + sep + d.name, isDir: d.isDirectory(), hidden: d.name.startsWith(".") })).sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name, void 0, { sensitivity: "base" });
  });
  const truncated = entries.length > MAX_ENTRIES;
  return { path: abs, entries: truncated ? entries.slice(0, MAX_ENTRIES) : entries, truncated };
}
function gitExec(args, cwd) {
  return new Promise((resolvePromise, reject) => {
    execFile("git", args, { cwd, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolvePromise(stdout);
    });
  });
}
async function gitStatus(cwd) {
  try {
    const branchRaw = await gitExec(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
    const porcelain = await gitExec(["status", "--porcelain=v1", "-z"], cwd);
    const entries = porcelain.split("\0").filter((s) => s.length > 2).map((s) => ({ xy: s.slice(0, 2), path: s.slice(3) }));
    return { isRepo: true, branch: branchRaw.trim() || "HEAD", entries };
  } catch {
    return { isRepo: false, branch: void 0, entries: [] };
  }
}
// ==================== 访问鉴权（本地安全补丁：对齐 mobile-server PIN 机制） ====================
// 背景：/api/worktable/* 全家（file/site/fs/workspaces/write/mkdir/git/term）原本完全无鉴权，
// 本机任意网页可跨源读任意文件、写任意文件、经 term WebSocket 直接拿交互式 shell（RCE）。
// 本补丁为全部敏感端点加 PIN 门禁：scrypt pinHash + 会话 Cookie（HttpOnly SameSite=Strict）+
// X-TT-Pin 头兼容 + auth 查询参数（供 WS 脚本）+ 密码失败限速；未配置密码时首次登录即设置。
// 配置：~/.dsh/storages/worktable-auth.json（环境变量 DSH_WORKTABLE_AUTH_FILE 可覆盖路径）。
// 升级覆盖后重放：copy 本文件回 node_modules/dsh-worktable/lib/index.js（见 patches/README.md）。
var COOKIE_NAME = "tt_wt_v2";
var SESSION_MAX = 20;
var SESSION_TTL = 30 * 24 * 3600e3;
function authFilePath() {
  return process.env.DSH_WORKTABLE_AUTH_FILE || pathResolve(homedir(), ".dsh", "storages", "worktable-auth.json");
}
var authState = { loaded: false, data: null };
async function loadAuth(force) {
  if (authState.loaded && !force) return authState.data;
  try {
    const raw = await readFile(authFilePath(), "utf8");
    authState.data = JSON.parse(raw.charCodeAt(0) === 65279 ? raw.slice(1) : raw);
  } catch {
    authState.data = {};
  }
  authState.loaded = true;
  return authState.data;
}
async function saveAuth(data) {
  authState.data = data;
  authState.loaded = true;
  const fsx = await import("node:fs/promises");
  const file = authFilePath();
  try {
    await fsx.mkdir(dirname(file), { recursive: true });
  } catch {}
  await fsx.writeFile(file, JSON.stringify(data), "utf8");
}
function hashPin(pin) {
  const salt = randomBytes(16).toString("hex");
  return { salt, hash: scryptSync(String(pin), salt, 32, { N: 16384 }).toString("hex") };
}
function verifyPin(given, data) {
  if (!data?.pinHash?.salt || !data?.pinHash?.hash) return false;
  try {
    const calc = scryptSync(String(given), data.pinHash.salt, 32, { N: 16384 });
    return timingSafeEqual(calc, Buffer.from(data.pinHash.hash, "hex"));
  } catch {
    return false;
  }
}
function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0) out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}
function pruneSessions(data) {
  const now = Date.now();
  data.sessions = (data.sessions ?? []).filter((s) => now - s.lastSeen < SESSION_TTL);
}
async function issueSession(data) {
  const token = randomBytes(24).toString("hex");
  data.sessions = data.sessions ?? [];
  pruneSessions(data);
  data.sessions.push({ token, lastSeen: Date.now() });
  while (data.sessions.length > SESSION_MAX) data.sessions.shift();
  await saveAuth(data);
  return token;
}
var RATE = { hits: /* @__PURE__ */ new Map() };
function rateState(ip) {
  const now = Date.now();
  let b = RATE.hits.get(ip);
  if (!b || now - b.win > 60000) {
    b = { win: now, count: 0, lockUntil: 0 };
    RATE.hits.set(ip, b);
  }
  return b;
}
function rateFail(ip) {
  const b = rateState(ip);
  b.count += 1;
  if (b.count >= 5) b.lockUntil = Date.now() + 600000;
}
function rateLocked(ip) {
  return Math.max(0, rateState(ip).lockUntil - Date.now());
}
function clientIp(req) {
  return req.socket?.remoteAddress || "unknown";
}
function hasSession(data, token) {
  if (!token) return false;
  const now = Date.now();
  const hit = (data.sessions ?? []).find((s) => s.token === token);
  if (!hit) return false;
  if (now - hit.lastSeen >= SESSION_TTL) return false;
  hit.lastSeen = now; // 滚动续期（内存态，不逐次写盘）
  return true;
}
async function authGate(req, urlObj) {
  const data = await loadAuth();
  if (!data.pinHash) return { status: 501, error: "worktable auth not configured (first login sets the pin)" };
  const cookies = parseCookies(req.headers?.cookie);
  if (hasSession(data, cookies[COOKIE_NAME])) return null;
  const urlToken = urlObj.searchParams.get("auth") || "";
  if (urlToken && hasSession(data, urlToken)) return null;
  const ip = clientIp(req);
  const locked = rateLocked(ip);
  if (locked > 0) return { status: 429, error: `密码错误次数过多，锁定 ${Math.ceil(locked / 1000)} 秒` };
  const header = String(req.headers?.["x-tt-pin"] ?? "");
  if (header) {
    if (verifyPin(header, data)) return null;
    rateFail(ip);
    return { status: 401, error: "pin required" };
  }
  return { status: 401, error: "pin required" };
}
var LOGIN_PAGE = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>worktable 访问密码</title><style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0b0e14;color:#e6e8eb;font:14px/1.7 system-ui,sans-serif}main{max-width:380px;padding:28px;background:#12161e;border:1px solid #262b36;border-radius:14px;text-align:center}input{width:100%;padding:10px;border-radius:8px;border:1px solid #262b36;background:rgba(255,255,255,.05);color:inherit;font:inherit;outline:none;box-sizing:border-box}button{margin-top:10px;width:100%;padding:10px;border:none;border-radius:8px;background:#3fb950;color:#07130a;font-weight:600;cursor:pointer}p{font-size:12px;color:#9aa4b2}#m{min-height:18px;font-size:12px;color:#f85149}</style></head><body><main><h2>worktable 访问密码</h2><p>本机工作台接口受安全密码保护（与课表服务 PIN 机制同源）</p><input id="p" type="password" placeholder="安全密码" autofocus><button id="b">进入</button><div id="m"></div></main><script>var i=document.getElementById("p"),b=document.getElementById("b"),m=document.getElementById("m");function go(){fetch("/api/worktable/login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({pin:i.value})}).then(function(r){return r.json()}).then(function(j){if(j.ok){location.reload()}else{m.textContent=j.error||"密码错误"}}).catch(function(e){m.textContent=String(e)})}b.onclick=go;i.addEventListener("keydown",function(e){if(e.key==="Enter")go()});<\/script></body></html>';
function deny(req, res, gate) {
  const wantsHtml = req.method === "GET" && String(req.headers?.accept ?? "").includes("text/html");
  if (wantsHtml) {
    res.writeHead(gate.status === 429 ? 429 : 401, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(LOGIN_PAGE);
    return;
  }
  json(res, gate.status === 429 ? 429 : 401, { ok: false, error: gate.error });
}
async function gateReq(req, res) {
  const gate = await authGate(req, new URL(req.url ?? "/", "http://dsh.internal"));
  if (gate) {
    deny(req, res, gate);
    return true;
  }
  return false;
}
function setupTerminal(webServer, ctx) {
  if (typeof webServer.registerUpgrade !== "function") return;
  const wsMod = loadPkg("ws");
  const ptyMod = loadPkg("node-pty");
  ctx.logger?.info?.("[dsh-worktable] term deps: ws=" + (wsMod ? "ok" : "MISSING") + " node-pty=" + (ptyMod ? "ok" : "MISSING"));
  if (!wsMod || !ptyMod) {
    ctx.logger?.warn("[dsh-worktable] \u7EC8\u7AEF\u8DEF\u7531\u672A\u6CE8\u518C\uFF1Aws/node-pty \u4E0D\u53EF\u7528");
    return;
  }
  const WebSocketServer = wsMod.WebSocketServer ?? wsMod.default?.WebSocketServer;
  if (!WebSocketServer) return;
  const pty = ptyMod.default ?? ptyMod;
  const wss = new WebSocketServer({ noServer: true });
  const spawnShell = () => process.platform === "win32" ? { cmd: "powershell.exe", args: ["-NoLogo", "-NoProfile"] } : { cmd: process.env.SHELL || "/bin/bash", args: [] };
  const clampDim = (v, fallback) => Math.min(1024, Math.max(2, Number.isFinite(v) ? v : fallback));
  ctx.effect(() => webServer.registerUpgrade({
    path: "/api/worktable/term",
    handler: (req, socket, head) => {
      const uGate = new URL(req.url ?? "/", "http://dsh.internal");
      authGate(req, uGate).then((gate) => {
        if (gate) {
          // WS 握手拒绝：无升级意义，直接回 401 并断开（evil.com 无凭据拿不到 shell）
          try {
            socket.write("HTTP/1.1 401 Unauthorized\r\ncontent-type: text/plain; charset=utf-8\r\nconnection: close\r\n\r\nworktable: " + gate.error + "\n");
          } catch {}
          try {
            socket.destroy();
          } catch {}
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
        const u = new URL(req.url ?? "/", "http://dsh.internal");
        const cwd = serverCwd(ctx, u.searchParams.get("sessionId") || void 0, u.searchParams.get("cwd") || void 0);
        const cols = clampDim(Number(u.searchParams.get("cols")), 80);
        const rows = clampDim(Number(u.searchParams.get("rows")), 24);
        let term = null;
        try {
          const shell = spawnShell();
          term = pty.spawn(shell.cmd, shell.args, { name: "xterm-256color", cols, rows, cwd, env: process.env });
        } catch (err) {
          try {
            ws.send("\r\n[worktable] \u7EC8\u7AEF\u542F\u52A8\u5931\u8D25\uFF1A" + String(err));
          } catch {
          }
          try {
            ws.close();
          } catch {
          }
          return;
        }
        term.onData((d) => {
          try {
            ws.send(d);
          } catch {
          }
        });
        term.onExit(() => {
          try {
            ws.close();
          } catch {
          }
        });
        ws.on("message", (raw) => {
          const text = String(raw);
          try {
            const msg = JSON.parse(text);
            if (msg && msg.type === "resize" && Number.isFinite(msg.cols) && Number.isFinite(msg.rows)) {
              term.resize(clampDim(msg.cols, cols), clampDim(msg.rows, rows));
              return;
            }
          } catch {
          }
          try {
            term.write(text);
          } catch {
          }
        });
        ws.on("close", () => {
          try {
            term.kill();
          } catch {
          }
        });
        });
      }).catch(() => {
        try {
          socket.destroy();
        } catch {}
      });
    }
  }), "dsh-worktable: terminal upgrade");
}
function apply(ctx) {
  const webServer = ctx.webServer;
  if (!webServer) {
    ctx.logger?.warn("[dsh-worktable] ctx.webServer \u4E0D\u53EF\u7528\uFF08headless profile\uFF1F\uFF09\uFF0C\u8DF3\u8FC7\u670D\u52A1\u7AEF\u8DEF\u7531");
    return;
  }
  webServer.register({
    kind: "exact",
    path: HEALTH_PATH,
    handler: (_req, res) => {
      json(res, 200, { plugin: "dsh-worktable", version: PLUGIN_VERSION, ok: true });
    }
  });
  webServer.register({
    kind: "exact",
    path: "/api/worktable/login",
    handler: async (req, res) => {
      try {
        if (req.method !== "POST") {
          res.writeHead(405);
          res.end();
          return;
        }
        const body = await readJsonBody(req);
        const pin = String(body.pin ?? "");
        if (!pin) {
          json(res, 400, { ok: false, error: "missing pin" });
          return;
        }
        const data = await loadAuth();
        if (!data.pinHash) {
          data.pinHash = hashPin(pin); // 首次登录即设置密码（与 mobile-server 首设流程同语义）
        } else {
          const ip = clientIp(req);
          const locked = rateLocked(ip);
          if (locked > 0) {
            json(res, 429, { ok: false, error: `密码错误次数过多，锁定 ${Math.ceil(locked / 1000)} 秒` });
            return;
          }
          if (!verifyPin(pin, data)) {
            rateFail(ip);
            json(res, 401, { ok: false, error: "密码错误" });
            return;
          }
        }
        const token = await issueSession(data);
        res.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
          "set-cookie": `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${30 * 24 * 3600}`
        });
        res.end(JSON.stringify({ ok: true, token })); // token 供 WS ?auth= 使用（脚本场景）
      } catch (err) {
        json(res, 500, { ok: false, error: String(err) });
      }
    }
  });
  webServer.register({
    kind: "exact",
    path: "/api/worktable/file",
    handler: async (req, res) => {
      try {
        if (await gateReq(req, res)) return;
        const u = new URL(req.url ?? "/", "http://dsh.internal");
        const p = u.searchParams.get("path") || "";
        if (!p) {
          json(res, 400, { error: "missing path" });
          return;
        }
        const abs = pathResolve(p);
        const stat = await import("node:fs/promises").then((m) => m.stat(abs));
        if (stat.size > 20 * 1024 * 1024) {
          json(res, 413, { error: "file too large" });
          return;
        }
        const data = await readFile(abs);
        const ext = (abs.split(".").pop() || "").toLowerCase();
        const types = {
          html: "text/html; charset=utf-8",
          htm: "text/html; charset=utf-8",
          css: "text/css; charset=utf-8",
          js: "text/javascript; charset=utf-8",
          mjs: "text/javascript; charset=utf-8",
          json: "application/json; charset=utf-8",
          md: "text/markdown; charset=utf-8",
          markdown: "text/markdown; charset=utf-8",
          txt: "text/plain; charset=utf-8",
          log: "text/plain; charset=utf-8",
          pdf: "application/pdf",
          svg: "image/svg+xml",
          png: "image/png",
          jpg: "image/jpeg",
          jpeg: "image/jpeg",
          gif: "image/gif",
          webp: "image/webp",
          bmp: "image/bmp",
          ico: "image/x-icon"
        };
        res.writeHead(200, { "content-type": FILE_TYPES[ext] ?? "application/octet-stream", "cache-control": "no-store" });
        res.end(data);
      } catch (err) {
        json(res, 404, { error: String(err) });
      }
    }
  });
  webServer.register({
    kind: "prefix",
    path: TEMPLATE_PREFIX,
    handler: (req, res) => {
      try {
        if (req.method !== "GET") {
          res.writeHead(405);
          res.end();
          return;
        }
        const pathname = new URL(req.url ?? "/", "http://dsh.internal").pathname;
        const rel = pathname.slice(TEMPLATE_PREFIX.length);
        if (rel === "/dshell.css") {
          res.writeHead(200, { "content-type": "text/css; charset=utf-8", "cache-control": "no-store" });
          res.end(dshell_default);
        } else {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
          res.end(dshell_default2);
        }
      } catch (err) {
        res.writeHead(404);
        res.end(String(err));
      }
    }
  });
  webServer.register({
    kind: "prefix",
    path: SITE_PREFIX,
    handler: async (req, res) => {
      try {
        if (await gateReq(req, res)) return;
        if (req.method !== "GET") {
          res.writeHead(405);
          res.end();
          return;
        }
        const pathname = new URL(req.url ?? "/", "http://dsh.internal").pathname;
        const segs = pathname.slice(SITE_PREFIX.length).split("/").filter(Boolean);
        const rootToken = decodeURIComponent(segs.shift() ?? "");
        const rel = segs.map((s) => {
          try {
            return decodeURIComponent(s);
          } catch {
            return s;
          }
        }).join("/");
        if (!rootToken) {
          json(res, 400, { error: "missing root" });
          return;
        }
        const root = pathResolve(rootToken);
        let abs = pathResolve(root, rel);
        if (abs !== root && !abs.startsWith(root + sep)) {
          json(res, 403, { error: "outside root" });
          return;
        }
        const statMod = await import("node:fs/promises");
        let info = await statMod.stat(abs).catch(() => null);
        if (info && info.isDirectory()) {
          abs = pathResolve(abs, "index.html");
          info = await statMod.stat(abs).catch(() => null);
        }
        if (!info || !info.isFile()) {
          json(res, 404, { error: "not found" });
          return;
        }
        if (info.size > 40 * 1024 * 1024) {
          json(res, 413, { error: "file too large" });
          return;
        }
        const data = await readFile(abs);
        const ext = (abs.split(".").pop() || "").toLowerCase();
        res.writeHead(200, { "content-type": FILE_TYPES[ext] ?? "application/octet-stream", "cache-control": "no-store" });
        res.end(data);
      } catch (err) {
        json(res, 404, { error: String(err) });
      }
    }
  });
  webServer.register({
    kind: "exact",
    path: "/api/worktable/fs",
    handler: async (req, res) => {
      try {
        if (await gateReq(req, res)) return;
        const body = await readJsonBody(req);
        const path = typeof body.path === "string" && body.path ? body.path : serverCwd(ctx, body.sessionId, body.cwd);
        json(res, 200, await listDirectory(path));
      } catch (err) {
        json(res, 500, { path: "", entries: [], truncated: false, error: String(err) });
      }
    }
  });
  webServer.register({
    kind: "exact",
    path: "/api/worktable/workspaces",
    handler: async (req, res) => {
      try {
        if (await gateReq(req, res)) return;
        const file = pathResolve(homedir(), ".dsh", "storages", "workspace.json");
        const raw = await readFile(file, "utf8");
        json(res, 200, JSON.parse(raw.charCodeAt(0) === 65279 ? raw.slice(1) : raw));
      } catch (err) {
        json(res, 404, { error: String(err) });
      }
    }
  });
  webServer.register({
    kind: "exact",
    path: "/api/worktable/write",
    handler: async (req, res) => {
      try {
        if (await gateReq(req, res)) return;
        if (req.method !== "POST") {
          res.writeHead(405);
          res.end();
          return;
        }
        const body = await readJsonBody(req);
        const p = typeof body.path === "string" ? body.path : "";
        const content = typeof body.content === "string" ? body.content : "";
        if (!p) {
          json(res, 400, { error: "missing path" });
          return;
        }
        if (content.length > 20 * 1024 * 1024) {
          json(res, 413, { error: "content too large" });
          return;
        }
        const abs = pathResolve(p);
        await import("node:fs/promises").then((m) => m.writeFile(abs, content, "utf8"));
        json(res, 200, { ok: true });
      } catch (err) {
        json(res, 500, { error: String(err) });
      }
    }
  });
  webServer.register({
    kind: "exact",
    path: "/api/worktable/mkdir",
    handler: async (req, res) => {
      try {
        if (await gateReq(req, res)) return;
        if (req.method !== "POST") {
          res.writeHead(405);
          res.end();
          return;
        }
        const body = await readJsonBody(req);
        const p = typeof body.path === "string" ? body.path.trim() : "";
        if (!p) {
          json(res, 400, { error: "missing path" });
          return;
        }
        const abs = pathResolve(p);
        const fsx = await import("node:fs/promises");
        const parent = dirname(abs);
        try {
          await fsx.access(parent);
        } catch {
          json(res, 400, { error: "parent not found" });
          return;
        }
        await fsx.mkdir(abs);
        json(res, 200, { ok: true, path: abs });
      } catch (err) {
        json(res, err?.code === "EEXIST" ? 200 : 500, err?.code === "EEXIST" ? { ok: true, exists: true } : { error: String(err) });
      }
    }
  });
  webServer.register({
    kind: "exact",
    path: "/api/worktable/git",
    handler: async (req, res) => {
      try {
        if (await gateReq(req, res)) return;
      } catch (err) {
        json(res, 500, { error: String(err) });
        return;
      }
      const body = await readJsonBody(req);
      const cwd = serverCwd(ctx, body.sessionId, body.cwd);
      json(res, 200, await gitStatus(cwd));
    }
  });
  loadAuth().then((d) => ctx.logger?.info?.("[dsh-worktable] auth: " + (d.pinHash ? "configured" : "NOT configured — 首次 POST /api/worktable/login 即设置密码")));
  setupTerminal(webServer, ctx);
}
var __auth = {
  COOKIE_NAME,
  authFilePath,
  authGate,
  loadAuth,
  saveAuth,
  hashPin,
  verifyPin,
  rateFail,
  rateLocked
};
export {
  HEALTH_PATH,
  __auth,
  apply,
  inject,
  name
};

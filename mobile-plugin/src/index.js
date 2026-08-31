// dsh-timetable-mobile · DSH 插件宿主（结构参照 dsh-dafeiyu / dsh-pocket / dsh-timetable-reminder）
// 职责：DSH web 启动时拉起本工作区的 mobile-server.mjs（手机扫码访问服务），
//       DSH 关闭/插件卸载时通过 HTTP shutdown 指令优雅回收，超时再强杀兜底。
// 加固：子进程意外退出自动重启（指数退避 5s→10s→20s→40s→80s，连续 5 次失败后放弃）；
//       stdout/stderr 落盘 .mobile-srv/server.log（超 1MB 截断保留后半）；
//       端口占用先探 /api/status 验明是本服务才跳过（异物占用继续向后找并告警）；
//       子进程 env 走白名单，不继承宿主全量环境（供应商密钥等凭据不下传）。
import { spawn, execFile } from 'node:child_process';
import http from 'node:http';
import { existsSync } from 'node:fs';
import { readFile, writeFile, appendFile, stat, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');

export const name = 'dsh-timetable-mobile';
export const inject = [];

/** 工作区根（插件位于 <工作区>/mobile-plugin，服务脚本在 <工作区>/mobile-server.mjs）。 */
const here = dirname(fileURLToPath(import.meta.url));
const WORKSPACE = resolve(here, '..', '..');
const SERVER_SCRIPT = resolve(WORKSPACE, 'mobile-server.mjs');
const SRV_DIR = join(WORKSPACE, '.mobile-srv');
const PORT_FILE = join(SRV_DIR, 'port');
const LOG_PATH = join(SRV_DIR, 'server.log');
const LOG_MAX_BYTES = 1024 * 1024;

// ---- 子进程 env 白名单：mobile-server 只需运行时基础变量与 DSH 地址，不需要宿主供应商密钥 ----
const ENV_WHITELIST = ['PATH', 'SYSTEMROOT', 'COMSPEC', 'TEMP', 'TMP', 'DSH_PORT', 'DSH_API_URL', 'NODE_ENV', 'LANG'];
function childEnv() {
  const env = {};
  for (const key of ENV_WHITELIST) {
    const v = process.env[key];
    if (v !== undefined) env[key] = v;
  }
  return env;
}

// ---- 日志落盘：串行化追加写（保证顺序），超 1MB 截断保留后半（512KB） ----
let logChain = Promise.resolve();
function logWrite(text) {
  logChain = logChain.then(async () => {
    try {
      await mkdir(SRV_DIR, { recursive: true });
      try {
        if ((await stat(LOG_PATH)).size > LOG_MAX_BYTES) {
          const buf = await readFile(LOG_PATH);
          await writeFile(LOG_PATH, buf.subarray(Math.max(0, buf.length - Math.floor(LOG_MAX_BYTES / 2))));
        }
      } catch { /* 尚无日志文件 */ }
      await appendFile(LOG_PATH, text);
    } catch { /* 日志失败不影响服务 */ }
  });
  return logChain;
}

/** 消费子进程输出流：逐行加时间戳写入 server.log（stdout=out / stderr=err）。 */
function tapLog(stream, tag) {
  stream.on('data', (chunk) => {
    const ts = new Date().toISOString();
    for (const line of String(chunk).split(/\r?\n/)) {
      if (line) logWrite(`[${ts}] [${tag}] ${line}\n`);
    }
  });
}

/** 探测端口是否已被监听（已有人跑服务则本插件不再拉起，避免多实例）。 */
function portTaken(port, host = '127.0.0.1') {
  return new Promise((resolveProbe) => {
    const s = net.connect({ port, host, timeout: 400 });
    s.once('connect', () => { s.destroy(); resolveProbe(true); });
    s.once('error', () => resolveProbe(false));
    s.once('timeout', () => { s.destroy(); resolveProbe(false); });
  });
}

/**
 * 端口占用者身份探测：GET /api/status 响应 JSON 含 ok:true 且 port 匹配，
 * 才认定是本服务（功能端口）；直连端口只回引导页 HTML、异物进程响应其他
 * 内容，均不算——避免把 shutdown / 跳过判断发给不相干进程。
 */
function probeTimetableServer(port) {
  return new Promise((resolveProbe) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/status', timeout: 1500 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; if (body.length > 65536) req.destroy(); });
      res.on('end', () => {
        try {
          const j = JSON.parse(body);
          resolveProbe(!!j && j.ok === true && j.port === port);
        } catch { resolveProbe(false); }
      });
    });
    req.on('error', () => resolveProbe(false));
    req.on('timeout', () => { req.destroy(); resolveProbe(false); });
  });
}

/** 读取服务写入的实际端口（.mobile-srv/port，优先），失败回退逐个探测并验明身份。 */
async function serverPort() {
  try {
    const p = parseInt(String(await readFile(PORT_FILE, 'utf8')).trim(), 10);
    if (p >= 3190 && p < 3200 && (await portTaken(p))) return p;
  } catch { /* 无端口文件 */ }
  for (let p = 3190; p < 3200; p++) {
    // eslint-disable-next-line no-await-in-loop
    if ((await portTaken(p)) && (await probeTimetableServer(p))) return p;
  }
  return null;
}

/**
 * 回收服务：POST /api/admin/shutdown（loopback 栅栏内，服务先关隧道再优雅退出），
 * 3 秒未退再强杀（Windows taskkill /T /F 杀整棵树；POSIX SIGKILL）。
 */
async function shutdownServer(child, logger) {
  if (!child || child.exitCode !== null) return;
  const port = await serverPort();
  let exited = false;
  child.once('exit', () => { exited = true; });
  try {
    if (port) {
      await fetch(`http://127.0.0.1:${port}/api/admin/shutdown`, { method: 'POST' });
    }
  } catch (e) { /* 服务可能已退出 */ }
  for (let i = 0; i < 15 && !exited; i++) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!exited && child.exitCode === null) {
    logger?.warn?.('dsh-timetable-mobile: graceful shutdown timed out, force killing');
    if (process.platform === 'win32') {
      try { execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }, () => {}); }
      catch { try { child.kill(); } catch (e2) {} }
    } else {
      try { child.kill('SIGKILL'); } catch (e) {}
    }
  }
}

export function apply(ctx) {
  const logger = ctx?.logger ?? console;
  let child = undefined;
  let stopping = false;

  // ---- 守护重启：指数退避 5s→10s→20s→40s→80s；连续 5 次失败放弃；稳定运行满 60s 后退出则重置计数 ----
  const RESTART_BASE_MS = 5_000;
  const RESTART_MAX_TRIES = 5;
  const STABLE_RUN_MS = 60_000;
  let restartFails = 0;
  let restartTimer = undefined;
  let lastStartAt = 0;

  const scheduleRestart = (reason) => {
    if (stopping || restartTimer) return;
    if (restartFails >= RESTART_MAX_TRIES) {
      logger.error?.(`dsh-timetable-mobile: 连续 ${RESTART_MAX_TRIES} 次重启均失败，放弃自动拉起（最后原因：${reason}；日志见 ${LOG_PATH}）`);
      return;
    }
    const delay = RESTART_BASE_MS * 2 ** restartFails; // 5s → 10s → 20s → 40s → 80s
    restartFails += 1;
    logger.warn?.(`dsh-timetable-mobile: server ${reason}，${Math.round(delay / 1000)}s 后自动重启（第 ${restartFails}/${RESTART_MAX_TRIES} 次）`);
    restartTimer = setTimeout(() => {
      restartTimer = undefined;
      void start();
    }, delay);
    restartTimer.unref?.();
  };

  const start = async () => {
    if (!existsSync(SERVER_SCRIPT)) {
      logger.warn?.(`dsh-timetable-mobile: server script not found: ${SERVER_SCRIPT}`);
      return;
    }
    // 端口身份探测：只有 /api/status 验明是本服务才跳过拉起；
    // 异物占用（响应非本服务 API）继续向后找，全部被异物占用则告警放弃。
    let existingPort = null;
    let anyFree = false;
    for (let p = 3190; p < 3200; p++) {
      // eslint-disable-next-line no-await-in-loop
      if (!(await portTaken(p))) { anyFree = true; continue; }
      // eslint-disable-next-line no-await-in-loop
      if (await probeTimetableServer(p)) { existingPort = p; break; }
      logger.info?.(`dsh-timetable-mobile: port ${p} 被占用但未通过 /api/status 身份验证（直连端口引导页或异物进程），继续探测`);
    }
    if (existingPort !== null) {
      logger.info?.(`dsh-timetable-mobile: port ${existingPort} already serving, skip auto-start`);
      return;
    }
    if (!anyFree) {
      logger.warn?.('dsh-timetable-mobile: 端口 3190-3199 全被非本服务进程占用，放弃自动拉起');
      return;
    }
    child = spawn(process.execPath, [SERVER_SCRIPT], {
      cwd: WORKSPACE,
      env: childEnv(), // 白名单：不继承宿主全量环境
      stdio: ['ignore', 'pipe', 'pipe'], // stdout/stderr 落盘 server.log
      windowsHide: true,
    });
    lastStartAt = Date.now();
    tapLog(child.stdout, 'out');
    tapLog(child.stderr, 'err');
    child.once('error', (e) => {
      logger.warn?.(`dsh-timetable-mobile: spawn failed: ${e.message}`);
      child = undefined;
      scheduleRestart(`spawn error: ${e.message}`);
    });
    child.once('exit', (code, signal) => {
      const ranMs = Date.now() - lastStartAt;
      if (ranMs >= STABLE_RUN_MS) restartFails = 0; // 曾稳定运行：退出不算"连续失败"
      child = undefined;
      if (stopping) return; // 宿主 dispose 触发的正常退出：不重启
      logger.info?.(`dsh-timetable-mobile: server exited (code=${String(code)}, signal=${String(signal)})`);
      scheduleRestart(`exited (code=${String(code)}, signal=${String(signal)})`);
    });
    logger.info?.(`dsh-timetable-mobile: mobile-server started (pid=${String(child.pid)}, v${pkg.version})`);
  };

  void start();

  ctx.effect(() => () => {
    stopping = true;
    if (restartTimer) { clearTimeout(restartTimer); restartTimer = undefined; }
    void shutdownServer(child, logger);
    logger.info?.('dsh-timetable-mobile: mobile-server stopping with host');
  }, 'dsh-timetable-mobile: lifecycle');
}

export default { name, inject, apply };

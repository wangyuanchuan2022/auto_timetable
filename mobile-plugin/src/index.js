// dsh-timetable-mobile · DSH 插件宿主（结构参照 dsh-dafeiyu / dsh-pocket / dsh-timetable-reminder）
// 职责：DSH web 启动时拉起本工作区的 mobile-server.mjs（手机扫码访问服务），
//       DSH 关闭/插件卸载时通过 HTTP shutdown 指令优雅回收（服务先关 cloudflared 隧道再退出），
//       超时再强杀兜底。
import { spawn, execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
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
const PORT_FILE = join(WORKSPACE, '.mobile-srv', 'port');

/** 探测端口是否已被监听（已有人跑服务则本插件不再拉起，避免多实例）。 */
function portTaken(port, host = '127.0.0.1') {
  return new Promise((resolveProbe) => {
    const s = net.connect({ port, host, timeout: 400 });
    s.once('connect', () => { s.destroy(); resolveProbe(true); });
    s.once('error', () => resolveProbe(false));
    s.once('timeout', () => { s.destroy(); resolveProbe(false); });
  });
}

/** 读取服务写入的实际端口（.mobile-srv/port），失败回退逐个探测 3190-3199。 */
async function serverPort() {
  try {
    const p = parseInt(String(await readFile(PORT_FILE, 'utf8')).trim(), 10);
    if (p >= 3190 && p < 3200) return p;
  } catch { /* 无端口文件 */ }
  for (let p = 3190; p < 3200; p++) {
    // eslint-disable-next-line no-await-in-loop
    if (await portTaken(p)) return p;
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

  const start = async () => {
    if (!existsSync(SERVER_SCRIPT)) {
      logger.warn?.(`dsh-timetable-mobile: server script not found: ${SERVER_SCRIPT}`);
      return;
    }
    // 3190-3199 任一被占都视为已有实例（面板手动拉起/人工启动），本插件不重复拉起
    for (let p = 3190; p < 3200; p++) {
      // eslint-disable-next-line no-await-in-loop
      if (await portTaken(p)) {
        logger.info?.(`dsh-timetable-mobile: port ${p} already serving, skip auto-start`);
        return;
      }
    }
    child = spawn(process.execPath, [SERVER_SCRIPT], {
      cwd: WORKSPACE,
      env: { ...process.env },
      stdio: ['ignore', 'ignore', 'ignore'],
      windowsHide: true,
    });
    child.once('error', (e) => logger.warn?.(`dsh-timetable-mobile: spawn failed: ${e.message}`));
    child.once('exit', (code, signal) => {
      if (!stopping) logger.info?.(`dsh-timetable-mobile: server exited (code=${String(code)}, signal=${String(signal)})`);
      child = undefined;
    });
    logger.info?.(`dsh-timetable-mobile: mobile-server started (pid=${String(child.pid)}, v${pkg.version})`);
  };

  void start();

  ctx.effect(() => () => {
    stopping = true;
    void shutdownServer(child, logger);
    logger.info?.('dsh-timetable-mobile: mobile-server stopping with host');
  }, 'dsh-timetable-mobile: lifecycle');
}

export default { name, inject, apply };

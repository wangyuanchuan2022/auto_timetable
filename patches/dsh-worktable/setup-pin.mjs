// setup-pin.mjs — 设置/重置 dsh-worktable 访问 PIN（写入 ~/.dsh/storages/worktable-auth.json）
// 用法：node patches/dsh-worktable/setup-pin.mjs "<PIN>"
//      不带参数则生成 12 位随机 PIN 并写入 .mobile-srv/worktable-pin.txt（gitignored）。
// 明文 PIN 同时落盘 .mobile-srv/worktable-pin.txt，供 .qrtest 应急脚本读取。
import { randomBytes, scryptSync } from 'node:crypto';
import { writeFileSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

let pin = process.argv[2];
if (!pin) {
  pin = randomBytes(9).toString('base64url').replace(/[-_]/g, 'x').slice(0, 12);
  console.log('[generated] 12-char pin');
}
const salt = randomBytes(16).toString('hex');
const hash = scryptSync(String(pin), salt, 32, { N: 16384 }).toString('hex');
const file = process.env.DSH_WORKTABLE_AUTH_FILE || resolve(homedir(), '.dsh', 'storages', 'worktable-auth.json');
const prev = (() => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; } })();
writeFileSync(file, JSON.stringify({ pinHash: { salt, hash }, sessions: prev.sessions ?? [] }), 'utf8');
const pinFile = new URL('../../.mobile-srv/worktable-pin.txt', import.meta.url);
writeFileSync(pinFile, String(pin), 'utf8');
console.log('[OK] auth written: ' + file);
console.log('[OK] plaintext pin file: .mobile-srv/worktable-pin.txt');

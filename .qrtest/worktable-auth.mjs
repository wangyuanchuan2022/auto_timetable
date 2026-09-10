// worktable-auth.mjs — dsh-worktable 鉴权助手（.qrtest 应急脚本共用）
// 读取 .mobile-srv/worktable-pin.txt（gitignored 明文），POST /api/worktable/login 换会话 token。
// 兼容两种状态：补丁已生效（正常换 token）/ 未重启生效（login 404 → 返回 null，脚本回退无鉴权直连）。
import { readFileSync } from 'node:fs';

export const WORKTABLE_ORIGIN = 'http://127.0.0.1:3080';

export function readWorktablePin() {
  try {
    const pin = readFileSync(new URL('../.mobile-srv/worktable-pin.txt', import.meta.url), 'utf8').trim();
    return pin || null;
  } catch {
    return null;
  }
}

/** 返回 { token }（补丁已生效）或 null（旧版无鉴权 / 未配置 PIN / 登录失败）。 */
export async function worktableToken() {
  const pin = readWorktablePin();
  if (!pin) return null;
  try {
    const r = await fetch(`${WORKTABLE_ORIGIN}/api/worktable/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin }),
      signal: AbortSignal.timeout(5000),
    });
    if (r.status === 404) return null; // 补丁未生效（无 login 路由）→ 旧版直连
    const j = await r.json().catch(() => ({}));
    if (j.ok && j.token) return { token: j.token };
    console.log('[worktable-auth] 登录失败：' + (j.error || ('http ' + r.status)));
    return null;
  } catch (e) {
    console.log('[worktable-auth] 登录异常：' + String(e).slice(0, 100));
    return null;
  }
}

/** 拼 worktable term 的 WebSocket URL（补丁生效时附 ?auth=token）。 */
export function termUrl(token, params = '') {
  const auth = token ? '&auth=' + encodeURIComponent(token) : '';
  return `ws://127.0.0.1:3080/api/worktable/term?${params}${auth}`;
}

// verify-plan-window.mjs — v1.5 部署验证：对正在运行的 mobile-server 实例带凭据请求
// /api/plan?days=30，断言服务端新钳制（1..60）已生效、条目覆盖远超 14 天。
// 凭据：settings.json 中服务端自签发的会话 token（Cookie tt_pin_v2），不经手 PIN 明文。
import { readFileSync } from 'node:fs';

const s = JSON.parse(readFileSync('D:/tools/auto_timetable/.mobile-srv/settings.json', 'utf8'));
const token = ((s.sessions || []).find((x) => x && typeof x.token === 'string') || {}).token;
if (!token) { console.error('[FAIL] settings.json 无可用会话 token'); process.exit(1); }

let pass = 0, fail = 0;
const ok = (cond, name, detail = '') => {
  if (cond) { pass++; console.log(`  [OK] ${name}${detail ? ' — ' + detail : ''}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
};

const r = await fetch('http://127.0.0.1:3191/api/plan?days=30', {
  headers: { cookie: `tt_pin_v2=${token}` },
});
const j = await r.json();
const now = Date.now();
const DAY = 86400000;
const leads = (j.items || []).map((it) => (it.remindAt - now) / DAY);
const maxLead = leads.length ? Math.max(...leads) : -1;
const minLead = leads.length ? Math.min(...leads) : -1;
const beyond14 = leads.filter((x) => x > 14).length;
const maxAt = leads.length ? new Date(now + maxLead * DAY) : null;

ok(r.status === 200 && j.ok === true, '带会话 Cookie 请求 200', `status=${r.status}`);
ok(j.days === 30, '服务端接受 days=30（新钳制上限 60 生效，旧进程会返回 14）', `days=${j.days}`);
ok((j.items || []).length > 0, 'items 非空', `n=${(j.items || []).length}`);
ok(maxLead > 14, `条目覆盖远超 14 天（存在两周以后的提醒）`, `maxLeadDays=${maxLead.toFixed(1)}`);
ok(maxLead <= 31, '且不超过 30 天窗（无越界条目）', `maxLeadDays=${maxLead.toFixed(1)}`);
ok(beyond14 > 0, `14 天之外的条目数 > 0`, `n=${beyond14}`);
ok(minLead >= 0 || leads.length === 0, '全部条目朝向未来（无过期残留）', `minLeadDays=${minLead.toFixed(1)}`);
if (leads.length) {
  const first = j.items.reduce((a, b) => (a.remindAt <= b.remindAt ? a : b));
  const fmt = (ms) => { const d = new Date(ms); return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
  console.log(`  [INFO] 下次提醒（横幅将显示）: ${fmt(first.remindAt)} · ${first.title}`);
  console.log(`  [INFO] 最远提醒: ${fmt(now + maxLead * DAY)}（${maxLead.toFixed(1)} 天后）`);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);

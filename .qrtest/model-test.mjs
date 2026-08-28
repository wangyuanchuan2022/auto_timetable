// 模型切换端点验证：列表 → 切换到 glm-5.1 → 验证已切换并恢复 → 确认 settings 同步
import fs from 'node:fs';
const PIN = JSON.parse(fs.readFileSync('.mobile-srv/settings.json', 'utf8')).pin || '';
const B = 'http://127.0.0.1:3190';
const cookie = (await fetch(`${B}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin: PIN }) })
  .then(r => (r.headers.get('set-cookie').match(/tt_pin_v2=[a-f0-9]+/) || [])[0]));

// 1) 模型列表
const models = await fetch(`${B}/api/chat/models`, { headers: { cookie } }).then(r => r.json());
console.log('current:', models.current?.provider, '/', models.current?.model);
console.log('groups:', (models.groups || []).map(g => `${g.id}(${(g.models||[]).length})`).join(', '));

// 2) 切到 glm-5.1
const target = (models.groups || []).flatMap(g => (g.models || []).map(m => ({ provider: g.id, model: m.id }))).find(m => m.model === 'glm-5.1');
if (!target) { console.log('glm-5.1 not found, skip switch test'); process.exit(0); }
const sw = await fetch(`${B}/api/chat/model`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(target) }).then(r => r.json());
console.log('switch →', JSON.stringify(sw));

// 3) 复核 + settings 同步
const after = await fetch(`${B}/api/chat/models`, { headers: { cookie } }).then(r => r.json());
console.log('after current:', after.current?.provider, '/', after.current?.model);
const settings = JSON.parse(fs.readFileSync('.mobile-srv/settings.json', 'utf8'));
console.log('settings.chatDefaultModel:', JSON.stringify(settings.chatDefaultModel));

// 4) 恢复 glm-5.2
const back = await fetch(`${B}/api/chat/model`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ provider: 'zai-coding-cn', model: 'glm-5.2' }) }).then(r => r.json());
console.log('restore →', back.ok ? back.current.model : JSON.stringify(back));

const ok = sw.ok && after.current.model === 'glm-5.1' && settings.chatDefaultModel.model === 'glm-5.1' && back.ok;
console.log(ok ? 'RESULT: 模型切换 OK' : 'RESULT: FAIL');
process.exit(ok ? 0 : 1);

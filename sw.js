// sw.js — 手机端 Service Worker：接收 Web Push 并弹系统通知；点击通知回到页面
self.addEventListener('install', (e) => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { title: '⏰ 日程提醒', body: '' }; }
  event.waitUntil(self.registration.showNotification(data.title || '⏰ 日程提醒', {
    body: data.body || '',
    tag: data.tag || 'timetable',
    renotify: true,
    data: { url: data.url || '/' },
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    vibrate: [200, 100, 200],
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil((async () => {
    // 优先聚焦属于本 SW scope 的窗口（多站点/多 PWA 窗口并存时不误跳他站）；
    // 找不到再聚焦任意窗口；都没有才开新窗。includeUncontrolled 确保未受控窗口也在候选内。
    const scope = self.registration.scope;
    const cs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const own = cs.find((c) => c.url && c.url.startsWith(scope));
    if (own && 'focus' in own) { await own.focus(); return; }
    const any = cs.find((c) => 'focus' in c);
    if (any) { await any.focus(); return; }
    if (self.clients.openWindow) await self.clients.openWindow(url);
  })());
});

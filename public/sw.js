self.addEventListener('push', function (event) {
  let data = { title: '까꿍디미방', body: '새 소식이 있어요', url: '/order' };
  try { data = event.data.json(); } catch (e) {}
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { url: data.url || '/order' },
    })
  );
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  const url = event.notification.data?.url || '/order';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
      // 예전엔 열려 있는 창이 있으면 focus만 하고 알림이 가리키는 화면으로 이동하지 않아서,
      // 배송상태 알림을 눌러도 엉뚱한 화면(직전에 보던 화면)에 그대로 머물렀음.
      for (var i = 0; i < list.length; i++) {
        var c = list[i];
        if ('focus' in c) {
          if ('navigate' in c) { return c.navigate(url).then(function (nc) { return (nc || c).focus(); }); }
          return c.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});

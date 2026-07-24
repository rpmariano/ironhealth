// IronHealth · Service Worker
// Só existe para receber notificações Web Push (lembretes de água) mesmo
// com a app fechada, e para as tornar clicáveis (abrir/focar a app).
// Não faz cache nem funciona offline — isso é propositadamente fora de
// âmbito aqui, para não complicar a invalidação de cache do index.html.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = { title: 'IronHealth', body: 'Hora de beber água 💧' };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch (e) { /* payload não era JSON — usa os valores por omissão */ }

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: 'icon-192.png',
      badge: 'icon-192.png',
      tag: 'water-reminder',
      renotify: true,
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('/');
    })
  );
});

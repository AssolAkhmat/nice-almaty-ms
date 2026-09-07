/*
 * Service worker: офлайн-оболочка и приём push (docs/07-ROADMAP.md, фаза 6).
 *
 * Кешируется только оболочка на случай обрыва связи. Страницы приложения
 * не кешируются намеренно: места, счета и ротации меняются каждый день,
 * и показать вчерашний список хуже, чем честно сказать «нет сети».
 */
const CACHE = 'nice-almaty-shell-v1';
const OFFLINE_URL = '/offline.html';

const SHELL = [OFFLINE_URL, '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

/*
 * Только переходы по страницам: запрос к API в офлайне должен вернуть
 * ошибку, а не страницу-заглушку, иначе клиент примет HTML за ответ.
 */
self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate') {
    return;
  }

  event.respondWith(
    fetch(event.request).catch(() =>
      caches.match(OFFLINE_URL).then((cached) => cached ?? Response.error()),
    ),
  );
});

self.addEventListener('push', (event) => {
  if (event.data === null || event.data === undefined) {
    return;
  }

  let payload = {};

  try {
    payload = event.data.json();
  } catch {
    payload = { title: event.data.text(), body: '' };
  }

  const title = typeof payload.title === 'string' && payload.title !== '' ? payload.title : ' ';

  event.waitUntil(
    self.registration.showNotification(title, {
      body: typeof payload.body === 'string' ? payload.body : '',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      /* Уведомление одного события не должно множиться на экране. */
      tag: typeof payload.id === 'string' ? payload.id : undefined,
      data: { url: '/notifications' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const url = event.notification.data?.url ?? '/notifications';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) {
          client.navigate(url);

          return client.focus();
        }
      }

      return self.clients.openWindow(url);
    }),
  );
});

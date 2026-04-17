const CACHE_NAME = 'rocchat-v5';
const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/offline.html',
  '/favicon.svg',
  '/manifest.json',
];

// Install — cache app shell & activate immediately
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS))
  );
  self.skipWaiting();
});

// Activate — clean old caches & take control
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Push notification display (for future web push support)
self.addEventListener('push', (event) => {
  if (!event.data) return;
  try {
    const data = event.data.json();
    event.waitUntil(
      self.registration.showNotification(data.title || 'RocChat', {
        body: data.body || 'New encrypted message',
        icon: '/favicon.svg',
        badge: '/favicon.svg',
        tag: data.tag || 'message',
        renotify: !!data.tag,
        data: data.url ? { url: data.url } : undefined,
        actions: [
          { action: 'open', title: 'Open' },
          { action: 'dismiss', title: 'Dismiss' },
        ],
      })
    );
  } catch { /* ignore malformed push */ }
});

// Notification click — focus or open app
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      const existing = clients.find((c) => c.url.includes(self.location.origin));
      if (existing) {
        return existing.focus();
      }
      return self.clients.openWindow(url);
    })
  );
});

// Fetch strategy:
//  - App shell (index.html): network-first, fallback to cache
//  - Hashed assets (*.js, *.css with hash): cache-first (immutable)
//  - API / WebSocket: passthrough (no cache)
//  - Everything else: stale-while-revalidate
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never cache API or WebSocket requests
  if (url.pathname.startsWith('/api/') ||
      event.request.headers.get('Upgrade') === 'websocket') {
    return;
  }

  // Network-first for navigation (index.html) — ensures fresh deploys load fast
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          return response;
        })
        .catch(() => caches.match('/index.html').then(r => r || caches.match('/offline.html')))
    );
    return;
  }

  // Hashed assets — cache-first (Vite adds content hashes, so they're immutable)
  if (/\.[a-f0-9]{8,}\.(js|css)$/.test(url.pathname) || url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached) return cached;
        return fetch(event.request).then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        });
      })
    );
    return;
  }

  // Everything else — stale-while-revalidate
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const fetched = fetch(event.request).then((response) => {
        if (response.ok && event.request.method === 'GET') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      });
      return cached || fetched;
    })
  );
});

// Background Sync — retry queued messages when connectivity returns
self.addEventListener('sync', (event) => {
  if (event.tag === 'message-queue') {
    event.waitUntil(
      (async () => {
        try {
          const db = await new Promise((resolve, reject) => {
            const req = indexedDB.open('rocchat-outbox', 1);
            req.onupgradeneeded = () => req.result.createObjectStore('pending', { keyPath: 'id' });
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
          });
          const tx = db.transaction('pending', 'readonly');
          const store = tx.objectStore('pending');
          const items = await new Promise((resolve, reject) => {
            const req = store.getAll();
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
          });
          for (const item of items) {
            const res = await fetch(item.url, {
              method: 'POST',
              headers: item.headers,
              body: item.body,
            });
            if (res.ok) {
              const dtx = db.transaction('pending', 'readwrite');
              dtx.objectStore('pending').delete(item.id);
              await new Promise((r) => { dtx.oncomplete = r; });
            }
          }
          db.close();
        } catch { /* will retry on next sync */ }
      })()
    );
  }
});

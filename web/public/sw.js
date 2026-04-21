const CACHE_NAME = 'rocchat-v7';
const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/offline.html',
  '/favicon.svg',
  '/manifest.json',
];

// Runtime cache budget. SW caches grow unbounded by default; we cap the
// hashed-asset cache to keep on-device storage modest. Eviction is approximate
// LRU based on Response "date" header (browsers fill it on store).
const RUNTIME_BYTE_BUDGET = 8 * 1024 * 1024; // 8 MB
const RUNTIME_ENTRY_BUDGET = 96;

async function trimCache(cacheName) {
  try {
    const cache = await caches.open(cacheName);
    const keys = await cache.keys();
    if (keys.length <= RUNTIME_ENTRY_BUDGET) return;
    // Drop the oldest entries first.
    const stamped = await Promise.all(keys.map(async (req) => {
      const res = await cache.match(req);
      const dateHeader = res?.headers.get('date');
      const ts = dateHeader ? Date.parse(dateHeader) : 0;
      return { req, ts };
    }));
    stamped.sort((a, b) => a.ts - b.ts);
    const overflow = stamped.length - RUNTIME_ENTRY_BUDGET;
    for (let i = 0; i < overflow; i++) {
      await cache.delete(stamped[i].req);
    }
  } catch { /* best effort */ }
}

async function estimateAndTrim(cacheName) {
  if (!navigator.storage?.estimate) return trimCache(cacheName);
  try {
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    if (quota > 0 && usage / quota > 0.6) {
      // Approaching browser quota — prune aggressively.
      const cache = await caches.open(cacheName);
      const keys = await cache.keys();
      for (let i = 0; i < Math.ceil(keys.length / 4); i++) {
        await cache.delete(keys[i]);
      }
      return;
    }
    if (usage > RUNTIME_BYTE_BUDGET) await trimCache(cacheName);
    else await trimCache(cacheName);
  } catch {
    await trimCache(cacheName);
  }
}

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

  // Never intercept non-GET requests. This avoids touching share-target POSTs,
  // uploads, auth submissions, or any request that may carry sensitive bodies.
  if (event.request.method !== 'GET') {
    return;
  }

  // Respect explicit no-store semantics from the caller.
  const cacheControl = event.request.headers.get('Cache-Control') || '';
  if (cacheControl.includes('no-store')) {
    return;
  }

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
            caches.open(CACHE_NAME).then(async (cache) => {
              await cache.put(event.request, clone);
              estimateAndTrim(CACHE_NAME);
            });
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

async function requestAuthTokenFromClients() {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const client of windows) {
    const token = await new Promise((resolve) => {
      const channel = new MessageChannel();
      const timer = setTimeout(() => resolve(null), 1500);
      channel.port1.onmessage = (event) => {
        clearTimeout(timer);
        const t = event.data && typeof event.data.token === 'string' ? event.data.token : null;
        resolve(t);
      };
      try {
        client.postMessage({ type: 'rocchat:get-auth-token' }, [channel.port2]);
      } catch {
        clearTimeout(timer);
        resolve(null);
      }
    });
    if (token) return token;
  }
  return null;
}

// Background Sync — retry queued messages when connectivity returns
self.addEventListener('sync', (event) => {
  if (event.tag === 'message-queue') {
    event.waitUntil(
      (async () => {
        try {
          const db = await new Promise((resolve, reject) => {
            const req = indexedDB.open('rocchat_mq', 1);
            req.onupgradeneeded = () => {
              const d = req.result;
              if (!d.objectStoreNames.contains('queue')) {
                d.createObjectStore('queue', { keyPath: 'localId' });
              }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
          });
          const tx = db.transaction('queue', 'readonly');
          const store = tx.objectStore('queue');
          const items = await new Promise((resolve, reject) => {
            const req = store.getAll();
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
          });
          const authToken = await requestAuthTokenFromClients();
          if (!authToken) {
            db.close();
            return;
          }
          for (const item of items) {
            const res = await fetch('/api/messages/send', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${authToken}`,
              },
              body: JSON.stringify(item.payload),
            });
            if (res.ok) {
              const dtx = db.transaction('queue', 'readwrite');
              dtx.objectStore('queue').delete(item.localId);
              await new Promise((r) => { dtx.oncomplete = r; });
            }
          }
          db.close();
        } catch { /* will retry on next sync */ }
      })()
    );
  }
});

const CACHE = 'medicine-v3'; // changed from al-farooq-v6

const PRECACHE = [
  '/offline',
  '/manifest.json',
  '/logo.png',
  '/icon-circle-180.png',
  '/icon-circle-512.png',
  '/',
  '/login'
];

const OPTIONAL_PRECACHE = [
  '/dashboard',
  '/dashboard/sales',
  '/dashboard/products',
  '/dashboard/sales/history'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then(async (cache) => {
      await Promise.allSettled(
        PRECACHE.map(async (url) => {
          try {
            const req = new Request(url, { cache: 'no-cache' });
            const res = await fetch(req);
            if (res.ok) await cache.put(req, res);
          } catch {}
        })
      );
      await Promise.allSettled(
        OPTIONAL_PRECACHE.map(async (url) => {
          try {
            const res = await fetch(url, { cache: 'no-cache' });
            if (res.ok && res.headers.get('content-type')?.includes('text/html')) {
              await cache.put(url, res);
            }
          } catch {}
        })
      );
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((k) => k !== CACHE)
          .filter((k) => k.startsWith('al-farooq-') || k.includes('sona') || k.includes('agri-pwa') || k.includes('medicine-') || k.startsWith('agri-'))
          .map((k) => {
            console.log('Deleting old cache:', k);
            return caches.delete(k);
          })
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);

  if (
    url.pathname.startsWith('/api') ||
    req.method !== 'GET' ||
    url.origin !== location.origin ||
    url.protocol === 'chrome-extension:' ||
    url.pathname.startsWith('/_next/webpack-hmr')
  ) {
    return;
  }

  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok && res.headers.get('content-type')?.includes('text/html')) {
            const clone = res.clone();
            caches.open(CACHE).then((c) => c.put(req, clone));
          }
          return res;
        })
        .catch(async () => {
          const cache = await caches.open(CACHE);
          return (await cache.match(req)) ||
                 (await cache.match('/offline')) ||
                 (await cache.match('/login')) ||
                 (await cache.match('/')) ||
                 new Response(
                   `<html><body style="font-family:system-ui;text-align:center;padding:40px"><img src="/logo.png" style="width:80px;height:80px;border-radius:50%"/><h1>Yasir Medical Store</h1><p>یاسر میڈیکل سٹور - Offline</p><p>Medicine billing available offline</p></body></html>`,
                   { headers: { 'Content-Type': 'text/html' } }
                 );
        })
    );
    return;
  }

  e.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req)
        .then((res) => {
          if (!res.ok) return res;
          if (
            url.pathname.includes('_next/static') ||
            url.pathname === '/logo.png' ||
            url.pathname === '/manifest.json' ||
            url.pathname.includes('icon-circle') ||
            req.destination === 'style' ||
            req.destination === 'script'
          ) {
            const clone = res.clone();
            caches.open(CACHE).then((c) => c.put(req, clone));
          }
          return res;
        })
        .catch(() => caches.match('/logo.png') || new Response('', { status: 503 }));
    })
  );
});
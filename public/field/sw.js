// Cache the app shell so the field app opens offline without pinning tokenized
// URLs or stale HTML forever.
const CACHE = 'oarflow-field-v2';
const SHELL = ['./index.html', '/assets/app/app.css', './icon.svg', './manifest.webmanifest'];

function isShell(url) {
  return url.pathname.endsWith('/field/') || url.pathname.endsWith('/field/index.html');
}

function shellRequest() {
  return new Request('./index.html');
}

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;

  if (e.request.mode === 'navigate' || isShell(url)) {
    e.respondWith(
      fetch(e.request).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(shellRequest(), copy));
        }
        return res;
      }).catch(() => caches.match(shellRequest(), { ignoreSearch: true })),
    );
    return;
  }

  if (url.searchParams.has('token')) return;

  if (url.pathname.startsWith('/assets/') || url.pathname.endsWith('/icon.svg') || url.pathname.endsWith('/manifest.webmanifest')) {
    e.respondWith(
      caches.match(e.request).then((hit) => {
        const fresh = fetch(e.request).then((res) => {
          if (res.ok) caches.open(CACHE).then((c) => c.put(e.request, res.clone()));
          return res;
        }).catch(() => hit);
        return hit || fresh;
      }),
    );
  }
});

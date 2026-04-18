// ============================================================
//  SERVICE WORKER — Rodzinny Kalendarz
//  Strategia: Network First dla własnych plików (zawsze świeże),
//             Cache First dla fontów (stabilne zasoby zewnętrzne)
// ============================================================

const CACHE_NAME = 'rodzinny-kalendarz-v6';

self.addEventListener('install', event => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Firebase / zewnętrzne API — zawsze sieć, bez cache
  if (url.hostname.includes('googleapis.com') ||
      url.hostname.includes('gstatic.com') ||
      url.hostname.includes('firebaseio.com') ||
      url.hostname.includes('telegram.org')) {
    event.respondWith(fetch(event.request));
    return;
  }

  // Fonty — Cache First (rzadko się zmieniają)
  if (url.hostname === 'fonts.googleapis.com' ||
      url.hostname === 'fonts.gstatic.com') {
    event.respondWith(
      caches.match(event.request).then(cached => cached ||
        fetch(event.request).then(res => {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
          return res;
        })
      )
    );
    return;
  }

  // Własne pliki — Network First, fallback na cache gdy offline
  event.respondWith(
    fetch(event.request)
      .then(res => {
        if (res.ok && event.request.method === 'GET') {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
        }
        return res;
      })
      .catch(() => caches.match(event.request)
        .then(cached => cached || caches.match('./index.html'))
      )
  );
});

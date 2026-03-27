// ============================================================
//  SERVICE WORKER — Rodzinny Kalendarz
//  Obsługuje cache statycznych plików i offline fallback.
//  Dane Firebase synchronizują się online przez SDK.
// ============================================================

const CACHE_NAME = 'rodzinny-kalendarz-v3';

// Pliki statyczne do zcachowania przy instalacji
const STATIC_FILES = [
  './',
  './index.html',
  './app.js',
  './firebase-config.js',
  './manifest.json',
  // Fonty Google Fonts są cachowane automatycznie przez przeglądarkę
];

// ============================================================
//  INSTALL — cache statycznych plików
// ============================================================
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(STATIC_FILES))
      .then(() => self.skipWaiting()) // aktywuj od razu
  );
});

// ============================================================
//  ACTIVATE — usuń stare cache
// ============================================================
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

// ============================================================
//  FETCH — strategia: Cache First dla statycznych,
//          Network First dla Firebase (gstatic.com)
// ============================================================
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Firebase SDK i Firestore — zawsze z sieci (real-time sync)
  if (url.hostname.includes('gstatic.com') ||
      url.hostname.includes('googleapis.com') ||
      url.hostname.includes('firebaseio.com')) {
    event.respondWith(fetch(event.request));
    return;
  }

  // Fonty Google Fonts — cache z fallbackiem
  if (url.hostname === 'fonts.googleapis.com' ||
      url.hostname === 'fonts.gstatic.com') {
    event.respondWith(
      caches.match(event.request)
        .then(cached => cached || fetch(event.request).then(response => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          return response;
        }))
    );
    return;
  }

  // Własne pliki statyczne — Cache First
  event.respondWith(
    caches.match(event.request)
      .then(cached => {
        if (cached) return cached;

        return fetch(event.request)
          .then(response => {
            // Cache nowe pliki statyczne
            if (response.ok && event.request.method === 'GET') {
              const clone = response.clone();
              caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
            }
            return response;
          })
          .catch(() => {
            // Offline fallback — zwróć główną stronę
            if (event.request.destination === 'document') {
              return caches.match('./index.html');
            }
          });
      })
  );
});

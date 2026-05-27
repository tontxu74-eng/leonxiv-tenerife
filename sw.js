/* sw.js - Service Worker para soporte offline de la app táctica UAP León XIV */

const CACHE_NAME = 'uap-tactic-tenerife-v1';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&display=swap'
];

// Instalar: cachear recursos pero NO activar automáticamente
// → el SW nuevo espera hasta que el usuario confirme la actualización
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(ASSETS_TO_CACHE))
  );
});

// Activar: limpiar cachés antiguas y tomar control de todas las pestañas
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) =>
      Promise.all(
        cacheNames.map((name) => {
          if (name !== CACHE_NAME) return caches.delete(name);
        })
      )
    ).then(() => self.clients.claim())
  );
});

// Mensaje desde la app: activar el SW nuevo inmediatamente
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

// Interceptar peticiones
self.addEventListener('fetch', (event) => {
  if (!event.request.url.startsWith('http')) return;

  // version.json: SIEMPRE red, nunca caché — es el mecanismo de detección de actualizaciones
  if (event.request.url.includes('version.json')) {
    event.respondWith(fetch(event.request, { cache: 'no-store' }));
    return;
  }

  // En desarrollo local: siempre red primero
  const isLocalhost = self.location.hostname === 'localhost' || self.location.hostname === '127.0.0.1';
  if (isLocalhost) {
    event.respondWith(
      fetch(event.request).catch(() => caches.match(event.request))
    );
    return;
  }

  // En producción: caché primero, red como fallback
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) return cachedResponse;

      return fetch(event.request).then((networkResponse) => {
        if (!networkResponse || networkResponse.status !== 200 || event.request.method !== 'GET') {
          return networkResponse;
        }
        const url = event.request.url;
        if (url.includes('tile.openstreetmap.org') || url.includes('unpkg.com') || url.includes(self.location.origin)) {
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, networkResponse.clone()));
        }
        return networkResponse;
      }).catch(() => caches.match(event.request));
    })
  );
});

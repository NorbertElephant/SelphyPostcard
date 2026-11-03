/* Service worker de Selphy Postcard.
 * - Met en cache les fichiers de l'appli pour un fonctionnement hors ligne.
 * - Reçoit les photos partagées depuis Android (Web Share Target).
 *
 * Pour publier une nouvelle version : incrémenter VERSION, sinon les
 * utilisateurs garderont l'ancienne version en cache.
 */
'use strict';

const VERSION = 'v2';
const APP_CACHE = `selphy-postcard-${VERSION}`;
const SHARE_CACHE = 'selphy-share';        // même nom que dans app.js
const SHARE_KEY = './__shared-photo';      // même clé que dans app.js

// Chemins relatifs : l'appli fonctionne aussi dans un sous-dossier (GitHub Pages).
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(APP_CACHE)
      .then((cache) => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

// Supprime les caches des versions précédentes.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((k) => k !== APP_CACHE && k !== SHARE_CACHE)
        .map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Web Share Target : POST multipart envoyé par Android.
  if (req.method === 'POST' && url.pathname.endsWith('/share-target')) {
    event.respondWith(handleShare(req));
    return;
  }

  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  // Cache d'abord (ignoreSearch pour que ./?shared=1 trouve index.html), réseau en repli.
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => {
      if (hit) return hit;
      return fetch(req).catch(() => {
        if (req.mode === 'navigate') return caches.match('./index.html');
        throw new Error('Hors ligne');
      });
    })
  );
});

/** Range la photo partagée dans le cache puis ouvre l'appli qui la récupérera. */
async function handleShare(request) {
  const appUrl = new URL('./', self.registration.scope);
  try {
    const form = await request.formData();
    const file = form.getAll('photo').find((f) => f && typeof f !== 'string');
    if (file) {
      const cache = await caches.open(SHARE_CACHE);
      await cache.put(SHARE_KEY, new Response(file, {
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
      }));
      appUrl.searchParams.set('shared', '1');
    }
  } catch (e) {
    console.error('Partage reçu illisible', e);
  }
  return Response.redirect(appUrl.href, 303);
}

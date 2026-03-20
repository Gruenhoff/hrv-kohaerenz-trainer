/**
 * Service Worker – HRV Kohärenz-Trainer
 * Ermöglicht Offline-Nutzung (außer Bluetooth-Verbindung)
 */

const CACHE_NAME = 'hrv-trainer-v4';

// Relative Pfade → funktioniert in Root-Deploy und Subdirectory-Deploy (GitHub Pages)
const BASE = self.registration.scope;

const STATIC_ASSETS = [
    BASE,
    BASE + 'index.html',
    BASE + 'css/style.css',
    BASE + 'js/app.js',
    BASE + 'js/bluetooth.js',
    BASE + 'js/hrv.js',
    BASE + 'js/fft.js',
    BASE + 'js/database.js',
    BASE + 'js/visualizer.js',
    BASE + 'js/breathpacer.js',
    BASE + 'js/audio.js',
    BASE + 'js/dashboard.js',
    BASE + 'js/zone2.js',
    BASE + 'js/dfa.js',
    BASE + 'js/resonanz.js',
    BASE + 'manifest.json',
    BASE + 'icons/icon.svg',
];

// Installation: Statische Assets cachen
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.addAll(STATIC_ASSETS).catch((err) => {
                console.warn('[SW] Einige Assets konnten nicht gecacht werden:', err);
            });
        })
    );
    self.skipWaiting();
});

// Aktivierung: Alte Caches löschen
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) => {
            return Promise.all(
                keys
                    .filter((key) => key !== CACHE_NAME)
                    .map((key) => caches.delete(key))
            );
        })
    );
    self.clients.claim();
});

// Fetch: Cache-First für statische Assets, Network-First für externe Ressourcen
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // Chart.js CDN: Network-First mit Cache-Fallback
    if (url.hostname === 'cdn.jsdelivr.net') {
        event.respondWith(
            fetch(event.request)
                .then((response) => {
                    const cloned = response.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(event.request, cloned));
                    return response;
                })
                .catch(() => caches.match(event.request))
        );
        return;
    }

    // Eigene Assets: Cache-First
    if (url.origin === self.location.origin) {
        event.respondWith(
            caches.match(event.request).then((cached) => {
                if (cached) return cached;
                return fetch(event.request).then((response) => {
                    if (response && response.status === 200) {
                        const cloned = response.clone();
                        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, cloned));
                    }
                    return response;
                });
            })
        );
    }
});

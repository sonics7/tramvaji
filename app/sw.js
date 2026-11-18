// Service worker: aplikacija radi i bez mreže (vozni red iz zadnjeg dohvata).
const APP = 'tramvaji-app-v4';
const DATA = 'tramvaji-data';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'config.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-180.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(APP).then(c => c.addAll(SHELL.map(s => new Request(s, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== APP && k !== DATA).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;   // podaci uživo idu ravno na mrežu
  const isData = u.pathname.indexOf('/data/') >= 0;
  // Prvo mreža, a ako je nema, spremljena kopija
  e.respondWith(
    // no-cache: uvijek provjeri kod poslužitelja ima li novije (GitHub inače drži kopiju 10 min)
    fetch(new Request(e.request.url, { cache: 'no-cache', credentials: 'same-origin' })).then(r => {
      if (r.ok) {
        const copy = r.clone();
        const key = isData ? new Request(u.origin + u.pathname) : e.request;   // podatke čuvamo bez ?v=
        caches.open(isData ? DATA : APP).then(c => c.put(key, copy));
      }
      return r;
    }).catch(() => caches.match(isData ? new Request(u.origin + u.pathname) : e.request, { ignoreSearch: !isData }))
  );
});

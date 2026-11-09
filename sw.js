/* Minimal shell cache for Add to Home Screen. No VAPID / no push (plan B). */
const CACHE = "fombot-desk-v1";
const ASSETS = ["./", "./index.html", "./styles.css", "./app.js", "./chart.js", "./links.js", "./manifest.webmanifest"];
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(self.clients.claim());
});
self.addEventListener("fetch", (e) => {
  e.respondWith(
    caches.match(e.request).then((r) => r || fetch(e.request))
  );
});

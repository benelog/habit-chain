// habit-chain service worker
// Caches the static shell so the screen still appears offline.
// BUILD_ID is substituted at deploy time; a new value rebuilds the cache.
const BUILD_ID = "dev";
const CACHE = `habit-chain-${BUILD_ID}`;

// Static assets only.
//
// Never "/" or "/habits": those responses are DoltHub's current contents, and
// caching one would show stale records forever.
const SHELL = [
  "./app.css",
  "./htmx.min.js",
  "./manifest.webmanifest",
  "./icons/icon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Leave data-bearing responses alone; caching one freezes old records.
  if (/^\/(habits|export|api|meta)(\/|$)/.test(url.pathname)) return;

  // Calendar pages: the shell may be cached per URL — its data arrives via
  // fragments, which live under /@db/habits and must stay on the network.
  if (url.pathname.startsWith("/@")) {
    if (req.mode !== "navigate") return;
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  // Navigation to the app shell. Only "/" is cached under "./" — caching
  // whatever page was last visited there would swap the shell for it.
  if (req.mode === "navigate") {
    if (url.pathname !== "/") return;
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put("./", copy));
          return res;
        })
        .catch(() => caches.match("./"))
    );
    return;
  }

  // Everything else static: cache first.
  event.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
      }
      return res;
    }))
  );
});

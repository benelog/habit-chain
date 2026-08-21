// habit-chain service worker
// wasm 번들이 10MB에 가깝기 때문에 캐시가 사실상 필수다.
// BUILD_ID는 배포할 때 치환되며, 값이 바뀌면 캐시를 통째로 새로 만든다.
const BUILD_ID = "dev";
const CACHE = `habit-chain-${BUILD_ID}`;

const SHELL = [
  "./",
  "./index.html",
  "./app.css",
  "./app.wasm",
  "./wasm_exec.js",
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

  // DoltHub·GitHub API 호출은 절대 가로채지 않는다. 항상 실제 네트워크로.
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) {
    return;
  }

  // 화면 진입은 새 버전을 먼저 시도하고, 오프라인이면 캐시로 떨어진다.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match("./index.html"))
    );
    return;
  }

  // 나머지 자산은 캐시 우선. 없으면 받아서 캐시에 넣는다.
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

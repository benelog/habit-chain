// habit-chain service worker
// 정적 껍데기만 캐시해서 오프라인에서도 화면은 뜨게 한다.
// BUILD_ID는 배포할 때 치환되며, 값이 바뀌면 캐시를 통째로 새로 만든다.
const BUILD_ID = "2026-08-21";
const CACHE = `habit-chain-${BUILD_ID}`;

// 정적 자산만 캐시한다.
//
// "/"와 "/habits"는 절대 넣지 않는다. 그 응답은 DoltHub의 현재 내용이라,
// 캐시에 들어가는 순간 영원히 옛 기록을 보여주게 된다.
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

  // 데이터가 실린 응답은 손대지 않는다. 캐시에 들어가면 옛 기록이 굳는다.
  if (/^\/(habits|export|api)(\/|$)/.test(url.pathname)) return;

  // 화면 진입. 껍데기에는 데이터가 없으니 캐시해도 안전하다 —
  // 목록은 껍데기가 뜬 뒤 /habits를 따로 불러 채운다.
  if (req.mode === "navigate") {
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

  // 나머지 정적 자산은 캐시 우선.
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

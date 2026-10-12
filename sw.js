// 앱 파일을 저장해 두고 인터넷 없이도 열리게 하는 서비스워커
/* =====================================================================
   - 앱 파일(같은 주소): 네트워크 우선(브라우저 캐시도 건너뜀) → 고친 내용이 바로 반영, 오프라인이면 저장본 사용
   - 글꼴(Google Fonts): 저장본 우선 → 한 번 받으면 오프라인에서도 같은 글꼴
   - 기록 데이터는 여기가 아니라 localStorage에 있다 (서비스워커와 무관)
   - 앱 파일 목록을 바꾸면 CACHE 이름의 숫자를 올린다
   ===================================================================== */
const CACHE = 'meal-settle-v1';
const APP_FILES = [
  './', './index.html', './style.css', './app.js', './xlsx.js', './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png',
];
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(APP_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (FONT_HOSTS.includes(url.hostname)) {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
      if (res.ok) caches.open(CACHE).then(c => c.put(req, res.clone()));
      return res;
    })));
    return;
  }
  if (url.origin !== location.origin) return;

  // no-cache: 브라우저가 기억한 옛 파일(GitHub Pages는 10분 보관) 대신 매번 서버에 새 버전이 있는지 확인
  e.respondWith(
    fetch(req, { cache: 'no-cache' })
      .then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true })
        .then(hit => hit || (req.mode === 'navigate' ? caches.match('./index.html') : Response.error())))
  );
});

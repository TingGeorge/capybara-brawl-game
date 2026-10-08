// 水豚大亂鬥的 Service Worker：讓遊戲可以「安裝」到主畫面，而且沒網路也能玩單人模式。
// 這是一般的腳本（不是 ES module），所有網址都用相對路徑，放在 GitHub Pages 的子目錄下也能用。
//
// 策略是「網路優先」：有網路就一律拿最新的檔案（在區網裡，網頁一定要跟正在跑的伺服器同一版），
// 拿不到（離線、或超過 4 秒）才用快取。所以改了遊戲程式不需要記得改版本號，
// 只有新增或刪除檔案時，才要更新下面的 PRECACHE（test/pwa.test.js 會檢查有沒有漏）。

const CACHE = 'capybrawl-v1';
const NETWORK_TIMEOUT = 4000;

// 離線玩單人模式需要的所有檔案（相對於這個 sw.js 所在的資料夾）
const PRECACHE = [
  './',
  'index.html',
  'style.css',
  'manifest.webmanifest',
  'js/audio.js',
  'js/client-game.js',
  'js/config.js',
  'js/input.js',
  'js/local-net.js',
  'js/main.js',
  'js/net.js',
  'js/renderer.js',
  'js/sprites.js',
  'js/touch.js',
  'js/ui.js',
  'shared/bot.js',
  'shared/characters.js',
  'shared/constants.js',
  'shared/lobby.js',
  'shared/map.js',
  'shared/match.js',
  'shared/physics.js',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
  'icons/favicon-32.png',
];

// 一律用 scope 當基準，這樣網站放在子目錄（/capybara-brawl-game/）也對
const url = (path) => new URL(path, self.registration.scope).href;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // 全部抓到才算安裝成功；cache: 'reload' 是跳過瀏覽器自己的暫存，確保存的是最新版
      .then((cache) => cache.addAll(PRECACHE.map((p) => new Request(url(p), { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// 先試網路，4 秒內沒回應或失敗就改用快取
function networkFirst(request) {
  return new Promise((resolve) => {
    let settled = false;
    const useCache = () =>
      caches.match(request, { ignoreSearch: true }).then((hit) => {
        if (hit) return hit;
        // 找不到快取的頁面就給首頁（單頁遊戲，只有一個頁面）
        if (request.mode === 'navigate') return caches.match(url('index.html'));
        return undefined;
      });

    const timer = setTimeout(() => {
      useCache().then((hit) => {
        // 快取裡也沒有的話就繼續等網路
        if (hit && !settled) {
          settled = true;
          resolve(hit);
        }
      });
    }, NETWORK_TIMEOUT);

    fetch(request)
      .then((res) => {
        clearTimeout(timer);
        if (res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        if (!settled) {
          settled = true;
          resolve(res);
        }
      })
      .catch(() => {
        clearTimeout(timer);
        useCache().then((hit) => {
          if (settled) return;
          settled = true;
          resolve(hit || Response.error());
        });
      });
  });
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const u = new URL(request.url);
  if (u.origin !== self.location.origin) return;
  // 連線對戰的 WebSocket 不經過這裡，開發用的頁面也不要快取
  const rel = u.pathname.slice(new URL(self.registration.scope).pathname.length);
  if (rel === 'ws' || rel.startsWith('ws/') || rel.startsWith('dev/')) return;
  event.respondWith(networkFirst(request));
});

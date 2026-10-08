// 檢查「安裝到主畫面 / 離線也能玩」需要的檔案都在、都對：
// manifest、圖示、service worker 的快取清單，還有伺服器有沒有用正確的類型送出它們。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const SHARED_DIR = path.join(ROOT, 'shared');
const PORT = 39500 + Math.floor(Math.random() * 500);

// 讀 PNG 檔頭：前 8 個位元組是簽名，接著 IHDR 區塊，寬和高各 4 個位元組（大端序）
function pngSize(file) {
  const buf = fs.readFileSync(file);
  assert.deepEqual([...buf.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], `${file} 不是 PNG`);
  assert.equal(buf.toString('latin1', 12, 16), 'IHDR');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

const manifest = JSON.parse(fs.readFileSync(path.join(PUBLIC_DIR, 'manifest.webmanifest'), 'utf8'));

test('manifest 有安裝需要的欄位，每張圖示都存在、尺寸和宣告的一樣', () => {
  for (const key of ['name', 'short_name', 'start_url', 'display', 'icons']) {
    assert.ok(manifest[key], `manifest 缺少 ${key}`);
  }
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length > 0);
  for (const icon of manifest.icons) {
    const m = /^(\d+)x(\d+)$/.exec(icon.sizes);
    assert.ok(m, `${icon.src} 的 sizes 格式不對：${icon.sizes}`);
    const file = path.join(PUBLIC_DIR, icon.src);
    assert.ok(fs.existsSync(file), `找不到圖示 ${icon.src}`);
    assert.equal(icon.type, 'image/png');
    assert.deepEqual(pngSize(file), { width: Number(m[1]), height: Number(m[2]) }, `${icon.src} 實際尺寸和 sizes 不符`);
  }
  const has = (size, purpose) => manifest.icons.some((i) => i.sizes === size && (i.purpose || 'any').split(/\s+/).includes(purpose));
  assert.ok(has('192x192', 'any'), '需要一張 192x192 的圖示');
  assert.ok(has('512x512', 'any'), '需要一張 512x512 的圖示');
  assert.ok(manifest.icons.some((i) => (i.purpose || '').includes('maskable')), '需要一張 maskable 圖示');
});

test('manifest 的網址都是相對路徑（放在 GitHub Pages 子目錄也能用）', () => {
  for (const key of ['start_url', 'scope', 'id']) {
    if (manifest[key] == null) continue;
    assert.ok(!manifest[key].startsWith('/'), `${key} 不能用 / 開頭：${manifest[key]}`);
  }
  for (const icon of manifest.icons) assert.ok(!icon.src.startsWith('/'), `${icon.src} 不能用 / 開頭`);
});

// 從 sw.js 裡把 PRECACHE 陣列讀出來
function precacheList() {
  const src = fs.readFileSync(path.join(PUBLIC_DIR, 'sw.js'), 'utf8');
  const m = /const PRECACHE = \[([\s\S]*?)\];/.exec(src);
  assert.ok(m, 'sw.js 裡找不到 const PRECACHE = [ ... ];');
  const items = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  assert.ok(items.length > 0, 'PRECACHE 是空的');
  return items;
}

// 快取清單裡的路徑對應到磁碟上的檔案：shared/ 在 repo 根目錄，其他都在 public/
function diskPath(entry) {
  if (entry === './') return path.join(PUBLIC_DIR, 'index.html');
  if (entry.startsWith('shared/')) return path.join(SHARED_DIR, entry.slice('shared/'.length));
  return path.join(PUBLIC_DIR, entry);
}

test('service worker 的快取清單：每個檔案都存在、沒有重複', () => {
  const list = precacheList();
  assert.equal(new Set(list).size, list.length, '快取清單有重複的項目');
  for (const entry of list) {
    assert.ok(fs.existsSync(diskPath(entry)), `快取清單裡的 ${entry} 不存在`);
    assert.ok(!entry.startsWith('/') && !entry.startsWith('dev/'), `${entry} 不該放進快取清單`);
  }
});

test('public/js 和 shared 的每個 .js 都在快取清單裡（新增檔案不會漏掉）', () => {
  const list = new Set(precacheList());
  const expected = [
    ...fs.readdirSync(path.join(PUBLIC_DIR, 'js')).filter((f) => f.endsWith('.js')).map((f) => `js/${f}`),
    ...fs.readdirSync(SHARED_DIR).filter((f) => f.endsWith('.js')).map((f) => `shared/${f}`),
  ];
  assert.ok(expected.length > 0);
  for (const e of expected) assert.ok(list.has(e), `${e} 沒有放進 public/sw.js 的 PRECACHE，離線時會缺檔案`);
  for (const e of ['./', 'index.html', 'style.css', 'manifest.webmanifest']) {
    assert.ok(list.has(e), `PRECACHE 缺少 ${e}`);
  }
});

test('index.html 引用的 manifest、圖示都存在', () => {
  const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  const hrefOf = (re, what) => {
    const m = re.exec(html);
    assert.ok(m, `index.html 沒有 ${what}`);
    return m[1];
  };
  const refs = [
    hrefOf(/<link[^>]*rel="manifest"[^>]*href="([^"]+)"/, 'manifest 連結'),
    hrefOf(/<link[^>]*rel="apple-touch-icon"[^>]*href="([^"]+)"/, 'apple-touch-icon'),
    hrefOf(/<link[^>]*rel="icon"[^>]*href="([^"]+)"/, 'favicon'),
  ];
  for (const ref of refs) {
    assert.ok(!ref.startsWith('/'), `${ref} 要用相對路徑`);
    assert.ok(fs.existsSync(path.join(PUBLIC_DIR, ref)), `index.html 引用的 ${ref} 不存在`);
  }
  assert.deepEqual(pngSize(path.join(PUBLIC_DIR, 'icons/apple-touch-icon.png')), { width: 180, height: 180 });
  assert.deepEqual(pngSize(path.join(PUBLIC_DIR, 'icons/favicon-32.png')), { width: 32, height: 32 });
});

test('伺服器用正確的類型送出 manifest、service worker 和圖示', async () => {
  const { server, stop } = startServer(PORT, { quiet: true });
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const base = `http://127.0.0.1:${PORT}`;

    const man = await fetch(`${base}/manifest.webmanifest`);
    assert.equal(man.status, 200);
    assert.ok(man.headers.get('content-type').includes('application/manifest+json'), man.headers.get('content-type'));
    assert.equal((await man.json()).short_name, manifest.short_name);

    const sw = await fetch(`${base}/sw.js`);
    assert.equal(sw.status, 200);
    assert.ok(sw.headers.get('content-type').includes('javascript'), sw.headers.get('content-type'));
    assert.ok((await sw.text()).includes('PRECACHE'));

    const icon = await fetch(`${base}/icons/icon-192.png`);
    assert.equal(icon.status, 200);
    assert.equal(icon.headers.get('content-type'), 'image/png');
  } finally {
    stop();
  }
});

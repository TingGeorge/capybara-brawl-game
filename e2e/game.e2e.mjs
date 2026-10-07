// 瀏覽器實玩測試：真的開瀏覽器、連到真的伺服器，模擬玩家操作。
// 執行：npm install --no-save playwright && npx playwright install chromium && npm run test:e2e
// 換瀏覽器：BROWSER=firefox 或 BROWSER=webkit（Safari 的核心）
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server/index.js';

const require = createRequire(import.meta.url);
const playwright = require('playwright');

const BROWSER = process.env.BROWSER || 'chromium';
const ARTIFACTS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'artifacts');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let browser;
let nextPort = 41000 + Math.floor(Math.random() * 1000);

before(async () => {
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  browser = await playwright[BROWSER].launch();
});
after(async () => {
  await browser?.close();
});

// 每個測試開一台自己的伺服器，互不干擾
async function server(options = {}) {
  const port = nextPort++;
  const srv = startServer(port, { quiet: true, ...options });
  await new Promise((r) => (srv.server.listening ? r() : srv.server.once('listening', r)));
  return { ...srv, url: `http://127.0.0.1:${port}` };
}

// 開一個玩家的瀏覽器分頁。會把 main.js 裡的 game 物件露出來給測試讀（不影響遊戲本身）
async function player(t, url, name, { join = true, latency = 0 } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`[${name}] ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`[${name}] ${e.message}`));
  await page.route('**/js/main.js', async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, body: `${await res.text()}\nwindow.__game = () => game;\n` });
  });
  if (latency) await page.addInitScript(addLatency, latency);
  await page.goto(url);
  if (join) await joinAs(page, name);
  t.after(async () => {
    // 留一張最後的畫面，CI 失敗時可以下載來看
    await page.screenshot({ path: path.join(ARTIFACTS, `${BROWSER}-${name}.png`) }).catch(() => {});
    await ctx.close();
  });
  return { page, errors };
}

async function joinAs(page, name) {
  await page.fill('#join-name', name);
  await page.click('#join-btn');
  await waitScreen(page, 'screen-lobby');
}

const screenOf = (page) => page.evaluate(() => document.body.dataset.screen);

async function waitScreen(page, screen, timeout = 10000) {
  await page.waitForFunction((s) => document.body.dataset.screen === s, screen, { timeout });
}

async function pick(page, charName) {
  await page.locator('#char-grid').getByText(charName, { exact: true }).first().click();
}

async function waitPlaying(page) {
  await page.waitForFunction(() => {
    const g = window.__game && window.__game();
    return g && g.latest && g.latest.ph === 'playing';
  }, null, { timeout: 15000 });
}

const myState = (page) => page.evaluate(() => {
  const g = window.__game();
  const shown = g.myDisplayPos();
  return { x: shown.x, y: shown.y, sx: g.mySnap.x, sy: g.mySnap.y, ammo: g.mySnap.am, pending: g.pending.length };
});

// 在瀏覽器裡模擬網路延遲：每個訊息延後 base～1.5×base 毫秒。
// 真實的 WebSocket（TCP）不會打亂訊息順序，所以這裡用佇列確保先送的先到。
function addLatency(base) {
  const Native = window.WebSocket;
  const delayedQueue = (deliver) => {
    const queue = [];
    let last = 0;
    let timer = null;
    const pump = () => {
      timer = null;
      while (queue.length && queue[0].at <= performance.now()) deliver(queue.shift().data);
      if (queue.length) timer = setTimeout(pump, queue[0].at - performance.now());
    };
    return (data) => {
      last = Math.max(last, performance.now() + base + Math.random() * base * 0.5);
      queue.push({ at: last, data });
      if (!timer) timer = setTimeout(pump, queue[0].at - performance.now());
    };
  };
  window.WebSocket = class extends Native {
    constructor(...args) {
      super(...args);
      const nativeSend = this.send.bind(this);
      this.send = delayedQueue((data) => this.readyState === 1 && nativeSend(data));
      const receive = delayedQueue((data) => this._onmessage && this._onmessage(new MessageEvent('message', { data })));
      this.addEventListener('message', (ev) => receive(ev.data));
    }
    set onmessage(fn) {
      this._onmessage = fn;
    }
    get onmessage() {
      return this._onmessage;
    }
  };
}

function noErrors(...players) {
  const all = players.flatMap((p) => p.errors);
  assert.deepEqual(all, [], `瀏覽器裡出現錯誤：\n${all.join('\n')}`);
}

// ---------------------------------------------------------------------------

test('兩個人連線對戰：開局、移動、攻擊，兩邊畫面同步', async (t) => {
  const srv = await server();
  t.after(() => srv.stop());
  const a = await player(t, srv.url, '小明');
  const b = await player(t, srv.url, '小華');
  await pick(a.page, '蘿蔔丁');
  await pick(b.page, '香蕉武士');
  await sleep(300);

  // 不是房主的人看不到開始按鈕
  assert.equal(await b.page.isVisible('#btn-start'), false);
  await a.page.click('#btn-start');
  await waitScreen(a.page, 'hud');
  await waitScreen(b.page, 'hud');
  await waitPlaying(a.page);

  // 往右走 1 秒：畫面上的位置和伺服器的位置都要動，而且最後要一致
  const before = await myState(a.page);
  await a.page.keyboard.down('KeyD');
  await sleep(1000);
  await a.page.keyboard.up('KeyD');
  await sleep(400);
  const moved = await myState(a.page);
  assert.ok(moved.x - before.x > 25, `畫面上要往右移動：${before.x} → ${moved.x}`);
  assert.ok(moved.sx - before.sx > 25, `伺服器上要往右移動：${before.sx} → ${moved.sx}`);
  assert.ok(Math.abs(moved.x - moved.sx) < 1, `停下來後畫面和伺服器的位置要一致：${moved.x} vs ${moved.sx}`);

  // 另一個玩家也看得到小明移動了
  const seenByB = await b.page.evaluate((id) => {
    const g = window.__game();
    return g.latest.p.find((p) => p.i === id).x;
  }, await a.page.evaluate(() => window.__game().myId));
  assert.ok(Math.abs(seenByB - moved.sx) < 2, `小華看到的位置要和伺服器一樣：${seenByB} vs ${moved.sx}`);

  // 開槍會用掉彈藥
  await a.page.mouse.move(1000, 384);
  await a.page.mouse.down();
  await sleep(80);
  await a.page.mouse.up();
  await sleep(500);
  assert.ok((await myState(a.page)).ammo < 2.9, '攻擊後彈藥要變少');

  // Tab 計分板
  await a.page.keyboard.down('Tab');
  await sleep(200);
  assert.equal(await a.page.isVisible('#scoreboard'), true);
  await a.page.keyboard.up('Tab');

  noErrors(a, b);
});

test('網路有延遲時，自己的水豚不會被拉來拉去', async (t) => {
  const srv = await server();
  t.after(() => srv.stop());
  const a = await player(t, srv.url, '延遲', { latency: 60 });
  await a.page.click('#btn-start');
  await waitPlaying(a.page);
  await sleep(300);

  // 一邊走一邊記錄「預測位置被伺服器校正」的幅度
  await a.page.evaluate(() => {
    window.__maxFix = 0;
    const g = window.__game();
    const original = g.reconcile.bind(g);
    g.reconcile = (s) => {
      const before = g.myDisplayPos();
      original(s);
      const after = g.pred ? { x: g.pred.x, y: g.pred.y } : before;
      if (before && after) window.__maxFix = Math.max(window.__maxFix, Math.hypot(before.x - after.x, before.y - after.y));
    };
  });
  for (const keys of [['KeyD'], ['KeyD', 'KeyS'], ['KeyS'], ['KeyA', 'KeyS'], ['KeyW'], ['KeyD', 'KeyW']]) {
    for (const k of keys) await a.page.keyboard.down(k);
    await sleep(450);
    for (const k of keys) await a.page.keyboard.up(k);
  }
  await sleep(500);
  const maxFix = await a.page.evaluate(() => window.__maxFix);
  const s = await myState(a.page);
  assert.ok(maxFix < 0.5, `預測和伺服器結果應該一致，最大校正 ${maxFix.toFixed(2)} 像素`);
  assert.ok(Math.abs(s.x - s.sx) < 1 && Math.abs(s.y - s.sy) < 1, '停下來後位置要一致');
  noErrors(a);
});

test('比賽中加入的人會變成觀戰，下一場就能一起玩', async (t) => {
  const srv = await server({ duration: 6 });
  t.after(() => srv.stop());
  const a = await player(t, srv.url, '房主');
  await a.page.click('#btn-start');
  await waitPlaying(a.page);

  const c = await player(t, srv.url, '晚到', { join: false });
  await c.page.fill('#join-name', '晚到');
  await c.page.click('#join-btn');
  await waitScreen(c.page, 'hud');
  assert.equal(await c.page.isVisible('#hud-spectator'), true, '要顯示觀戰中');
  await c.page.waitForFunction(() => window.__game().latest !== null);
  assert.equal(await c.page.evaluate(() => window.__game().me), null);

  // 比賽結束 → 結算 → 回大廳，兩個人都在名單上
  await waitScreen(a.page, 'screen-result', 20000);
  await waitScreen(a.page, 'screen-lobby', 15000);
  await waitScreen(c.page, 'screen-lobby', 5000);
  assert.equal(await a.page.locator('#team-blue-slots, #team-red-slots').getByText('晚到').count(), 1);

  // 第二場：晚到的人這次是玩家
  await a.page.click('#btn-start');
  await waitScreen(c.page, 'hud');
  await c.page.waitForFunction(() => window.__game().me !== null);
  assert.equal(await c.page.isVisible('#hud-spectator'), false);
  noErrors(a, c);
});

test('房間最多 6 個人，第 7 個人會看到提示', async (t) => {
  const srv = await server();
  t.after(() => srv.stop());
  const ws = [];
  for (let i = 0; i < 6; i++) {
    const w = new WebSocket(`${srv.url.replace('http', 'ws')}/ws`);
    await new Promise((r) => w.addEventListener('open', r));
    w.send(JSON.stringify({ t: 'hello', name: `佔位${i}` }));
    ws.push(w);
  }
  t.after(() => ws.forEach((w) => w.close()));
  await sleep(300);
  const late = await player(t, srv.url, '第七人', { join: false });
  await late.page.fill('#join-name', '第七人');
  await late.page.click('#join-btn');
  await late.page.waitForFunction(() => document.querySelector('#join-error').textContent.includes('滿'));
  assert.equal(await screenOf(late.page), 'screen-join');
});

test('奇怪的名字只會被當成文字，不會變成網頁程式', async (t) => {
  const srv = await server();
  t.after(() => srv.stop());
  const evil = '<img src=x onerror="window.__xss=1">';
  const a = await player(t, srv.url, '正常人');
  const b = await player(t, srv.url, 'tmp', { join: false });
  await b.page.fill('#join-name', evil.slice(0, 10));
  await b.page.click('#join-btn');
  await waitScreen(b.page, 'screen-lobby');
  // 直接用 WebSocket 塞一個完整的惡意名字（繞過輸入框長度限制）
  const w = new WebSocket(`${srv.url.replace('http', 'ws')}/ws`);
  await new Promise((r) => w.addEventListener('open', r));
  w.send(JSON.stringify({ t: 'hello', name: evil }));
  t.after(() => w.close());
  await sleep(600);
  for (const p of [a, b]) {
    assert.equal(await p.page.evaluate(() => window.__xss), undefined, '名字不能被當成 HTML 執行');
    assert.equal(await p.page.locator('#screen-lobby img[src="x"]').count(), 0);
  }
  noErrors(a, b);
});

test('伺服器關掉時，畫面會提示連線中斷', async (t) => {
  const srv = await server();
  const a = await player(t, srv.url, '斷線');
  srv.stop();
  await waitScreen(a.page, 'screen-disconnected');
});

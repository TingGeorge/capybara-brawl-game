// 瀏覽器實玩測試：真的開瀏覽器、連到真的伺服器，模擬玩家操作。
// 執行：npm install --no-save playwright && npx playwright install chromium && npm run test:e2e
// 換瀏覽器：BROWSER=firefox 或 BROWSER=webkit（Safari 的核心）
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server/index.js';
import { buildStatic } from '../scripts/build-static.mjs';

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
// context 可以換掉瀏覽器環境（例如手機的螢幕大小和觸控）
async function player(t, url, name, { join = true, latency = 0, context = {} } = {}) {
  // 不讓網頁註冊 service worker：被 service worker 接手的請求，page.route 改不到，
  // 重新整理後就拿不到下面塞進 main.js 的 window.__game（離線測試另外開自己的 context）
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 }, serviceWorkers: 'block', ...context });
  if (context.hasTouch) await ctx.addInitScript(stayWindowed);
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
    // 比較收到伺服器結果前後的「預測位置」：預測得準，校正量就是 0
    // （畫面上的位置會在兩個固定步之間內插，所以不拿它來比）
    g.reconcile = (s) => {
      const before = g.pred ? { x: g.pred.x, y: g.pred.y } : null;
      original(s);
      const after = g.pred;
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

// ---------------------------------------------------------------------------
// 手機（觸控）和純靜態網站（GitHub Pages）
// 手機測試一律用 tap / 觸控事件；用 click() 會變成滑鼠，遊戲會切回滑鼠模式把觸控按鈕藏起來。

// 手機上按「單人對戰」會切成全螢幕。真的手機全螢幕還是手機的大小，
// 但無頭的 Firefox 全螢幕會把視窗撐成電腦螢幕的 1366x768，手機版面就測不到了，所以測試時不切全螢幕
function stayWindowed() {
  Element.prototype.requestFullscreen = () => Promise.resolve();
}

// 手機的瀏覽器環境。isMobile 在 Firefox 不支援，其他兩種才傳
const phoneContext = (width, height) => ({
  viewport: { width, height },
  hasTouch: true,
  deviceScaleFactor: 2,
  ...(BROWSER === 'firefox' ? {} : { isMobile: true }),
});

// 在某個元素上送出一個模擬的手指事件（pointerType: touch）。
// 遊戲的觸控程式聽的是 pointer 事件；多指時每根手指用不同的 id
function pointer(page, selector, type, id, x, y) {
  return page.evaluate(([sel, kind, pid, cx, cy]) => {
    document.querySelector(sel).dispatchEvent(new PointerEvent(kind, {
      pointerId: pid, pointerType: 'touch', isPrimary: true, clientX: cx, clientY: cy, bubbles: true, cancelable: true,
    }));
  }, [selector, type, id, x, y]);
}

async function centerOf(page, selector) {
  const box = await page.locator(selector).boundingBox();
  assert.ok(box, `${selector} 要看得到`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

// 標題畫面 → 單人大廳 → 開打（全部用手指點）
async function soloLobby(page, name) {
  await page.fill('#join-name', name);
  await page.tap('#solo-btn');
  await waitScreen(page, 'screen-lobby');
}

async function soloMatch(page, name) {
  await soloLobby(page, name);
  await page.tap('#btn-start');
  await waitScreen(page, 'hud');
}

// 記下遊戲送出去的攻擊 / 大招訊息（window.__sent），可以檢查瞄準的角度
function recordShots(page) {
  return page.evaluate(() => {
    const g = window.__game();
    const send = g.net.send.bind(g.net);
    window.__sent = [];
    g.net.send = (o) => {
      if (o.t === 'atk' || o.t === 'sup') window.__sent.push(o);
      send(o);
    };
  });
}

const waitShots = (page, n) => page.waitForFunction((count) => window.__sent.length >= count, n, { timeout: 5000 });

// 攻擊鈕和大招鈕不能疊在一起：把攻擊鈕的圓鈕往大招鈕的方向拖到最遠，兩個圓也不能碰到
async function assertAttackClearOfSuper(page) {
  const circle = async (sel) => {
    const b = await page.locator(sel).boundingBox();
    assert.ok(b, `${sel} 要看得到`);
    return { x: b.x + b.width / 2, y: b.y + b.height / 2, r: b.width / 2 };
  };
  const atk = await circle('#touch-attack');
  const sup = await circle('#hud-super');
  const gap = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) - a.r - b.r;
  assert.ok(gap(atk, sup) > 8, `攻擊鈕和大招鈕要分開：間隔 ${gap(atk, sup).toFixed(1)}px`);
  const dx = sup.x - atk.x;
  const dy = sup.y - atk.y;
  const len = Math.hypot(dx, dy);
  await pointer(page, '#touch-attack', 'pointerdown', 21, atk.x, atk.y);
  await pointer(page, '#touch-attack', 'pointermove', 21, atk.x + (dx / len) * 300, atk.y + (dy / len) * 300);
  const knob = await circle('#touch-attack .stick-knob');
  await pointer(page, '#touch-attack', 'pointercancel', 21, atk.x, atk.y);
  assert.ok(gap(knob, sup) > 0, `攻擊鈕拖到最遠時不能蓋到大招鈕：間隔 ${gap(knob, sup).toFixed(1)}px`);
}

// 畫面上有沒有橫向超出螢幕的東西
function overflowOf(page) {
  return page.evaluate(() => {
    const bad = [];
    const doc = document.scrollingElement;
    if (doc.scrollWidth > innerWidth) bad.push(`整個頁面 scrollWidth ${doc.scrollWidth} > ${innerWidth}`);
    for (const s of document.querySelectorAll('.screen')) {
      if (!s.hidden && s.scrollWidth > s.clientWidth) bad.push(`#${s.id} scrollWidth ${s.scrollWidth} > clientWidth ${s.clientWidth}`);
    }
    return bad;
  });
}

test('手機橫拿：單人模式用手指玩', async (t) => {
  const srv = await server();
  t.after(() => srv.stop());
  const p = await player(t, srv.url, '手機', { join: false, context: phoneContext(844, 390) });
  const { page } = p;

  // 標題 → 單人大廳
  assert.equal(await page.isVisible('#join-btn'), true, '有伺服器的時候也要能連線對戰');
  assert.equal(await page.isVisible('#solo-btn'), true);
  await soloLobby(page, '手機');
  assert.equal(await page.isVisible('#btn-leave'), true);
  assert.equal(await page.isVisible('#bots-label'), false, '單人模式不用勾電腦補位');
  assert.match(await page.textContent('#share-urls'), /單人模式/);
  assert.equal(await page.evaluate(() => document.body.classList.contains('touch')), true, '用手指點之後要是觸控模式');
  await page.locator('#char-grid').getByText('蘿蔔丁', { exact: true }).first().tap();

  // 開打：觸控按鈕要出現
  await page.tap('#btn-start');
  await waitScreen(page, 'hud');
  for (const sel of ['#touch-ui', '#touch-zone', '#touch-attack', '#hud-super', '#hud-btn-score', '#hud-btn-mute', '#hud-btn-leave']) {
    assert.equal(await page.isVisible(sel), true, `${sel} 在手機上要看得到`);
  }
  await waitPlaying(page);
  await assertAttackClearOfSuper(page);
  await recordShots(page);

  // 手指實際點得到的是搖桿區和攻擊鈕，沒有被別的東西蓋住
  const zone = await page.locator('#touch-zone').boundingBox();
  const start = { x: zone.x + zone.width * 0.3, y: zone.y + zone.height * 0.6 };
  const atk = await centerOf(page, '#touch-attack');
  assert.equal(await page.evaluate(([x, y]) => document.elementFromPoint(x, y).id, [start.x, start.y]), 'touch-zone');
  assert.equal(await page.evaluate(([x, y]) => !!document.elementFromPoint(x, y).closest('#touch-attack'), [atk.x, atk.y]), true);

  // 搖桿往右推 0.8 秒：畫面和伺服器上的位置都要往右移動
  const before = await myState(page);
  await pointer(page, '#touch-zone', 'pointerdown', 7, start.x, start.y);
  for (let i = 1; i <= 5; i++) {
    await pointer(page, '#touch-zone', 'pointermove', 7, start.x + i * 16, start.y);
    await sleep(20);
  }
  await sleep(800);
  const held = await page.evaluate(() => ({
    x: window.__game().input.stickX,
    y: window.__game().input.stickY,
    active: document.querySelector('#touch-stick').classList.contains('active'),
  }));
  assert.ok(held.active, '按住時搖桿要亮起來');
  assert.ok(held.x > 0.99 && Math.abs(held.y) < 0.01, `搖桿要指向右邊：${held.x}, ${held.y}`);
  await pointer(page, '#touch-zone', 'pointerup', 7, start.x + 80, start.y);
  await sleep(400);
  const moved = await myState(page);
  assert.ok(moved.x - before.x > 20, `畫面上要往右移動：${before.x} → ${moved.x}`);
  assert.ok(moved.sx - before.sx > 20, `伺服器上要往右移動：${before.sx} → ${moved.sx}`);
  assert.ok(Math.abs(moved.x - moved.sx) < 1, `停下來後畫面和伺服器的位置要一致：${moved.x} vs ${moved.sx}`);
  assert.equal(await page.evaluate(() => window.__game().input.stickX), 0, '放開後搖桿要歸零');

  // 點一下攻擊鈕（真的觸控點擊）：自動瞄準並開槍，彈藥減少
  assert.ok(moved.ammo > 2.9, `開槍前彈藥應該是滿的：${moved.ammo}`);
  await page.touchscreen.tap(atk.x, atk.y);
  await waitShots(page, 1);
  await page.waitForFunction(() => window.__game().mySnap.am < 2.9, null, { timeout: 3000 });

  // 拖曳攻擊鈕往正上方瞄準：瞄準線指向上方，放開才發射
  await sleep(600);
  const ammoBefore = (await myState(page)).ammo;
  await pointer(page, '#touch-attack', 'pointerdown', 9, atk.x, atk.y);
  await pointer(page, '#touch-attack', 'pointermove', 9, atk.x, atk.y - 70);
  await sleep(150);
  const aiming = await page.evaluate(() => ({ aim: window.__game().aim, touchAim: window.__game().input.touchAim, sent: window.__sent.length }));
  assert.ok(Math.abs(aiming.aim + Math.PI / 2) < 0.05, `要瞄準正上方（-π/2）：${aiming.aim}`);
  assert.ok(aiming.touchAim && !aiming.touchAim.super);
  assert.equal(aiming.sent, 1, '還沒放開，不能發射');
  await pointer(page, '#touch-attack', 'pointerup', 9, atk.x, atk.y - 70);
  await waitShots(page, 2);
  const shot = await page.evaluate(() => window.__sent[1]);
  assert.equal(shot.t, 'atk');
  assert.ok(Math.abs(shot.a + Math.PI / 2) < 0.05, `發射的角度要是正上方：${shot.a}`);
  await page.waitForFunction((a) => window.__game().mySnap.am < a - 0.5, ammoBefore, { timeout: 3000 });
  assert.equal(await page.evaluate(() => window.__game().input.touchAim), null, '放開後要清掉瞄準');

  // 計分板按鈕：點一下打開、再點一下關起來
  await page.tap('#hud-btn-score');
  await page.locator('#scoreboard').waitFor({ state: 'visible', timeout: 3000 });
  await page.tap('#hud-btn-score');
  await page.locator('#scoreboard').waitFor({ state: 'hidden', timeout: 3000 });

  // 離開：要連點兩次才會離開
  await page.tap('#hud-btn-leave');
  assert.equal(await screenOf(page), 'hud', '只點一次不能離開');
  assert.match(await page.textContent('#hud-btn-leave'), /再按一次/);
  await page.tap('#hud-btn-leave');
  await waitScreen(page, 'screen-join', 5000);
  noErrors(p);
});

test('手機直拿：版面不會超出螢幕', async (t) => {
  const srv = await server();
  t.after(() => srv.stop());
  const p = await player(t, srv.url, '直拿', { join: false, context: phoneContext(390, 844) });
  const { page } = p;
  const noOverflow = async (what) => {
    await sleep(300);
    assert.deepEqual(await overflowOf(page), [], `${what}：有東西橫向超出螢幕`);
  };

  await noOverflow('標題畫面');
  await soloLobby(page, '直拿');
  assert.equal(await page.evaluate(() => innerWidth), 390, '畫面寬度要維持手機直拿的 390');
  await noOverflow('大廳');

  // 一欄式的大廳可以往下捲，但「開始對戰」一定要捲得到、而且完整在螢幕內
  const startBtn = page.locator('#btn-start');
  await startBtn.scrollIntoViewIfNeeded();
  assert.equal(await startBtn.isVisible(), true);
  const box = await startBtn.boundingBox();
  const view = page.viewportSize();
  assert.ok(box.x >= 0 && box.x + box.width <= view.width, `按鈕左右要在螢幕內：${JSON.stringify(box)}`);
  assert.ok(box.y >= 0 && box.y + box.height <= view.height, `按鈕上下要在螢幕內：${JSON.stringify(box)}`);
  await noOverflow('大廳（捲到最下面）');

  await startBtn.tap();
  await waitScreen(page, 'hud');
  await noOverflow('對戰畫面');
  await waitPlaying(page);
  await assertAttackClearOfSuper(page);
  noErrors(p);
});

test('有動態島的 iPhone 橫拿：畫面放大、地圖邊緣和自己不會被擋住', { skip: BROWSER !== 'chromium' && '只有 Chromium 能模擬瀏海安全區' }, async (t) => {
  const srv = await server();
  t.after(() => srv.stop());
  // iPhone 15 Pro 橫拿：852x393、3 倍螢幕，左右各 59px 是動態島的安全區，底下 21px 是橫條
  const p = await player(t, srv.url, '島', { join: false, context: { ...phoneContext(852, 393), deviceScaleFactor: 3 } });
  const { page } = p;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 0, left: 59, right: 59, bottom: 21 } });
  await page.route('**/js/main.js', async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, body: `${await res.text()}\nwindow.__game = () => game;\nwindow.__renderer = renderer;\n` });
  });
  // 上次選的是最後一隻（泡湯長老）：手機橫拿時角色排成一列，進大廳要自動捲到看得到它
  await page.evaluate(() => localStorage.setItem('capybrawl.char', 'onsen'));
  await page.reload();
  await soloLobby(page, '島');
  await sleep(300);
  const pick = await page.evaluate(() => {
    const grid = document.querySelector('#char-grid').getBoundingClientRect();
    const card = document.querySelector('#char-grid .char-card.selected');
    const c = card.getBoundingClientRect();
    return { id: card.dataset.id, inside: c.left >= grid.left - 1 && c.right <= grid.right + 1, scrolls: document.querySelector('#char-grid').scrollWidth > grid.width + 1 };
  });
  assert.equal(pick.id, 'onsen');
  assert.ok(pick.scrolls, '手機橫拿時角色要排成可以左右滑的一列');
  assert.ok(pick.inside, '選到的角色要捲到看得到的地方');
  await page.tap('#btn-start');
  await waitScreen(page, 'hud');
  await waitPlaying(page);
  await sleep(300);

  const view = await page.evaluate(() => {
    const r = window.__renderer;
    const me = window.__game().myDisplayPos();
    const canvas = document.getElementById('game').getBoundingClientRect();
    return {
      canvasLeft: canvas.left,
      canvasRight: innerWidth - canvas.right,
      bodyBg: getComputedStyle(document.body).backgroundColor,
      viewW: r.W / r.Z,
      // 自己的水豚、地圖左邊的牆在螢幕上的 x（CSS 像素）
      meX: canvas.left + ((me.x - r.cam.left) * r.Z) / r.dpr,
      wallX: canvas.left + ((0 - r.cam.left) * r.Z) / r.dpr,
      killfeedTop: document.querySelector('#killfeed').getBoundingClientRect().top,
      scorebarBottom: document.querySelector('#hud-scorebar').getBoundingClientRect().bottom,
    };
  });
  // 左右兩邊的安全區都塗黑，遊戲畫面只畫在中間
  assert.equal(view.canvasLeft, 59, '遊戲畫面左邊要讓開安全區');
  assert.equal(view.canvasRight, 59, '遊戲畫面右邊也要讓開安全區（兩邊對稱）');
  assert.equal(view.bodyBg, 'rgb(0, 0, 0)', '兩邊讓出來的地方是黑色');
  assert.ok(view.viewW <= 440, `手機要放大：畫面寬只看得到約 360～440 世界像素，現在是 ${view.viewW}`);
  assert.ok(view.wallX >= 59 - 1, `地圖左邊的牆不能跑到動態島底下：x=${view.wallX}`);
  assert.ok(view.meX >= 59 + 10, `出生點的自己要在動態島右邊：x=${view.meX}`);
  assert.ok(view.killfeedTop >= view.scorebarBottom, `擊倒訊息不能蓋到比分條：${view.killfeedTop} < ${view.scorebarBottom}`);

  // 介面也要躲開動態島
  const tools = await page.locator('.hud-tools').boundingBox();
  assert.ok(tools.x >= 59, `左上角的按鈕要在安全區裡：x=${tools.x}`);
  noErrors(p);
});

test('背景音樂：點畫面後開始播，大廳和對戰換歌，靜音就停', { skip: BROWSER !== 'chromium' && '各瀏覽器的自動播放規則不同，只在 Chromium 量聲音' }, async (t) => {
  const srv = await server();
  t.after(() => srv.stop());
  const p = await player(t, srv.url, '音樂', { join: false });
  const { page } = p;
  // 算有幾個聲音被播出來（音效和音樂都是即時合成的振盪器）
  await page.addInitScript(() => {
    window.__notes = 0;
    const start = OscillatorNode.prototype.start;
    OscillatorNode.prototype.start = function (...args) {
      window.__notes++;
      return start.apply(this, args);
    };
  });
  await page.route('**/js/main.js', async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, body: `${await res.text()}\nwindow.__game = () => game;\nwindow.__audio = audio;\n` });
  });
  await page.reload();
  const notesIn = async (ms) => {
    const before = await page.evaluate(() => window.__notes);
    await sleep(ms);
    return (await page.evaluate(() => window.__notes)) - before;
  };

  // 還沒點過畫面：瀏覽器不准自動播放，所以一個聲音都沒有
  assert.equal(await page.evaluate(() => window.__notes), 0);

  // 點了之後：大廳播輕鬆的音樂
  await page.fill('#join-name', '音樂');
  await page.click('#solo-btn');
  await waitScreen(page, 'screen-lobby');
  await sleep(300);
  assert.equal(await page.evaluate(() => window.__audio.song), 'menu');
  assert.ok((await notesIn(1500)) >= 10, '大廳要有背景音樂');

  // 開打：換成對戰的音樂
  await page.click('#btn-start');
  await waitPlaying(page);
  assert.equal(await page.evaluate(() => window.__audio.song), 'battle');
  assert.ok((await notesIn(1000)) >= 10, '對戰要有背景音樂');

  // 按 M 靜音：音樂和音效都停，再按一次又有聲音
  await page.keyboard.press('KeyM');
  await sleep(300);
  assert.equal(await page.evaluate(() => window.__audio.muted), true);
  assert.equal(await notesIn(1000), 0, '靜音後不能再出聲');
  await page.keyboard.press('KeyM');
  assert.ok((await notesIn(1000)) >= 10, '取消靜音後音樂要繼續');
  noErrors(p);
});

test('兩隻手指同時：一邊走一邊瞄準', { skip: BROWSER !== 'chromium' && '只有 Chromium 能用 CDP 模擬多指觸控' }, async (t) => {
  const srv = await server();
  t.after(() => srv.stop());
  const p = await player(t, srv.url, '雙指', { join: false, context: phoneContext(844, 390) });
  const { page } = p;
  await soloMatch(page, '雙指');
  await waitPlaying(page);
  await recordShots(page);

  const cdp = await page.context().newCDPSession(page);
  const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points });
  const zone = await page.locator('#touch-zone').boundingBox();
  const atk = await centerOf(page, '#touch-attack');
  const left = { x: zone.x + zone.width * 0.3, y: zone.y + zone.height * 0.6, id: 1 };
  const right = { x: atk.x, y: atk.y, id: 2 };

  const before = await myState(page);
  // 左手指放下、往右拖；右手指再放到攻擊鈕上、往上拖
  await touch('touchStart', [left]);
  await touch('touchMove', [{ ...left, x: left.x + 80 }]);
  await touch('touchStart', [{ ...left, x: left.x + 80 }, right]);
  await touch('touchMove', [{ ...left, x: left.x + 80 }, { ...right, y: right.y - 70 }]);
  await sleep(800);

  const both = await page.evaluate(() => {
    const g = window.__game();
    return { stickX: g.input.stickX, stickY: g.input.stickY, touchAim: g.input.touchAim, sent: window.__sent.length, mode: g.input.mode };
  });
  assert.equal(both.mode, 'touch');
  assert.ok(both.stickX > 0.99, `左手指要讓角色往右走：${both.stickX}`);
  assert.ok(both.touchAim && Math.abs(both.touchAim.angle + Math.PI / 2) < 0.05, `右手指要瞄準正上方：${JSON.stringify(both.touchAim)}`);
  assert.equal(both.sent, 0, '右手指還沒放開，不能發射');
  const walking = await myState(page);
  assert.ok(walking.x - before.x > 20, `邊瞄準邊往右走：${before.x} → ${walking.x}`);

  // 先放開左手指（touchEnd 的 touchPoints 是「要放開的那幾根」）：停止移動，但右手指還在瞄準
  await touch('touchEnd', [{ ...left, x: left.x + 80 }]);
  await sleep(150);
  const aimOnly = await page.evaluate(() => ({ stickX: window.__game().input.stickX, touchAim: window.__game().input.touchAim }));
  assert.equal(aimOnly.stickX, 0, '左手指放開後要停下來');
  assert.ok(aimOnly.touchAim, '右手指還在瞄準');

  // 再放開右手指：發射
  await touch('touchEnd', [{ ...right, y: right.y - 70 }]);
  await waitShots(page, 1);
  const shot = await page.evaluate(() => window.__sent[0]);
  assert.equal(shot.t, 'atk');
  assert.ok(Math.abs(shot.a + Math.PI / 2) < 0.05, `發射的角度要是正上方：${shot.a}`);
  await page.waitForFunction(() => window.__game().mySnap.am < 2.9, null, { timeout: 3000 });
  noErrors(p);
});

// ---------------------------------------------------------------------------
// 純靜態網站：用 scripts/build-static.mjs 整理出和 GitHub Pages 一樣的檔案，放在子路徑底下提供

const SITE_BASE = '/capybara-brawl-game/';
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
};

// 只認 /capybara-brawl-game/ 底下的檔案，其他路徑一律 404（用來證明所有網址都是相對路徑）
async function staticSite(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capybrawl-site-'));
  buildStatic(root);
  const outside = []; // 跑到子路徑外面的請求
  const srv = http.createServer((req, res) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (pathname === SITE_BASE.slice(0, -1)) {
      res.writeHead(301, { Location: SITE_BASE }).end();
      return;
    }
    if (!pathname.startsWith(SITE_BASE)) {
      outside.push(pathname);
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found');
      return;
    }
    let rel = pathname.slice(SITE_BASE.length);
    if (!rel || rel.endsWith('/')) rel += 'index.html';
    const file = path.join(root, path.normalize(rel));
    if (!file.startsWith(root + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => {
    srv.closeAllConnections?.();
    srv.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${srv.address().port}`;
  return { origin, url: origin + SITE_BASE, root, outside };
}

test('靜態網站（GitHub Pages）：放在子路徑也能用，只有單人模式', async (t) => {
  const site = await staticSite(t);
  // 先開空白頁、掛好請求記錄，再載入網站，這樣第一次載入的請求（包含 service worker 抓的檔案）也記得到
  const p = await player(t, 'about:blank', '靜態', { join: false, context: phoneContext(844, 390) });
  const { page } = p;
  const requests = [];
  page.context().on('request', (r) => requests.push(r.url()));
  await page.goto(site.url);

  // 沒有伺服器：沒有「連線對戰」，單人是主要按鈕
  await page.locator('#solo-btn').waitFor({ state: 'visible' });
  assert.equal(await page.isVisible('#join-btn'), false, '靜態網站不能連線對戰');
  assert.match(await page.textContent('#solo-btn'), /和電腦打/);
  assert.equal(await page.evaluate(() => document.body.dataset.screen), 'screen-join');

  await soloMatch(page, '靜態');
  assert.equal(await page.isVisible('#touch-attack'), true);
  await waitPlaying(page);

  // 載入的每個檔案都在子路徑底下，沒有任何一個請求打到網站根目錄
  assert.deepEqual(site.outside, [], '網站伺服器收到子路徑以外的請求');
  const stray = requests.filter((u) => /^https?:/.test(u) && !u.startsWith(site.url));
  assert.deepEqual(stray, [], '有請求跑到子路徑以外的地方');
  assert.ok(requests.some((u) => u === `${site.url}shared/lobby.js`), '共用的程式碼要從 shared/ 載入');
  assert.ok(requests.some((u) => u === `${site.url}js/local-net.js`));
  assert.equal(requests.some((u) => u.includes('/ws')), false, '單人模式不能連 WebSocket');
  noErrors(p);
});

const hasPwaFiles = ['manifest.webmanifest', 'sw.js', 'icons/icon-192.png', 'icons/icon-512.png']
  .every((f) => fs.existsSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', f)));

test('安裝成 App：manifest 和圖示都正確，離線也能玩單人模式', {
  skip: (BROWSER !== 'chromium' && '只有 Chromium 的 Playwright 支援 service worker')
    || (!hasPwaFiles && '還沒有 manifest.webmanifest / sw.js / icons'),
}, async (t) => {
  const site = await staticSite(t);
  const ctx = await browser.newContext({ ...phoneContext(844, 390), serviceWorkers: 'allow' });
  await ctx.addInitScript(stayWindowed);
  t.after(() => ctx.close());
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(site.url);

  // manifest：讀得到、能解析，每個圖示都載得到
  const manifest = await page.evaluate(async () => {
    const href = document.querySelector('link[rel="manifest"]').href;
    const res = await fetch(href);
    const json = await res.json();
    const icons = [];
    for (const icon of json.icons) {
      const r = await fetch(new URL(icon.src, href));
      icons.push({ src: icon.src, sizes: icon.sizes, purpose: icon.purpose, status: r.status, type: r.headers.get('content-type'), bytes: (await r.blob()).size });
    }
    const links = [];
    for (const l of document.querySelectorAll('link[rel="icon"], link[rel="apple-touch-icon"]')) {
      links.push({ href: l.getAttribute('href'), status: (await fetch(l.href)).status });
    }
    return { href, status: res.status, json, icons, links };
  });
  assert.equal(manifest.status, 200);
  assert.ok(manifest.href.startsWith(site.url), `manifest 要在子路徑底下：${manifest.href}`);
  assert.ok(manifest.json.name && manifest.json.short_name);
  assert.ok(['standalone', 'fullscreen'].includes(manifest.json.display));
  assert.ok(manifest.json.start_url && !manifest.json.start_url.startsWith('/'), `start_url 要是相對路徑：${manifest.json.start_url}`);
  assert.ok(manifest.json.scope && !manifest.json.scope.startsWith('/'), `scope 要是相對路徑：${manifest.json.scope}`);
  assert.ok(manifest.icons.some((i) => i.sizes === '192x192'));
  assert.ok(manifest.icons.some((i) => i.sizes === '512x512'));
  assert.ok(manifest.icons.some((i) => i.purpose === 'maskable'), '要有 maskable 圖示（Android 圓形圖示）');
  for (const icon of manifest.icons) {
    assert.equal(icon.status, 200, icon.src);
    assert.equal(icon.type, 'image/png', icon.src);
    assert.ok(icon.bytes > 100, `${icon.src} 不能是空的`);
  }
  assert.ok(manifest.links.length >= 2);
  for (const l of manifest.links) assert.equal(l.status, 200, l.href);

  // service worker 就緒後重新整理一次，頁面才會被它接管
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 5000 });
  const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
  assert.equal(scope, site.url, 'service worker 的範圍就是子路徑');

  // 斷網重新整理：開頭畫面還在，單人模式照常
  await ctx.setOffline(true);
  await page.reload();
  await waitScreen(page, 'screen-join');
  assert.equal(await page.isVisible('#solo-btn'), true);
  assert.equal(await page.isVisible('#join-btn'), false);
  await soloLobby(page, '離線');
  await page.tap('#btn-start');
  await waitScreen(page, 'hud');
  assert.equal(await page.isVisible('#touch-attack'), true);
  await page.waitForFunction(() => document.querySelector('#hud-clock').textContent !== '0:00', null, { timeout: 5000 });
  assert.deepEqual(errors, [], `瀏覽器裡出現錯誤：\n${errors.join('\n')}`);
});

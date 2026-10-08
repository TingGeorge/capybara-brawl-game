// 單人模式的 LocalNet：大廳和對戰直接跑在瀏覽器裡（這裡用 Node 代替），不需要伺服器。
// 用法和 WebSocket 版的 net.js 一樣，所以這裡照 network.test.js 的方式收訊息、等訊息。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as nodeModule from 'node:module';

// local-net.js 是給瀏覽器用的：它寫 '../shared/lobby.js'，在網頁上對應到伺服器的 /shared/ 路徑，
// 但在硬碟上 public/shared/ 並不存在（共用程式碼在專案根目錄的 shared/）。
// 所以測試時用 Node 的模組解析 hook，把 public/js/ 底下的 '../shared/' 轉到真正的 shared/ 資料夾。
const canRedirect = typeof nodeModule.register === 'function';
let LocalNet;
if (canRedirect) {
  const hooks = `export async function resolve(specifier, context, next) {
    if (specifier.startsWith('../shared/') && /[\\/]public[\\/]js[\\/]/.test(context.parentURL || '')) {
      return next('../' + specifier, context);
    }
    return next(specifier, context);
  }`;
  nodeModule.register(`data:text/javascript,${encodeURIComponent(hooks)}`);
  ({ LocalNet } = await import('../public/js/local-net.js'));
}
const skip = !canRedirect && '這個 Node 版本沒有 module.register，沒辦法在 Node 裡載入瀏覽器端的檔案';

// 和 network.test.js 的 client() 一樣：訊息都收進 inbox，wait() 等到符合條件的那一則
// LocalNet 的 on() 每種訊息只能註冊一個處理函式，所以每一種都要註冊
const TYPES = ['welcome', 'lobby', 'start', 's', 'pong', 'error', 'result'];

function client(name = '小明', charId = 'carrot') {
  const net = new LocalNet();
  const inbox = [];
  const waiters = [];
  for (const type of TYPES) {
    net.on(type, (msg) => {
      inbox.push(msg);
      for (const w of [...waiters]) {
        if (w.pred(msg)) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve(msg);
        }
      }
    });
  }
  return {
    net, inbox,
    hello: () => net.send({ t: 'hello', name, charId }),
    send: (o) => net.send(o),
    wait(pred, ms = 3000) {
      const hit = inbox.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        waiters.push({ pred, resolve });
        setTimeout(() => reject(new Error(`${name} 等不到訊息`)), ms);
      });
    },
    // 最新一則快照裡自己的狀態
    me(id) {
      const snap = [...inbox].reverse().find((m) => m.t === 's');
      return snap && snap.p.find((p) => p.i === id);
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 連線、打招呼、拿到自己的 id
async function join(name, charId) {
  const c = client(name, charId);
  await c.net.connect();
  c.hello();
  const welcome = await c.wait((m) => m.t === 'welcome');
  return { c, id: welcome.id };
}

test('連線後打招呼：收到 welcome 和單人模式的大廳，自己是房主', { skip }, async () => {
  const c = client('小明', 'banana');
  assert.equal(c.net.connected, false);
  await c.net.connect();
  assert.equal(c.net.connected, true);
  try {
    c.hello();
    const welcome = await c.wait((m) => m.t === 'welcome');
    assert.ok(welcome.id);
    assert.deepEqual(welcome.urls, []); // 單人模式沒有區域網路網址

    const lobby = await c.wait((m) => m.t === 'lobby');
    assert.equal(lobby.solo, true);
    assert.equal(lobby.phase, 'lobby');
    assert.equal(lobby.hostId, welcome.id);
    assert.equal(lobby.bots, true);
    assert.equal(lobby.players.length, 1);
    assert.deepEqual(lobby.players[0], { id: welcome.id, name: '小明', team: 'blue', charId: 'banana' });

    // 重複連線不會多開一個大廳，也不會讓自己再收到一次 welcome
    await c.net.connect();
    assert.equal(c.net.connected, true);
    c.hello();
    await sleep(50);
    assert.equal(c.inbox.filter((m) => m.t === 'welcome').length, 1);
  } finally {
    c.net.close();
  }
});

test('房主想關掉電腦補位會被忽略，單人模式一定用電腦補位', { skip }, async () => {
  const { c } = await join();
  try {
    c.inbox.length = 0;
    c.send({ t: 'bots', v: false });
    await sleep(100);
    // 沒有新的大廳廣播，bots 還是 true
    assert.ok(!c.inbox.some((m) => m.t === 'lobby' && m.bots === false));

    // 換角色會觸發新的大廳廣播，順便確認 bots 還開著
    c.send({ t: 'pick', charId: 'pumpkin' });
    const lobby = await c.wait((m) => m.t === 'lobby' && m.players[0].charId === 'pumpkin');
    assert.equal(lobby.bots, true);
    assert.equal(lobby.solo, true);
  } finally {
    c.net.close();
  }
});

test('ping 會收到帶著同一個編號的 pong', { skip }, async () => {
  const { c } = await join();
  try {
    c.send({ t: 'ping', c: 12345 });
    const pong = await c.wait((m) => m.t === 'pong');
    assert.equal(pong.c, 12345);
  } finally {
    c.net.close();
  }
});

test('按開始：6 隻水豚（1 個玩家 + 5 隻電腦）、每隊 3 隻，之後開始收到快照', { skip }, async () => {
  const { c, id } = await join('小明', 'carrot');
  try {
    c.send({ t: 'bots', v: false }); // 關掉也一樣：還是會補滿
    c.send({ t: 'start' });
    const start = await c.wait((m) => m.t === 'start');
    assert.equal(start.players.length, 6);
    assert.equal(start.players.filter((p) => !p.isBot).length, 1);
    assert.equal(start.players.filter((p) => p.isBot).length, 5);
    assert.equal(start.players.filter((p) => p.team === 'blue').length, 3);
    assert.equal(start.players.filter((p) => p.team === 'red').length, 3);
    assert.equal(start.players.find((p) => p.id === id).charId, 'carrot');
    assert.ok(start.koTarget > 0 && start.duration > 0);
    assert.equal(c.inbox.filter((m) => m.t === 'error').length, 0);

    // 對戰開始後大廳會通知 phase 變成 match
    const lobby = await c.wait((m) => m.t === 'lobby' && m.phase === 'match');
    assert.equal(lobby.solo, true);

    // 先是倒數，約 3 秒後變成 playing
    const first = await c.wait((m) => m.t === 's');
    assert.equal(first.ph, 'countdown');
    assert.equal(first.p.length, 6);
    assert.deepEqual(first.sc, [0, 0]);
    const playing = await c.wait((m) => m.t === 's' && m.ph === 'playing', 6000);
    assert.equal(playing.p.length, 6);

    // 快照大約每秒 30 次
    const t0 = Date.now();
    const n0 = c.inbox.filter((m) => m.t === 's').length;
    await sleep(500);
    const rate = (c.inbox.filter((m) => m.t === 's').length - n0) / ((Date.now() - t0) / 1000);
    assert.ok(rate > 15 && rate < 45, `快照頻率應該約 30 次/秒，實際 ${rate.toFixed(1)}`);

    // 對戰中 ping 也能得到 pong
    c.send({ t: 'ping', c: 7 });
    assert.equal((await c.wait((m) => m.t === 'pong' && m.c === 7)).c, 7);
  } finally {
    c.net.close();
  }
});

test('用類比搖桿的斜向輸入移動、再開槍：位置照著動，序號追上，快照有攻擊事件', { skip }, async () => {
  const { c, id } = await join('小明', 'carrot');
  try {
    c.send({ t: 'start' });
    await c.wait((m) => m.t === 's' && m.ph === 'playing' && m.p.find((p) => p.i === id).q === 0, 6000);

    // 往右上斜著推（螢幕座標 y 往下增加，所以 my 是負的 → y 變小）
    const before = c.me(id);
    const list = [];
    for (let s = 1; s <= 30; s++) list.push([s, 0.71, -0.71]);
    c.send({ t: 'in', l: list, a: 0 });
    const snap = await c.wait((m) => m.t === 's' && m.p.find((p) => p.i === id).q === 30);
    const after = snap.p.find((p) => p.i === id);
    const dx = after.x - before.x;
    const dy = after.y - before.y;
    assert.ok(dx > 10, `x 應該變大：${before.x} → ${after.x}`);
    assert.ok(dy < -10, `y 應該變小：${before.y} → ${after.y}`);
    assert.ok(Math.abs(dx + dy) < 0.5, `斜 45 度，x、y 位移要差不多大：${dx}, ${dy}`);
    // 30 步 × 50 像素/秒 ÷ 60 = 25 像素：斜著走和直線走一樣快
    assert.ok(Math.abs(Math.hypot(dx, dy) - 25) < 0.5, `走了 ${Math.hypot(dx, dy)} 像素，應該約 25`);

    // 只推一點點的搖桿（0.3）往下，速度還是一樣
    const mid = c.me(id);
    const down = [];
    for (let s = 31; s <= 60; s++) down.push([s, 0, 0.3]);
    c.send({ t: 'in', l: down, a: Math.PI / 2 });
    const snap2 = await c.wait((m) => m.t === 's' && m.p.find((p) => p.i === id).q === 60);
    const end = snap2.p.find((p) => p.i === id);
    assert.ok(Math.abs(end.x - mid.x) < 0.5, '只往下走，x 不變');
    assert.ok(Math.abs(end.y - mid.y - 25) < 0.5, `往下走了 ${end.y - mid.y} 像素，應該約 25`);

    // 開槍：快照事件裡會有自己的 atk
    c.send({ t: 'atk', a: 0, d: 100 });
    const atk = await c.wait((m) => m.t === 's' && m.ev.some((e) => e.k === 'atk' && e.i === id));
    assert.ok(atk.ev.find((e) => e.k === 'atk' && e.i === id));
  } finally {
    c.net.close();
  }
});

test('close() 之後：connected 變成 false、不再收到任何訊息、也不會觸發 onclose', { skip }, async () => {
  const { c } = await join();
  let closed = 0;
  c.net.onclose = () => closed++;
  try {
    c.send({ t: 'start' });
    await c.wait((m) => m.t === 's');
    assert.equal(c.net.connected, true);

    c.net.close();
    assert.equal(c.net.connected, false);
    const count = c.inbox.length;

    // 迴圈停了：等一下，不會再有快照；送出去的訊息也沒有回應
    c.send({ t: 'ping', c: 99 });
    c.send({ t: 'in', l: [[1, 1, 0]], a: 0 });
    await sleep(200);
    assert.equal(c.inbox.length, count, '關閉之後不應該再收到訊息');
    assert.ok(!c.inbox.slice(count).some((m) => m.t === 'pong'));
    assert.equal(closed, 0, '主動離開不算意外斷線');

    // 重複關閉不會丟錯
    assert.doesNotThrow(() => c.net.close());
  } finally {
    c.net.close();
  }
});

test('離開後可以重新連線，會是全新的大廳', { skip }, async () => {
  const first = await join('甲');
  first.c.send({ t: 'start' });
  await first.c.wait((m) => m.t === 'start');
  first.c.net.close();

  const second = client('乙');
  try {
    await second.net.connect();
    assert.equal(second.net.connected, true);
    second.hello();
    const lobby = await second.wait((m) => m.t === 'lobby');
    assert.equal(lobby.phase, 'lobby');
    assert.equal(lobby.players.length, 1);
    assert.equal(lobby.players[0].name, '乙');
  } finally {
    second.net.close();
  }
});

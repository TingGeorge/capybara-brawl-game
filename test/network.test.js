import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../server/index.js';

const PORT = 38000 + Math.floor(Math.random() * 1000);

function client(name) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const inbox = [];
  const waiters = [];
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    inbox.push(msg);
    for (const w of [...waiters]) {
      if (w.pred(msg)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(msg);
      }
    }
  });
  const opened = new Promise((r) => ws.addEventListener('open', r));
  return {
    ws, inbox, opened,
    send: (o) => ws.send(JSON.stringify(o)),
    wait(pred, ms = 3000) {
      const hit = inbox.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        waiters.push({ pred, resolve });
        setTimeout(() => reject(new Error(`${name} 等不到訊息`)), ms);
      });
    },
  };
}

// Node 22 以上才有內建的 WebSocket 用戶端
const skip = typeof WebSocket === 'undefined' && '這個 Node 版本沒有內建 WebSocket 用戶端';

test('兩個玩家連線、開局、移動，第三人斷線後會被電腦接手', { skip }, async () => {
  const { server, stop } = startServer(PORT, { quiet: true });
  await new Promise((r) => server.once('listening', r));
  try {
    const a = client('A');
    const b = client('B');
    await Promise.all([a.opened, b.opened]);
    a.send({ t: 'hello', name: '小明', charId: 'carrot' });
    const wa = await a.wait((m) => m.t === 'welcome');
    b.send({ t: 'hello', name: '小華', charId: 'banana' });
    const wb = await b.wait((m) => m.t === 'welcome');
    assert.notEqual(wa.id, wb.id);

    const lobby = await a.wait((m) => m.t === 'lobby' && m.players.length === 2);
    assert.equal(lobby.hostId, wa.id);
    assert.deepEqual(lobby.players.map((p) => p.team).sort(), ['blue', 'red']);

    // 不是房主不能開始
    b.send({ t: 'start' });
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(!a.inbox.some((m) => m.t === 'start'));

    a.send({ t: 'start' });
    const start = await b.wait((m) => m.t === 'start');
    assert.equal(start.players.length, 6);

    // 等倒數結束後往右走
    await a.wait((m) => m.t === 's' && m.ph === 'playing', 5000);
    const me = () => [...a.inbox].reverse().find((m) => m.t === 's').p.find((p) => p.i === wa.id);
    const before = me();
    const list = [];
    for (let s = 1; s <= 30; s++) list.push([s, 1, 0]);
    a.send({ t: 'in', l: list, a: 0 });
    await a.wait((m) => m.t === 's' && m.p.find((p) => p.i === wa.id).q === 30);
    const after = me();
    assert.ok(after.x > before.x + 20, `應該往右移動：${before.x} → ${after.x}`);

    // 開槍會產生子彈
    a.send({ t: 'atk', a: 0, d: 100 });
    await a.wait((m) => m.t === 's' && m.ev.some((e) => e.k === 'atk' && e.i === wa.id));

    // B 斷線 → 由電腦接手，比賽繼續
    a.inbox.length = 0;
    b.ws.close();
    const l2 = await a.wait((m) => m.t === 'lobby' && m.players.length === 1);
    assert.equal(l2.phase, 'match');
  } finally {
    stop();
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Match } from '../shared/match.js';
import { CHARACTERS } from '../shared/characters.js';
import { TICK_RATE, TILE } from '../shared/constants.js';
import { boxHitsWall } from '../shared/physics.js';

function botMatch(chars) {
  const players = chars.map((charId, i) => ({
    id: `b${i}`, name: `bot${i}`, team: i < 3 ? 'blue' : 'red', charId, isBot: true,
  }));
  const snaps = [];
  const m = new Match({ players, koTarget: 15, duration: 180, send: (s) => snaps.push(s) });
  return { m, snaps };
}

test('每個角色都能在全電腦對戰裡打完一整場', () => {
  const ids = CHARACTERS.map((c) => c.id);
  for (let round = 0; round < 4; round++) {
    const chars = Array.from({ length: 6 }, (_, i) => ids[(i + round * 3) % ids.length]);
    const { m, snaps } = botMatch(chars);
    for (let i = 0; i < TICK_RATE * 200 && m.phase !== 'ended'; i++) {
      m.tick();
      for (const p of m.players.values()) {
        if (p.alive && !p.leap) assert.equal(boxHitsWall(p.x, p.y), false, `${p.char.id} 卡進牆裡了`);
        assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
      }
    }
    assert.equal(m.phase, 'ended');
    const total = m.score.blue + m.score.red;
    assert.ok(total >= 3, `電腦之間應該要有擊倒，結果 ${m.score.blue}:${m.score.red}`);
    assert.ok(snaps.length > 100);
    const last = JSON.parse(snaps[snaps.length - 1]);
    assert.ok(last.ev.some((e) => e.k === 'end'));
    console.log(`  ${chars.join(',')} → ${m.score.blue}:${m.score.red} (${m.time.toFixed(0)}s)`);
  }
});

test('玩家輸入會移動角色，並回報處理到哪一個序號', () => {
  const m = new Match({
    players: [
      { id: 'p1', name: 'me', team: 'blue', charId: 'carrot', isBot: false },
      { id: 'p2', name: 'you', team: 'red', charId: 'banana', isBot: false },
    ],
    koTarget: 15, duration: 180, send: () => {},
  });
  for (let i = 0; i < TICK_RATE * 3 + 2; i++) m.tick();
  const p = m.players.get('p1');
  const x0 = p.x;
  m.queueInputs('p1', [[1, 1, 0], [2, 1, 0], [3, 1, 0]], 0);
  m.tick();
  assert.equal(p.lastSeq, 3);
  assert.ok(Math.abs(p.x - x0 - (50 * 3) / 60) < 1e-9);
});

test('大招要先集滿才能用', () => {
  const m = new Match({
    players: [
      { id: 'p1', name: 'me', team: 'blue', charId: 'pineapple', isBot: false },
      { id: 'p2', name: 'you', team: 'red', charId: 'pumpkin', isBot: false },
    ],
    koTarget: 15, duration: 180, send: () => {},
  });
  for (let i = 0; i < TICK_RATE * 3 + 2; i++) m.tick();
  const p = m.players.get('p1');
  assert.equal(m.trySuper(p, 0, 50), false);
  p.superCharge = 1;
  assert.equal(m.trySuper(p, 0, 50), true);
  assert.ok(p.dash);
});

// ---------- 類比搖桿輸入（手機）----------

// 兩隻玩家站在中間上方的空地（和 supers.test.js 一樣的位置），倒數結束後才回傳
function openField() {
  const m = new Match({
    players: [
      { id: 'p1', name: 'me', team: 'blue', charId: 'carrot', isBot: false },
      { id: 'p2', name: 'you', team: 'red', charId: 'banana', isBot: false },
    ],
    koTarget: 15, duration: 180, send: () => {},
  });
  for (let i = 0; i < TICK_RATE * 3 + 2; i++) m.tick();
  const p = m.players.get('p1');
  p.x = 15 * TILE;
  p.y = 2.5 * TILE;
  return { m, p };
}

// 連續送 n 個相同的輸入，跑到伺服器全部處理完，回傳位移量
function walk(mx, my, n = 10) {
  const { m, p } = openField();
  const x0 = p.x;
  const y0 = p.y;
  const list = [];
  for (let s = 1; s <= n; s++) list.push([s, mx, my]);
  m.queueInputs('p1', list, 0);
  for (let i = 0; i < n && p.inputs.length; i++) m.tick();
  assert.equal(p.inputs.length, 0, '輸入應該都處理完了');
  assert.equal(p.lastSeq, n);
  return { dx: p.x - x0, dy: p.y - y0, dist: Math.hypot(p.x - x0, p.y - y0), p };
}

const STEP = 50 / 60; // 一步的距離：角色速度 50 像素/秒 ÷ 60 tick

test('類比搖桿斜著走，每一步的距離和鍵盤走直線一樣', () => {
  const key = walk(1, 0);
  const diag = walk(0.71, 0.71);
  assert.ok(Math.abs(key.dist - STEP * 10) < 1e-6, `鍵盤走 10 步應該是 ${STEP * 10}，實際 ${key.dist}`);
  assert.ok(Math.abs(diag.dist - key.dist) < 1e-6, `斜著走 ${diag.dist}，直線 ${key.dist}`);
  // 斜 45 度：x、y 位移一樣多，而且方向是往右、往下（y 往下增加）
  assert.ok(diag.dx > 0 && diag.dy > 0);
  assert.ok(Math.abs(diag.dx - diag.dy) < 1e-6);
  // 搖桿只推一點點（0.3）也是全速：速度和推多遠無關，只看方向
  const soft = walk(0.3, 0);
  assert.ok(Math.abs(soft.dist - key.dist) < 1e-6);
  const softDiag = walk(-0.2, 0.5);
  assert.ok(Math.abs(softDiag.dist - key.dist) < 1e-6);
  assert.ok(softDiag.dx < 0 && softDiag.dy > 0);
});

test('類比輸入會四捨五入到小數點後兩位', () => {
  const { m, p } = openField();
  m.queueInputs('p1', [[1, 0.714, -0.706], [2, 0.5, 0]], 0);
  assert.deepEqual(p.inputs, [[1, 0.71, -0.71], [2, 0.5, 0]]);
});

test('超出範圍的類比值會被夾在 -1 到 1，仍然用正常速度移動', () => {
  const { m, p } = openField();
  m.queueInputs('p1', [[1, 5, -9], [2, 1.0001, 0], [3, -2, 0]], 0);
  assert.deepEqual(p.inputs, [[1, 1, -1], [2, 1, 0], [3, -1, 0]]);

  const big = walk(5, -9);
  const key = walk(1, 0);
  assert.ok(Math.abs(big.dist - key.dist) < 1e-6, `夾住後速度應該一樣：${big.dist} vs ${key.dist}`);
  assert.ok(big.dx > 0 && big.dy < 0, '5, -9 夾成 1, -1，要往右上走');
  assert.ok(Math.abs(big.dx + big.dy) < 1e-6, 'x、y 位移一樣大');

  // 只有一軸超出：5 → 1，等於直線往右
  const right = walk(5, 0);
  assert.ok(Math.abs(right.dx - key.dx) < 1e-9 && right.dy === 0);
});

test('不是有限數字的輸入（NaN、undefined、字串…）當成 0，不會移動也不會當掉', () => {
  const junk = [NaN, undefined, null, '1', '0.7', 'abc', Infinity, -Infinity, {}, [], [1], true];
  for (const bad of junk) {
    const r = walk(bad, bad, 5);
    assert.equal(r.dx, 0, `${String(bad)} 不該移動`);
    assert.equal(r.dy, 0, `${String(bad)} 不該移動`);
    assert.ok(Number.isFinite(r.p.x) && Number.isFinite(r.p.y));
  }

  // 一軸壞掉、另一軸正常：壞的那軸當 0，另一軸照走
  const half = walk(NaN, 1);
  assert.equal(half.dx, 0);
  assert.ok(Math.abs(half.dy - STEP * 10) < 1e-6);

  // 項目太短、不是陣列、序號壞掉：直接略過，不能丟錯
  const { m, p } = openField();
  assert.doesNotThrow(() => m.queueInputs('p1', [[1], 'x', null, [NaN, 1, 0], [2, NaN]], 0));
  assert.equal(p.inputs.length, 2); // [1] 和 [2, NaN] 會被當成不動；序號是 NaN 的整個丟掉
  const x0 = p.x;
  const y0 = p.y;
  m.tick();
  assert.equal(p.x, x0);
  assert.equal(p.y, y0);
  assert.equal(p.lastSeq, 2);
});

test('小到四捨五入成 0 的類比值不會移動', () => {
  const tiny = walk(0.001, 0.001);
  assert.equal(tiny.dx, 0);
  assert.equal(tiny.dy, 0);
  const negative = walk(-0.004, 0.004);
  assert.equal(negative.dx, 0);
  assert.equal(negative.dy, 0);

  // 一軸太小、另一軸正常：太小的那軸變 0，只沿著另一軸走，而且是全速
  const slide = walk(0.001, 1);
  assert.equal(slide.dx, 0);
  assert.ok(Math.abs(slide.dy - STEP * 10) < 1e-6);

  // 0.01 是最小的有效值：還是會移動（而且全速）
  const small = walk(0.01, 0);
  assert.ok(Math.abs(small.dx - STEP * 10) < 1e-6);
});

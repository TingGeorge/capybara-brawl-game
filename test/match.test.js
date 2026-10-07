import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Match } from '../server/match.js';
import { CHARACTERS } from '../shared/characters.js';
import { TICK_RATE } from '../shared/constants.js';
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

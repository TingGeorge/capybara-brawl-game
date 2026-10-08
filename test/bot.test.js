import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Match } from '../shared/match.js';
import { CHARACTERS } from '../shared/characters.js';
import { TICK_RATE } from '../shared/constants.js';

// 一隻電腦對一個會亂走的玩家（不會死、不會還手），算電腦的普攻有幾成打中。
// 散彈一次射很多顆，只要有一顆打中就算這一發有中。
function botAccuracy(charId, minShots) {
  const m = new Match({
    players: [
      { id: 'h', name: 'h', team: 'blue', charId: 'pumpkin', isBot: false },
      { id: 'b', name: 'b', team: 'red', charId, isBot: true },
    ],
    koTarget: 999, duration: 9999, send: () => {},
  });
  const bot = m.players.get('b');
  const hum = m.players.get('h');

  // 把每顆子彈、每個投擲物標上是第幾發普攻，打中時就知道是哪一發
  let shots = 0;
  let firing = null;
  let flying = null;
  const hits = new Set();
  const tryAttack = m.tryAttack.bind(m);
  m.tryAttack = (p, a, d) => {
    if (p !== bot) return tryAttack(p, a, d);
    firing = shots;
    const before = new Set(m.projectiles);
    const ok = tryAttack(p, a, d);
    if (ok) {
      for (const pr of m.projectiles) if (!before.has(pr)) pr.shot = firing;
      for (const pr of m.spawned) if (pr.shot === undefined) pr.shot = firing;
      shots++;
    }
    firing = null;
    return ok;
  };
  for (const fn of ['moveBullet', 'explode']) {
    const orig = m[fn].bind(m);
    m[fn] = (pr, ...rest) => {
      flying = pr;
      const r = orig(pr, ...rest);
      flying = null;
      return r;
    };
  }
  const damage = m.damage.bind(m);
  m.damage = (target, amount, attacker, isMain) => {
    const v = damage(target, amount, attacker, isMain);
    const shot = firing !== null ? firing : flying && flying.shot;
    if (attacker === bot && isMain && shot !== undefined && shot !== null) hits.add(shot);
    return v;
  };

  let seq = 0;
  let mx = 0;
  let my = 0;
  let next = 0;
  const step = () => {
    if (m.time >= next) {
      // 每 0.3～1 秒換一個方向，偶爾停下來
      next = m.time + 0.3 + Math.random() * 0.7;
      const a = Math.floor(Math.random() * 8) * (Math.PI / 4);
      const go = Math.random() < 0.8;
      mx = go ? Math.round(Math.cos(a) * 100) / 100 : 0;
      my = go ? Math.round(Math.sin(a) * 100) / 100 : 0;
    }
    m.queueInputs('h', [[++seq, mx, my]], 0);
    m.tick();
    hum.hp = hum.char.hp;
  };
  // 打滿 minShots 發才停（目標躲進草叢、走遠了，電腦就會打得比較少），
  // 再多跑 2 秒讓最後幾發飛完，只算前 minShots 發
  for (let i = 0; i < TICK_RATE * 600 && shots < minShots; i++) step();
  for (let i = 0; i < TICK_RATE * 2; i++) step();
  return { shots: Math.min(shots, minShots), hits: [...hits].filter((s) => s < minShots).length };
}

test('電腦的普攻不會百發百中：對著會走動的玩家，大約七成會打中', () => {
  let shots = 0;
  let hits = 0;
  const rows = [];
  for (const c of CHARACTERS) {
    const r = botAccuracy(c.id, 80);
    assert.ok(r.shots >= 80, `${c.id} 應該要一直攻擊，結果 10 分鐘只打了 ${r.shots} 發`);
    const rate = r.hits / r.shots;
    assert.ok(rate > 0.35 && rate < 0.95, `${c.id} 命中率 ${Math.round(rate * 100)}% 不太對`);
    shots += r.shots;
    hits += r.hits;
    rows.push(`${c.id} ${Math.round(rate * 100)}%`);
  }
  const rate = hits / shots;
  console.log(`  整體 ${Math.round(rate * 100)}%（${hits}/${shots}）：${rows.join('、')}`);
  assert.ok(rate > 0.6 && rate < 0.8, `整體命中率應該大約七成，結果 ${Math.round(rate * 100)}%`);
});

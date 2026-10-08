// 每一隻角色都由「玩家」放一次大招，確認效果真的有發生。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Match } from '../shared/match.js';
import { CHARACTERS } from '../shared/characters.js';
import { TICK_RATE, TILE } from '../shared/constants.js';

function duel(charId, enemyCharId = 'pumpkin') {
  const m = new Match({
    players: [
      { id: 'me', name: 'me', team: 'blue', charId, isBot: false },
      { id: 'foe', name: 'foe', team: 'red', charId: enemyCharId, isBot: false },
    ],
    koTarget: 15, duration: 180, send: () => {},
  });
  for (let i = 0; i < TICK_RATE * 3 + 2; i++) m.tick();
  const me = m.players.get('me');
  const foe = m.players.get('foe');
  // 把兩隻放在中間空地，面對面距離 3 格
  me.x = 15 * TILE;
  me.y = 2.5 * TILE;
  foe.x = 18 * TILE;
  foe.y = 2.5 * TILE;
  foe.protectUntil = 0;
  return { m, me, foe };
}

const run = (m, seconds) => {
  for (let i = 0; i < TICK_RATE * seconds; i++) m.tick();
};

for (const ch of CHARACTERS) {
  test(`${ch.name} 的大招「${ch.super.name}」`, () => {
    const { m, me, foe } = duel(ch.id);
    const hp0 = foe.hp;
    me.superCharge = 1;
    m.queueAttack('me', 0, 3 * TILE, true);
    m.tick();
    assert.equal(me.superCharge, 0, '放完大招要歸零');

    switch (ch.super.kind) {
      case 'shield':
        assert.ok(m.time < me.shieldUntil, '要有護盾');
        foe.superCharge = 0;
        m.damage(me, 1000, foe, false);
        assert.equal(me.char.hp - me.hp, 400, '護盾要減少 60% 傷害');
        break;
      case 'spin':
        assert.ok(m.time < me.spinUntil);
        foe.x = me.x + 20;
        run(m, 1);
        assert.ok(foe.hp < hp0, '旋風要打到旁邊的敵人');
        break;
      case 'trap':
        assert.equal(m.zones.filter((z) => z.kind === 'trap').length, 1);
        run(m, 1);
        assert.ok(m.time < foe.stunUntil || foe.hp < hp0, '踩到香蕉皮要暈眩');
        break;
      case 'zone': {
        assert.equal(m.zones.filter((z) => z.kind === 'spring').length, 1);
        me.hp = 1000;
        const z = m.zones[0];
        me.x = z.x;
        me.y = z.y;
        run(m, 1.2);
        assert.ok(me.hp > 1000, '隊友泡溫泉要回血');
        break;
      }
      default:
        run(m, 1.5);
        assert.ok(foe.hp < hp0, `大招要打到正前方 3 格的敵人（${ch.super.kind}）`);
    }
  });
}

test('大招沒集滿不能放，普攻會累積大招', () => {
  const { m, me } = duel('carrot');
  m.queueAttack('me', 0, 3 * TILE, true);
  m.tick();
  assert.equal(m.projectiles.length + m.spawned.length, 0);
  m.queueAttack('me', 0, 3 * TILE, false);
  run(m, 1);
  assert.ok(me.superCharge > 0.2 && me.superCharge < 0.3, `打中一次胡蘿蔔應該集 1/4，結果 ${me.superCharge}`);
});

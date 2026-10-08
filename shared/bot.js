// 電腦水豚的 AI：找最近看得到的敵人、保持適合自己的距離、左右閃避、血少就撤退。
import { TILE, PLAYER_RADIUS } from './constants.js';
import { MAP_W, MAP_H, isSolidTile, SPAWN_POINTS, SPRING_CENTER } from './map.js';
import { lineOfSight, boxHitsWall } from './physics.js';

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

// 地圖格子上的 BFS 尋路（斜走時不能切牆角）
export function findPath(sx, sy, gx, gy) {
  if (isSolidTile(gx, gy)) return null;
  const key = (x, y) => y * MAP_W + x;
  const prev = new Int32Array(MAP_W * MAP_H).fill(-1);
  const start = key(sx, sy);
  const goal = key(gx, gy);
  prev[start] = start;
  const queue = [start];
  for (let qi = 0; qi < queue.length; qi++) {
    const cur = queue[qi];
    if (cur === goal) break;
    const cx = cur % MAP_W;
    const cy = (cur / MAP_W) | 0;
    for (const [dx, dy] of DIRS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (isSolidTile(nx, ny)) continue;
      if (dx && dy && (isSolidTile(cx + dx, cy) || isSolidTile(cx, cy + dy))) continue;
      const k = key(nx, ny);
      if (prev[k] !== -1) continue;
      prev[k] = cur;
      queue.push(k);
    }
  }
  if (prev[goal] === -1) return null;
  const path = [];
  for (let k = goal; k !== start; k = prev[k]) path.push([k % MAP_W, (k / MAP_W) | 0]);
  return path.reverse();
}

const center = (tx, ty) => ({ x: (tx + 0.5) * TILE, y: (ty + 0.5) * TILE });
const tileOf = (v) => Math.floor(v / TILE);

function randomOpenPoint(minTx, maxTx) {
  for (let i = 0; i < 40; i++) {
    const tx = minTx + Math.floor(Math.random() * (maxTx - minTx));
    const ty = 1 + Math.floor(Math.random() * (MAP_H - 2));
    if (!isSolidTile(tx, ty)) return center(tx, ty);
  }
  return { ...SPRING_CENTER };
}

export function updateBot(m, p, dt) {
  const b = p.bot || (p.bot = {
    think: Math.random() * 0.2, mode: 'roam', target: null, goal: null, path: null, pathKey: '', repath: 0,
    strafe: Math.random() < 0.5 ? 1 : -1, strafeSwap: 1, nextShot: m.time + 0.5 + Math.random(), wander: null,
    stuckT: 0, lastX: p.x, lastY: p.y, jitter: 0, jx: 0, jy: 0,
    // 每隻電腦失手的機率不太一樣，整體大約七成的普攻會打中
    slop: 0.25 + Math.random() * 0.1,
  });
  b.think -= dt;
  if (b.think <= 0) {
    b.think = 0.12 + Math.random() * 0.1;
    think(m, p, b);
  }
  steer(m, p, b, dt);
}

function think(m, p, b) {
  const ch = p.char;
  const t = m.time;

  // 選目標：看得到、距離近、血少的優先
  let best = null;
  let bestScore = Infinity;
  for (const e of m.enemiesOf(p)) {
    if (e.leap || !m.visibleTo(p.team, e)) continue;
    const d = Math.hypot(e.x - p.x, e.y - p.y);
    if (d > 13 * TILE) continue;
    const score = d + (e.hp / e.char.hp) * 40;
    if (score < bestScore) {
      bestScore = score;
      best = e;
    }
  }
  b.target = best;

  const hpRatio = p.hp / ch.hp;
  if (hpRatio < 0.35) b.mode = 'retreat';
  else if (b.mode === 'retreat' && hpRatio > 0.8) b.mode = 'roam';
  if (b.mode !== 'retreat') b.mode = best ? 'engage' : 'roam';

  if (b.mode === 'retreat') {
    b.goal = SPAWN_POINTS[p.team][Math.floor(SPAWN_POINTS[p.team].length / 2)];
  } else if (b.mode === 'roam') {
    if (!b.wander || Math.hypot(b.wander.x - p.x, b.wander.y - p.y) < TILE) {
      b.wander = Math.random() < 0.4 ? { ...SPRING_CENTER } : randomOpenPoint(8, MAP_W - 8);
    }
    b.goal = b.wander;
  }

  if (!best) return;
  const d = Math.hypot(best.x - p.x, best.y - p.y);
  const atk = ch.attack;
  const needsSight = atk.kind !== 'lob';
  const sees = lineOfSight(p.x, p.y, best.x, best.y);

  if (b.mode === 'engage') {
    // 射手保持距離；近戰和坦克靠近打，但不會整隻貼在敵人身上
    const desired = atk.range * (ch.role === 'ranged' ? 0.75 : 0.45);
    if ((needsSight && !sees) || d > desired + 12) {
      b.goal = { x: best.x, y: best.y };
    } else if (d < desired * 0.5) {
      const away = { x: p.x + ((p.x - best.x) / (d || 1)) * 3 * TILE, y: p.y + ((p.y - best.y) / (d || 1)) * 3 * TILE };
      b.goal = boxHitsWall(away.x, away.y) ? null : away;
    } else {
      b.goal = null;
    }
  }

  // 普攻
  if (t >= b.nextShot && d <= atk.range + 4 && (!needsSight || sees)) {
    const aim = aimAt(p, best, atk, b.slop);
    if (m.tryAttack(p, aim.a, aim.d)) b.nextShot = t + ch.cooldown + 0.2 + Math.random() * 0.5;
  }

  // 大招
  if (p.superCharge >= 1) useSuper(m, p, best, d, sees);
}

// 大約是標準差 1 的常態分布亂數
const gauss = () => (Math.random() + Math.random() + Math.random() - 1.5) * 2;

// 電腦瞄準：會預判敵人走位，但預判多少每次都不一樣、手也會抖一點；
// 還有 slop 的機率失手，故意偏到剛好打不到的地方（看起來像擦身而過），玩家才閃得掉。
// 回傳 { a: 角度, d: 距離（拋物線要丟多遠） }
function aimAt(p, e, spec, slop) {
  const miss = Math.random() < slop;
  const side = Math.random() < 0.5 ? 1 : -1;
  const dist = Math.hypot(e.x - p.x, e.y - p.y);

  if (spec.kind === 'melee') {
    // 揮歪：扇形邊緣剛好擦過敵人
    const off = miss ? spec.arc / 2 + 0.25 + Math.random() * 0.3 : gauss() * 0.08;
    return { a: Math.atan2(e.y - p.y, e.x - p.x) + off * side, d: dist };
  }

  let lead = 0;
  if (spec.kind === 'bullet') lead = dist / spec.speed;
  else if (spec.kind === 'lob') lead = spec.flight;
  lead *= 0.4 + Math.random() * 0.6;
  let tx = e.x + e.vx * lead;
  let ty = e.y + e.vy * lead;
  const d = Math.hypot(tx - p.x, ty - p.y) || 1;

  if (spec.kind === 'lob') {
    // 落點偏一點；失手時落在爆炸範圍外面一點點（丟太近、太遠或偏旁邊）
    const r = miss ? spec.aoe + PLAYER_RADIUS + 3 + Math.random() * 12 : Math.abs(gauss()) * 5;
    const ang = Math.random() * Math.PI * 2;
    tx += Math.cos(ang) * r;
    ty += Math.sin(ang) * r;
    return { a: Math.atan2(ty - p.y, tx - p.x), d: Math.hypot(tx - p.x, ty - p.y) };
  }

  // 子彈：失手時往旁邊偏，讓最外側的子彈也剛好擦過；貼臉時怎麼射都會中，就不硬射歪
  let a = Math.atan2(ty - p.y, tx - p.x) + gauss() * 0.03;
  if (miss) {
    const fan = (spec.count || 1) > 1 ? spec.spread / 2 : 0;
    const off = Math.asin(Math.min(1, ((spec.radius || 0) + PLAYER_RADIUS) / d)) + fan + 0.05 + Math.random() * 0.15;
    if (off < 1.2) a += off * side;
  }
  return { a, d };
}

function useSuper(m, p, e, d, sees) {
  const s = p.char.super;
  const angle = Math.atan2(e.y - p.y, e.x - p.x);
  switch (s.kind) {
    case 'bullet':
      if (d <= s.range * 0.9 && sees) m.trySuper(p, aimAt(p, e, s, p.bot.slop).a, d);
      break;
    case 'lob':
      if (d <= s.range) {
        const aim = aimAt(p, e, s, p.bot.slop);
        m.trySuper(p, aim.a, aim.d);
      }
      break;
    case 'trap':
      if (d <= s.range && d > 2 * TILE) m.trySuper(p, angle, d * 0.7);
      break;
    case 'spin':
      if (d <= 2.5 * TILE) m.trySuper(p, angle, d);
      break;
    case 'dash':
      if (d <= s.distance * 0.9 && sees) m.trySuper(p, angle, d);
      break;
    case 'leap':
      if (d <= s.range) m.trySuper(p, angle, d);
      break;
    case 'shield':
      if (d <= 4 * TILE && p.hp < p.char.hp * 0.8) m.trySuper(p, angle, d);
      break;
    case 'zone':
      if (d <= 4 * TILE || p.hp < p.char.hp * 0.5) m.trySuper(p, angle, 0);
      break;
  }
}

function steer(m, p, b, dt) {
  let mx = 0;
  let my = 0;

  if (b.jitter > 0) {
    b.jitter -= dt;
    mx = b.jx;
    my = b.jy;
  } else {
    if (b.goal) {
      const gx = tileOf(b.goal.x);
      const gy = tileOf(b.goal.y);
      const key = `${gx},${gy}`;
      b.repath -= dt;
      if (key !== b.pathKey || b.repath <= 0 || !b.path) {
        b.path = findPath(tileOf(p.x), tileOf(p.y), gx, gy) || [];
        b.pathKey = key;
        b.repath = 0.6;
      }
      while (b.path.length) {
        const c = center(b.path[0][0], b.path[0][1]);
        if (Math.hypot(c.x - p.x, c.y - p.y) > 4) break;
        b.path.shift();
      }
      const wp = b.path.length ? center(b.path[0][0], b.path[0][1]) : b.goal;
      const dx = wp.x - p.x;
      const dy = wp.y - p.y;
      const len = Math.hypot(dx, dy);
      if (len > 2) {
        mx = dx / len;
        my = dy / len;
      }
    }

    // 交戰時左右閃避
    if (b.mode === 'engage' && b.target) {
      b.strafeSwap -= dt;
      if (b.strafeSwap <= 0) {
        b.strafe = -b.strafe;
        b.strafeSwap = 0.6 + Math.random() * 1.0;
      }
      const dx = b.target.x - p.x;
      const dy = b.target.y - p.y;
      const len = Math.hypot(dx, dy) || 1;
      const w = b.goal ? 0.4 : 0.9;
      mx += (-dy / len) * b.strafe * w;
      my += (dx / len) * b.strafe * w;
    }

    // 卡住了就隨便往一個方向走一下
    const wantMove = Math.hypot(mx, my) > 0.1;
    if (wantMove && Math.hypot(p.x - b.lastX, p.y - b.lastY) < 0.05) {
      b.stuckT += dt;
      if (b.stuckT > 0.35) {
        const a = Math.random() * Math.PI * 2;
        b.jx = Math.cos(a);
        b.jy = Math.sin(a);
        b.jitter = 0.3;
        b.stuckT = 0;
        b.path = null;
      }
    } else {
      b.stuckT = 0;
    }
  }
  b.lastX = p.x;
  b.lastY = p.y;

  const len = Math.hypot(mx, my);
  p.moveX = len > 0.1 ? mx / len : 0;
  p.moveY = len > 0.1 ? my / len : 0;
  if (b.target) p.aim = Math.atan2(b.target.y - p.y, b.target.x - p.x);
  else if (len > 0.1) p.aim = Math.atan2(my, mx);
}

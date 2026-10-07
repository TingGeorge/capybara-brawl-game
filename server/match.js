// 一場對戰的完整模擬。伺服器是唯一的裁判：位置、傷害、擊倒都在這裡算。
import {
  DT, TILE, PLAYER_RADIUS, PLAYER_HALF, SNAPSHOT_EVERY, COUNTDOWN_SECONDS, RESPAWN_SECONDS,
  SPAWN_SHIELD_SECONDS, REGEN_DELAY, REGEN_RATE, SPRING_HEAL_RATE, BUSH_REVEAL_DIST,
  REVEAL_AFTER_ATTACK, FLAG,
} from '../shared/constants.js';
import { CHAR_BY_ID } from '../shared/characters.js';
import { SPAWN_POINTS, WORLD_W, WORLD_H, startPoint, tileAtPos } from '../shared/map.js';
import { moveBox, boxHitsWall, lineOfSight, moveMultiplier, stepMove, angleDiff } from '../shared/physics.js';
import { updateBot } from './bot.js';

const MAX_INPUTS_PER_TICK = 8;
const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;

export class Match {
  constructor({ players, koTarget, duration, send }) {
    this.time = 0;
    this.tickCount = 0;
    this.phase = 'countdown';
    this.startTime = COUNTDOWN_SECONDS;
    this.endTime = COUNTDOWN_SECONDS + duration;
    this.koTarget = koTarget;
    this.send = send;
    this.score = { blue: 0, red: 0 };
    this.players = new Map();
    this.projectiles = [];
    this.spawned = [];
    this.zones = [];
    this.events = [];
    this.nextId = 1;
    this.winner = null;

    const slots = { blue: 0, red: 0 };
    for (const info of players) this.addPlayer(info, slots[info.team]++);
  }

  addPlayer(info, slot) {
    const char = CHAR_BY_ID[info.charId];
    const start = startPoint(info.team, slot);
    this.players.set(info.id, {
      id: info.id,
      name: info.name,
      team: info.team,
      char,
      isBot: !!info.isBot,
      x: start.x,
      y: start.y,
      hp: char.hp,
      alive: true,
      respawnAt: 0,
      ammo: char.ammo,
      lastAttackAt: -99,
      superCharge: 0,
      aim: info.team === 'blue' ? 0 : Math.PI,
      stunUntil: 0,
      shieldUntil: 0,
      spinUntil: 0,
      spinNext: 0,
      protectUntil: 0,
      revealUntil: 0,
      lastHurtAt: -99,
      dash: null,
      leap: null,
      inBush: false,
      moving: false,
      vx: 0,
      vy: 0,
      inputs: [],
      lastSeq: 0,
      wantAttack: null,
      wantSuper: null,
      moveX: 0,
      moveY: 0,
      bot: null,
      kills: 0,
      deaths: 0,
      damageDealt: 0,
    });
  }

  enemiesOf(p) {
    const list = [];
    for (const e of this.players.values()) {
      if (e.team !== p.team && e.alive) list.push(e);
    }
    return list;
  }

  // ---------- 玩家輸入 ----------

  queueInputs(id, list, aim) {
    const p = this.players.get(id);
    if (!p || p.isBot || !Array.isArray(list)) return;
    for (const item of list) {
      if (!Array.isArray(item)) continue;
      const [seq, mx, my] = item;
      if (!Number.isFinite(seq) || seq <= p.lastSeq) continue;
      p.inputs.push([seq, Math.sign(mx) || 0, Math.sign(my) || 0]);
    }
    if (p.inputs.length > 30) {
      p.lastSeq = p.inputs[p.inputs.length - 31][0];
      p.inputs.splice(0, p.inputs.length - 30);
    }
    if (Number.isFinite(aim)) p.aim = aim;
  }

  queueAttack(id, angle, dist, isSuper) {
    const p = this.players.get(id);
    if (!p || p.isBot || !Number.isFinite(angle)) return;
    const req = { a: angle, d: Number.isFinite(dist) ? Math.max(0, dist) : 999 };
    if (isSuper) p.wantSuper = req;
    else p.wantAttack = req;
  }

  makeBot(id) {
    const p = this.players.get(id);
    if (!p) return;
    p.isBot = true;
    p.inputs.length = 0;
    p.name = `${p.name}（電腦）`;
  }

  // ---------- 主迴圈 ----------

  tick() {
    if (this.phase === 'ended') return;
    const dt = DT;
    this.time += dt;
    this.tickCount++;
    if (this.phase === 'countdown' && this.time >= this.startTime) {
      this.phase = 'playing';
      this.events.push({ k: 'go' });
    }
    const active = this.phase === 'playing';

    for (const p of this.players.values()) this.updatePlayer(p, dt, active);
    if (active) {
      this.updateProjectiles(dt);
      this.updateZones();
      if (this.time >= this.endTime) this.finish();
    }
    if (this.tickCount % SNAPSHOT_EVERY === 0 || this.phase === 'ended') this.broadcastSnapshot();
  }

  updatePlayer(p, dt, active) {
    const t = this.time;
    const prevX = p.x;
    const prevY = p.y;

    if (!p.alive) {
      if (p.inputs.length) p.lastSeq = p.inputs[p.inputs.length - 1][0];
      p.inputs.length = 0;
      p.wantAttack = p.wantSuper = null;
      if (active && t >= p.respawnAt) this.respawn(p);
      return;
    }

    if (p.isBot && active) updateBot(this, p, dt);

    if (p.leap) this.updateLeap(p);
    else if (p.dash) this.updateDash(p, dt);

    // 每一步都重新算速度倍率（例如走進水裡），和瀏覽器端的預測完全一致
    const flags = this.moveFlags(p);
    const step = (mx, my, stepDt) => {
      const speed = active ? p.char.speed * moveMultiplier(flags, p.x, p.y) : 0;
      if (speed > 0) [p.x, p.y] = stepMove(p.x, p.y, mx, my, speed, stepDt);
    };
    if (p.isBot) {
      step(p.moveX, p.moveY, dt);
    } else {
      let n = 0;
      while (p.inputs.length && n < MAX_INPUTS_PER_TICK) {
        const [seq, mx, my] = p.inputs.shift();
        p.lastSeq = seq;
        step(mx, my, DT);
        n++;
      }
    }

    if (active && p.wantAttack) this.tryAttack(p, p.wantAttack.a, p.wantAttack.d);
    if (active && p.wantSuper) this.trySuper(p, p.wantSuper.a, p.wantSuper.d);
    p.wantAttack = p.wantSuper = null;

    if (p.ammo < p.char.ammo) p.ammo = Math.min(p.char.ammo, p.ammo + dt / p.char.reload);

    if (active) {
      const max = p.char.hp;
      if (t - p.lastHurtAt >= REGEN_DELAY && t - p.lastAttackAt >= REGEN_DELAY) this.heal(p, max * REGEN_RATE * dt);
      if (tileAtPos(p.x, p.y) === 'h') this.heal(p, max * SPRING_HEAL_RATE * dt);
      if (t < p.spinUntil && t >= p.spinNext) this.spinHit(p);
    }

    p.inBush = tileAtPos(p.x, p.y) === 'b';
    p.moving = p.x !== prevX || p.y !== prevY;
    p.vx = p.vx * 0.8 + ((p.x - prevX) / dt) * 0.2;
    p.vy = p.vy * 0.8 + ((p.y - prevY) / dt) * 0.2;
  }

  moveFlags(p) {
    const t = this.time;
    let f = 0;
    if (t < p.stunUntil) f |= FLAG.STUN;
    if (t < p.shieldUntil) f |= FLAG.SHIELD;
    if (t < p.spinUntil) f |= FLAG.SPIN;
    if (p.dash) f |= FLAG.DASH;
    if (p.leap) f |= FLAG.LEAP;
    return f;
  }

  respawn(p) {
    const points = SPAWN_POINTS[p.team];
    const pt = points[Math.floor(Math.random() * points.length)];
    p.x = pt.x;
    p.y = pt.y;
    p.alive = true;
    p.hp = p.char.hp;
    p.ammo = p.char.ammo;
    p.protectUntil = this.time + SPAWN_SHIELD_SECONDS;
    p.lastHurtAt = -99;
    p.vx = p.vy = 0;
    this.events.push({ k: 'spawn', i: p.id });
  }

  // ---------- 攻擊 ----------

  canAct(p) {
    return p.alive && !p.leap && !p.dash && this.time >= p.stunUntil;
  }

  tryAttack(p, angle, dist) {
    const ch = p.char;
    if (!this.canAct(p)) return false;
    if (p.ammo < 1 || this.time - p.lastAttackAt < ch.cooldown) return false;
    p.ammo -= 1;
    p.lastAttackAt = this.time;
    p.revealUntil = this.time + REVEAL_AFTER_ATTACK;
    p.aim = angle;
    this.events.push({ k: 'atk', i: p.id, a: r2(angle) });
    this.perform(p, ch.attack, angle, dist, true);
    return true;
  }

  trySuper(p, angle, dist) {
    if (!this.canAct(p) || p.superCharge < 1) return false;
    const s = p.char.super;
    const t = this.time;
    p.superCharge = 0;
    p.revealUntil = t + REVEAL_AFTER_ATTACK;
    p.aim = angle;
    this.events.push({ k: 'sup', i: p.id, a: r2(angle) });
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);

    switch (s.kind) {
      case 'bullet':
      case 'lob':
        this.perform(p, s, angle, dist, false);
        break;
      case 'trap': {
        const pt = this.clampTarget(p, angle, dist, s.range);
        const mine = this.zones.filter((z) => z.kind === 'trap' && z.owner === p.id);
        if (mine.length >= s.max) this.zones.splice(this.zones.indexOf(mine[0]), 1);
        this.zones.push({
          id: this.nextId++, kind: 'trap', owner: p.id, team: p.team, x: pt.x, y: pt.y,
          r: s.radius, until: t + s.life, damage: s.damage, stun: s.stun, armAt: t + 0.35,
        });
        break;
      }
      case 'spin':
        p.spinUntil = t + s.duration;
        p.spinNext = t;
        break;
      case 'dash':
        p.dash = { dx, dy, left: s.distance, hit: new Set() };
        break;
      case 'leap': {
        const pt = this.clampTarget(p, angle, dist, s.range);
        p.leap = { sx: p.x, sy: p.y, tx: pt.x, ty: pt.y, t0: t, t1: t + s.duration };
        break;
      }
      case 'shield':
        p.shieldUntil = t + s.duration;
        break;
      case 'zone': {
        const pt = this.clampTarget(p, angle, dist, s.range);
        this.zones.push({
          id: this.nextId++, kind: 'spring', owner: p.id, team: p.team, x: pt.x, y: pt.y,
          r: s.radius, until: t + s.duration, next: t, heal: s.heal, damage: s.damage,
        });
        break;
      }
    }
    return true;
  }

  // 目標點：最遠不超過 range，而且不能落在牆裡
  clampTarget(p, angle, dist, range) {
    const d = Math.min(Math.max(dist, 8), range);
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    for (let k = d; k > 0; k -= 4) {
      const x = Math.min(WORLD_W - TILE, Math.max(TILE, p.x + dx * k));
      const y = Math.min(WORLD_H - TILE, Math.max(TILE, p.y + dy * k));
      if (!boxHitsWall(x, y, PLAYER_HALF)) return { x, y };
    }
    return { x: p.x, y: p.y };
  }

  perform(p, spec, angle, dist, isMain) {
    if (spec.kind === 'bullet') {
      const n = spec.count || 1;
      for (let i = 0; i < n; i++) {
        const a = n > 1 ? angle - spec.spread / 2 + (spec.spread * i) / (n - 1) : angle;
        this.spawnBullet(p.id, p.team, p.x + Math.cos(a) * 6, p.y + Math.sin(a) * 6, a, spec, isMain);
      }
    } else if (spec.kind === 'lob') {
      const n = spec.count || 1;
      const d = Math.min(Math.max(dist, 16), spec.range);
      const cx = p.x + Math.cos(angle) * d;
      const cy = p.y + Math.sin(angle) * d;
      for (let i = 0; i < n; i++) {
        let tx = cx;
        let ty = cy;
        if (n > 1) {
          const a = (i / n) * Math.PI * 2 + Math.random() * 0.6;
          const r = i === 0 ? 0 : spec.scatter * (0.6 + Math.random() * 0.4);
          tx += Math.cos(a) * r;
          ty += Math.sin(a) * r;
        }
        tx = Math.min(WORLD_W - TILE, Math.max(TILE, tx));
        ty = Math.min(WORLD_H - TILE, Math.max(TILE, ty));
        this.projectiles.push({
          id: this.nextId++, kind: 'lob', owner: p.id, team: p.team, sx: p.x, sy: p.y, tx, ty,
          t0: this.time, t1: this.time + spec.flight + i * 0.06, damage: spec.damage, aoe: spec.aoe,
          sprite: spec.sprite, split: spec.split || null, main: isMain,
        });
      }
    } else if (spec.kind === 'melee') {
      this.events.push({ k: 'slash', i: p.id, a: r2(angle), r: spec.range, w: spec.arc });
      for (const e of this.enemiesOf(p)) {
        if (e.leap) continue;
        const dx = e.x - p.x;
        const dy = e.y - p.y;
        const d = Math.hypot(dx, dy);
        if (d > spec.range + PLAYER_RADIUS) continue;
        if (d > 6 && Math.abs(angleDiff(Math.atan2(dy, dx), angle)) > spec.arc / 2 + 0.15) continue;
        if (!lineOfSight(p.x, p.y, e.x, e.y)) continue;
        this.damage(e, spec.damage, p, isMain);
        if (spec.knockback) this.knock(e, dx, dy, spec.knockback);
      }
    }
  }

  spawnBullet(owner, team, x, y, angle, spec, isMain) {
    this.spawned.push({
      id: this.nextId++, kind: 'bullet', owner, team, x, y,
      vx: Math.cos(angle) * spec.speed, vy: Math.sin(angle) * spec.speed,
      range: spec.range, traveled: 0, damage: spec.damage, radius: spec.radius,
      pierce: !!spec.pierce, bounce: spec.bounce || 0, hit: new Set(), sprite: spec.sprite, main: isMain,
    });
  }

  spinHit(p) {
    const s = p.char.super;
    p.spinNext = this.time + s.interval;
    for (const e of this.enemiesOf(p)) {
      if (e.leap) continue;
      if (Math.hypot(e.x - p.x, e.y - p.y) <= s.radius + PLAYER_RADIUS) this.damage(e, s.damage, p, false);
    }
  }

  updateDash(p, dt) {
    const s = p.char.super;
    const d = p.dash;
    const step = Math.min(d.left, s.speed * dt);
    const [nx, ny] = moveBox(p.x, p.y, d.dx * step, d.dy * step);
    const moved = Math.hypot(nx - p.x, ny - p.y);
    p.x = nx;
    p.y = ny;
    d.left -= step;
    for (const e of this.enemiesOf(p)) {
      if (e.leap || d.hit.has(e.id)) continue;
      if (Math.hypot(e.x - p.x, e.y - p.y) <= s.width + PLAYER_RADIUS) {
        d.hit.add(e.id);
        this.damage(e, s.damage, p, false);
        this.knock(e, d.dx, d.dy, s.knockback);
      }
    }
    if (d.left <= 0 || moved < step * 0.3) p.dash = null;
  }

  updateLeap(p) {
    const L = p.leap;
    const u = Math.min(1, (this.time - L.t0) / (L.t1 - L.t0));
    p.x = L.sx + (L.tx - L.sx) * u;
    p.y = L.sy + (L.ty - L.sy) * u;
    if (u < 1) return;
    p.leap = null;
    const s = p.char.super;
    this.events.push({ k: 'boom', x: r1(p.x), y: r1(p.y), r: s.aoe, sp: 'slam' });
    for (const e of this.enemiesOf(p)) {
      if (e.leap) continue;
      const dx = e.x - p.x;
      const dy = e.y - p.y;
      if (Math.hypot(dx, dy) <= s.aoe + PLAYER_RADIUS) {
        this.damage(e, s.damage, p, false);
        this.knock(e, dx, dy, s.knockback);
      }
    }
  }

  knock(e, dx, dy, amount) {
    if (!e.alive || e.leap) return;
    const len = Math.hypot(dx, dy) || 1;
    for (let i = 0; i < 4; i++) {
      [e.x, e.y] = moveBox(e.x, e.y, (dx / len) * (amount / 4), (dy / len) * (amount / 4));
    }
  }

  // ---------- 傷害與回血 ----------

  damage(target, amount, attacker, isMain) {
    const t = this.time;
    if (!target.alive || target.leap || t < target.protectUntil) return 0;
    if (t < target.shieldUntil) amount *= 1 - target.char.super.reduction;
    amount = Math.round(amount);
    target.hp -= amount;
    target.lastHurtAt = t;
    target.revealUntil = Math.max(target.revealUntil, t + 0.5);
    this.events.push({ k: 'hit', i: target.id, v: amount, s: attacker ? attacker.id : null });
    if (attacker) {
      attacker.damageDealt += amount;
      if (isMain) attacker.superCharge = Math.min(1, attacker.superCharge + amount * attacker.char.chargePerDamage);
    }
    if (target.hp <= 0) this.kill(target, attacker);
    return amount;
  }

  heal(p, amount, show = false) {
    if (!p.alive || p.hp >= p.char.hp) return;
    const before = p.hp;
    p.hp = Math.min(p.char.hp, p.hp + amount);
    if (show) this.events.push({ k: 'heal', i: p.id, v: Math.round(p.hp - before) });
  }

  kill(target, attacker) {
    target.hp = 0;
    target.alive = false;
    target.deaths++;
    target.respawnAt = this.time + RESPAWN_SECONDS;
    target.dash = target.leap = null;
    target.spinUntil = target.shieldUntil = target.stunUntil = 0;
    target.inputs.length = 0;
    if (attacker && attacker.team !== target.team) {
      attacker.kills++;
      this.score[attacker.team]++;
    }
    this.events.push({ k: 'ko', i: target.id, s: attacker ? attacker.id : null, x: r1(target.x), y: r1(target.y) });
    if (attacker && this.score[attacker.team] >= this.koTarget) this.finish();
  }

  // ---------- 子彈與場地效果 ----------

  updateProjectiles(dt) {
    const t = this.time;
    const keep = [];
    for (const pr of this.projectiles) {
      if (pr.kind === 'lob') {
        if (t >= pr.t1) this.explode(pr);
        else keep.push(pr);
        continue;
      }
      if (this.moveBullet(pr, dt)) keep.push(pr);
    }
    // 這一幀新發射的子彈從下一幀開始移動
    this.projectiles = keep.concat(this.spawned);
    this.spawned = [];
  }

  moveBullet(pr, dt) {
    const steps = 3;
    for (let s = 0; s < steps; s++) {
      const sdt = dt / steps;
      const nx = pr.x + pr.vx * sdt;
      const ny = pr.y + pr.vy * sdt;
      if (boxHitsWall(nx, ny, 0.5)) {
        if (pr.bounce > 0) {
          pr.bounce--;
          const hitX = boxHitsWall(nx, pr.y, 0.5);
          const hitY = boxHitsWall(pr.x, ny, 0.5);
          if (hitX) pr.vx = -pr.vx;
          if (hitY) pr.vy = -pr.vy;
          if (!hitX && !hitY) {
            pr.vx = -pr.vx;
            pr.vy = -pr.vy;
          }
          pr.hit.clear();
          this.events.push({ k: 'bonk', x: r1(pr.x), y: r1(pr.y) });
          continue;
        }
        this.events.push({ k: 'pop', x: r1(pr.x), y: r1(pr.y), sp: pr.sprite });
        return false;
      }
      pr.traveled += Math.hypot(nx - pr.x, ny - pr.y);
      pr.x = nx;
      pr.y = ny;
      const owner = this.players.get(pr.owner);
      for (const e of this.players.values()) {
        if (e.team === pr.team || !e.alive || e.leap || pr.hit.has(e.id)) continue;
        const rr = pr.radius + PLAYER_RADIUS;
        if ((e.x - pr.x) ** 2 + (e.y - pr.y) ** 2 > rr * rr) continue;
        pr.hit.add(e.id);
        this.damage(e, pr.damage, owner, pr.main);
        if (!pr.pierce) {
          this.events.push({ k: 'pop', x: r1(pr.x), y: r1(pr.y), sp: pr.sprite });
          return false;
        }
      }
      if (pr.traveled >= pr.range) {
        this.events.push({ k: 'fizz', x: r1(pr.x), y: r1(pr.y), sp: pr.sprite });
        return false;
      }
    }
    return true;
  }

  explode(pr) {
    const owner = this.players.get(pr.owner);
    this.events.push({ k: 'boom', x: r1(pr.tx), y: r1(pr.ty), r: pr.aoe, sp: pr.sprite });
    for (const e of this.players.values()) {
      if (e.team === pr.team || !e.alive || e.leap) continue;
      if (Math.hypot(e.x - pr.tx, e.y - pr.ty) <= pr.aoe + PLAYER_RADIUS) this.damage(e, pr.damage, owner, pr.main);
    }
    if (pr.split) {
      const n = pr.split.count;
      const offset = Math.random() * Math.PI;
      for (let i = 0; i < n; i++) {
        const a = offset + (i / n) * Math.PI * 2;
        this.spawnBullet(pr.owner, pr.team, pr.tx, pr.ty, a, pr.split, false);
      }
    }
  }

  updateZones() {
    const t = this.time;
    this.zones = this.zones.filter((z) => {
      if (t >= z.until) return false;
      const owner = this.players.get(z.owner);
      if (z.kind === 'trap') {
        if (t < z.armAt) return true;
        for (const e of this.players.values()) {
          if (e.team === z.team || !e.alive || e.leap) continue;
          if (Math.hypot(e.x - z.x, e.y - z.y) > z.r + PLAYER_RADIUS) continue;
          if (t >= e.protectUntil) e.stunUntil = t + z.stun;
          e.dash = null;
          this.events.push({ k: 'slip', i: e.id, x: r1(z.x), y: r1(z.y) });
          this.damage(e, z.damage, owner, false);
          return false;
        }
        return true;
      }
      if (z.kind === 'spring' && t >= z.next) {
        z.next = t + 0.5;
        for (const e of this.players.values()) {
          if (!e.alive || e.leap) continue;
          if (Math.hypot(e.x - z.x, e.y - z.y) > z.r + PLAYER_RADIUS * 0.5) continue;
          if (e.team === z.team) this.heal(e, z.heal * 0.5, true);
          else this.damage(e, z.damage * 0.5, owner, false);
        }
      }
      return true;
    });
  }

  // ---------- 草叢與視野 ----------

  isHidden(p) {
    return p.alive && p.inBush && this.time >= p.revealUntil;
  }

  visibleTo(team, p) {
    if (p.team === team || !this.isHidden(p)) return true;
    for (const ally of this.players.values()) {
      if (ally.team !== team || !ally.alive) continue;
      if (Math.hypot(ally.x - p.x, ally.y - p.y) <= BUSH_REVEAL_DIST) return true;
    }
    return false;
  }

  // ---------- 結束與快照 ----------

  finish() {
    if (this.phase === 'ended') return;
    this.phase = 'ended';
    const { blue, red } = this.score;
    this.winner = blue === red ? 'draw' : blue > red ? 'blue' : 'red';
    this.events.push({ k: 'end', w: this.winner });
  }

  results() {
    return {
      winner: this.winner,
      score: [this.score.blue, this.score.red],
      players: [...this.players.values()].map((p) => ({
        id: p.id, name: p.name, team: p.team, charId: p.char.id, isBot: p.isBot,
        kills: p.kills, deaths: p.deaths, damage: p.damageDealt,
      })),
    };
  }

  broadcastSnapshot() {
    const t = this.time;
    const clock = this.phase === 'countdown' ? this.startTime - t : this.endTime - t;
    const snap = {
      t: 's',
      tm: Math.round(t * 1000),
      ph: this.phase,
      cl: r1(Math.max(0, clock)),
      sc: [this.score.blue, this.score.red],
      p: [],
      pr: [],
      z: [],
      ev: this.events,
    };
    for (const p of this.players.values()) {
      let f = this.moveFlags(p);
      if (t < p.protectUntil) f |= FLAG.PROTECT;
      if (this.isHidden(p)) f |= FLAG.HIDDEN;
      if (this.visibleTo('blue', p)) f |= FLAG.SEEN_BLUE;
      if (this.visibleTo('red', p)) f |= FLAG.SEEN_RED;
      if (p.moving) f |= FLAG.MOVING;
      const o = {
        i: p.id, x: r2(p.x), y: r2(p.y), h: Math.ceil(p.hp), a: r2(p.aim), al: p.alive ? 1 : 0,
        am: r2(p.ammo), su: r2(p.superCharge), q: p.lastSeq, f, k: p.kills, d: p.deaths,
      };
      if (!p.alive) o.rs = r1(Math.max(0, p.respawnAt - t));
      if (p.leap) o.lp = [r1(p.leap.sx), r1(p.leap.sy), r1(p.leap.tx), r1(p.leap.ty), Math.round(p.leap.t0 * 1000), Math.round(p.leap.t1 * 1000)];
      snap.p.push(o);
    }
    for (const pr of this.projectiles) {
      if (pr.kind === 'lob') {
        snap.pr.push({ i: pr.id, k: 1, sp: pr.sprite, l: [r1(pr.sx), r1(pr.sy), r1(pr.tx), r1(pr.ty), Math.round(pr.t0 * 1000), Math.round(pr.t1 * 1000)] });
      } else {
        snap.pr.push({ i: pr.id, k: 0, sp: pr.sprite, x: r1(pr.x), y: r1(pr.y), vx: Math.round(pr.vx), vy: Math.round(pr.vy), tm: pr.team === 'blue' ? 0 : 1 });
      }
    }
    for (const z of this.zones) {
      snap.z.push({ i: z.id, k: z.kind, x: r1(z.x), y: r1(z.y), r: z.r, tm: z.team === 'blue' ? 0 : 1, u: Math.round(z.until * 1000) });
    }
    this.events = [];
    this.send(JSON.stringify(snap));
  }
}

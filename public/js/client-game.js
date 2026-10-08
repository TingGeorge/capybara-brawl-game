// 瀏覽器端的對戰邏輯：
// - 自己的水豚：按鍵當下就先在本地移動（預測），收到伺服器結果後再校正，手感才不會延遲。
// - 其他人和子彈：在兩張伺服器快照之間做插值，畫面才會滑順。
import { DT, FLAG, TILE } from '../shared/constants.js';
import { CHAR_BY_ID } from '../shared/characters.js';
import { WORLD_W, WORLD_H } from '../shared/map.js';
import { stepMove, moveMultiplier } from '../shared/physics.js';

// 其他人畫在「70 毫秒前」的位置，兩張快照之間才有得內插。
// 手機的 Wi-Fi 偶爾會慢個一兩百毫秒，這時自動多等一點（最多 160 毫秒），網路穩了再慢慢縮回來
const INTERP_MS = 70;
const INTERP_MAX = 160;
const PREDICT_BLOCK = FLAG.STUN | FLAG.DASH | FLAG.LEAP;
const MOVE_FLAGS = FLAG.STUN | FLAG.SHIELD | FLAG.SPIN | FLAG.DASH | FLAG.LEAP;
const IMMEDIATE = new Set(['atk', 'sup']);

const lerp = (a, b, u) => a + (b - a) * u;
const r2 = (v) => Math.round(v * 100) / 100;
const clamp01 = (v) => Math.max(0, Math.min(1, v));
function lerpAngle(a, b, u) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * u;
}

function aimSpec(spec) {
  switch (spec.kind) {
    case 'bullet': return { kind: 'bullet', range: spec.range, spread: (spec.count || 1) > 1 ? spec.spread : 0 };
    case 'lob': return { kind: 'lob', range: spec.range, aoe: spec.aoe + (spec.scatter || 0) };
    case 'melee': return { kind: 'melee', range: spec.range, arc: spec.arc };
    case 'trap': return { kind: 'trap', range: spec.range, aoe: spec.radius };
    case 'zone': return { kind: 'zone', range: spec.range, aoe: spec.radius };
    case 'leap': return { kind: 'leap', range: spec.range, aoe: spec.aoe };
    case 'dash': return { kind: 'dash', range: spec.distance };
    case 'spin': return { kind: 'spin', range: 0, aoe: spec.radius };
    case 'shield': return { kind: 'shield', range: 0, aoe: 14 };
    default: return { kind: 'bullet', range: 0 };
  }
}

export class ClientGame {
  constructor({ info, myId, net, input, renderer, audio, ui }) {
    this.info = info;
    this.net = net;
    this.input = input;
    this.renderer = renderer;
    this.audio = audio;
    this.ui = ui;
    this.byId = new Map(info.players.map((p) => [p.id, p]));
    this.me = info.spectator ? null : this.byId.get(myId) || null;
    this.myId = this.me ? myId : null;
    this.myTeam = this.me ? this.me.team : null;
    this.char = this.me ? CHAR_BY_ID[this.me.charId] : null;

    this.snaps = [];
    this.latest = null;
    this.latestAt = 0;
    this.offset = null;
    this.late = 0; // 最近快照晚到的幅度（毫秒），會慢慢衰減
    this.interp = INTERP_MS;
    this.mySnap = null;
    this.pending = [];
    this.outbox = [];
    this.seq = 0;
    this.acc = 0;
    this.pred = null;
    this.prevPred = null; // 上一個固定步的預測位置：畫面在兩步之間內插，移動才滑順
    this.smooth = { x: 0, y: 0 };
    this.events = [];
    this.lastFrame = performance.now();
    this.lastAtkSent = 0;
    this.aim = this.myTeam === 'red' ? Math.PI : 0;
    this.aimDist = 60;
    this.camera = { x: WORLD_W / 2, y: WORLD_H / 2 };
    this.cameraReady = false;
    this.locked = false;
    this.lastBeep = null;
    this.superWasReady = false;
    this.ended = false;
    this.ping = null;
    this.lastState = null;
  }

  // ---------- 伺服器快照 ----------

  onSnapshot(s) {
    const now = performance.now();
    const sample = s.tm - now;
    this.offset = this.offset === null ? sample : Math.max(sample, this.offset - 0.5);
    this.late = Math.max(this.offset - sample, this.late * 0.98);
    const want = Math.min(INTERP_MAX, Math.max(INTERP_MS, 40 + this.late * 1.2));
    this.interp += (want - this.interp) * 0.05;
    this.snaps.push(s);
    if (this.snaps.length > 40) this.snaps.shift();
    this.latest = s;
    this.latestAt = now;
    for (const ev of s.ev) {
      if (IMMEDIATE.has(ev.k) && ev.i === this.myId) this.applyEvent(ev, s);
      else this.events.push({ tm: s.tm, ev, snap: s });
    }
    this.reconcile(s);
  }

  reconcile(s) {
    if (!this.me) return;
    const sp = s.p.find((p) => p.i === this.myId);
    if (!sp) return;
    this.mySnap = sp;
    this.pending = this.pending.filter((inp) => inp.seq > sp.q);
    if (!sp.al) {
      this.pred = this.prevPred = null;
      this.smooth.x = this.smooth.y = 0;
      return;
    }
    let x = sp.x;
    let y = sp.y;
    if (s.ph === 'playing' && !(sp.f & PREDICT_BLOCK)) {
      for (const inp of this.pending) [x, y] = this.stepLocal(x, y, inp.mx, inp.my, sp.f);
    }
    if (this.pred) {
      const ex = this.pred.x + this.smooth.x - x;
      const ey = this.pred.y + this.smooth.y - y;
      if (Math.hypot(ex, ey) < 24) {
        this.smooth.x = ex;
        this.smooth.y = ey;
      } else {
        this.smooth.x = this.smooth.y = 0;
      }
      // 上一步的位置跟著一起校正，內插才不會跳
      if (this.prevPred) {
        this.prevPred.x += x - this.pred.x;
        this.prevPred.y += y - this.pred.y;
      }
    }
    this.pred = { x, y };
  }

  stepLocal(x, y, mx, my, flags) {
    const mul = moveMultiplier(flags & MOVE_FLAGS, x, y);
    return stepMove(x, y, mx, my, this.char.speed * mul, DT);
  }

  canMoveLocally() {
    return !!(this.me && this.pred && this.mySnap && this.mySnap.al && this.latest && this.latest.ph === 'playing'
      && !(this.mySnap.f & PREDICT_BLOCK));
  }

  // 固定 60 次/秒 取樣方向鍵（或手機搖桿），送給伺服器，同時在本地先走
  fixedStep(mx, my) {
    if (!this.me) return;
    // 搖桿的方向取到小數兩位，和伺服器收到的完全一樣，預測才不會有誤差
    mx = r2(mx);
    my = r2(my);
    const seq = ++this.seq;
    this.pending.push({ seq, mx, my });
    if (this.pending.length > 120) this.pending.shift();
    this.outbox.push([seq, mx, my]);
    if (this.canMoveLocally()) {
      this.prevPred = { x: this.pred.x, y: this.pred.y };
      [this.pred.x, this.pred.y] = this.stepLocal(this.pred.x, this.pred.y, mx, my, this.mySnap.f);
    } else if (this.pred) {
      this.prevPred = null;
    }
  }

  // ---------- 每一幀 ----------

  frame(now) {
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    if (!this.latest) return;

    const input = this.input;
    const active = !this.ended && this.me;
    const mx = active ? input.moveX : 0;
    const my = active ? input.moveY : 0;
    this.acc += dt;
    while (this.acc >= DT) {
      this.acc -= DT;
      this.fixedStep(mx, my);
    }
    const k = Math.exp(-dt * 12);
    this.smooth.x *= k;
    this.smooth.y *= k;

    const myPos = this.myDisplayPos();
    if (myPos) this.updateAim(myPos, mx, my);
    if (this.outbox.length) {
      this.net.send({ t: 'in', l: this.outbox, a: Math.round(this.aim * 100) / 100 });
      this.outbox = [];
    }

    if (active) this.handleAttacks(now);

    const rt = now + this.offset - this.interp;
    const state = this.buildState(now, rt);
    this.flushEvents(rt, state);
    this.updateCamera(dt, state);
    state.camera = this.camera;
    this.renderer.render(state);
    this.updateHUD(now, state);
    this.lastState = state;
  }

  // 滑鼠：瞄準游標的位置。手機：拖曳按鈕時照按鈕的方向和距離瞄準，沒在瞄準時面向走路的方向
  updateAim(myPos, mx, my) {
    const input = this.input;
    if (input.mode === 'touch') {
      const t = input.touchAim;
      if (t) {
        this.aim = t.angle;
        this.aimDist = this.touchDist(t);
      } else if (mx || my) {
        this.aim = Math.atan2(my, mx);
      }
      return;
    }
    const mouse = this.renderer.screenToWorld(input.mouseX, input.mouseY);
    this.aim = Math.atan2(mouse.y - myPos.y, mouse.x - myPos.x);
    this.aimDist = Math.hypot(mouse.x - myPos.x, mouse.y - myPos.y);
  }

  aimRange(isSuper) {
    return aimSpec(isSuper ? this.char.super : this.char.attack).range || 0;
  }

  // 拖曳的長度 → 丟多遠（拋物線攻擊、跳躍、陷阱才用得到；直線子彈不管距離）
  touchDist(t) {
    return this.aimRange(t.super) * (0.15 + 0.85 * t.power);
  }

  // 點一下按鈕：瞄準最近、看得到、打得到的敵人；附近沒有就往面對的方向打
  autoAim(isSuper) {
    const pos = this.myDisplayPos();
    const range = this.aimRange(isSuper);
    let best = null;
    let bestDist = Infinity;
    for (const p of (this.lastState && this.lastState.players) || []) {
      if (p.isMe || !p.alive || p.team === this.myTeam) continue;
      const d = Math.hypot(p.x - pos.x, p.y - pos.y);
      if (d < bestDist) {
        best = p;
        bestDist = d;
      }
    }
    if (!best || bestDist > Math.max(range, 40) * 1.1) return { a: this.aim, d: range };
    const t = this.leadTarget(best, pos, isSuper ? this.char.super : this.char.attack);
    return { a: Math.atan2(t.y - pos.y, t.x - pos.x), d: Math.hypot(t.x - pos.x, t.y - pos.y) };
  }

  // 和電腦水豚一樣會預判：用最新兩張快照算出對方的速度，瞄準子彈（或丟出去的東西）到達時對方會在的位置
  leadTarget(target, pos, spec) {
    const n = this.snaps.length;
    const s1 = this.snaps[n - 1];
    const s0 = this.snaps[n - 2];
    const q1 = s1 && s1.p.find((p) => p.i === target.id);
    const q0 = s0 && s0.p.find((p) => p.i === target.id);
    if (!q1 || !q1.al) return target;
    if (!q0 || !q0.al || s1.tm <= s0.tm) return { x: q1.x, y: q1.y };
    const dt = (s1.tm - s0.tm) / 1000;
    const vx = (q1.x - q0.x) / dt;
    const vy = (q1.y - q0.y) / dt;
    if (Math.hypot(vx, vy) > 200) return { x: q1.x, y: q1.y }; // 剛復活或被撞飛，不準
    let lead = 0;
    if (spec.kind === 'bullet') lead = Math.hypot(q1.x - pos.x, q1.y - pos.y) / spec.speed;
    else if (spec.kind === 'lob') lead = spec.flight;
    return { x: q1.x + vx * lead * 0.8, y: q1.y + vy * lead * 0.8 };
  }

  handleAttacks(now) {
    const input = this.input;
    const a = r2(this.aim);
    const d = Math.round(this.aimDist);
    const clicked = input.consumeAttack();
    if (clicked || (input.attackHeld && now - this.lastAtkSent > 120)) {
      this.net.send({ t: 'atk', a, d });
      this.lastAtkSent = now;
    }
    if (input.consumeSuper()) {
      if (this.mySnap && this.mySnap.su >= 1) this.net.send({ t: 'sup', a, d });
    }
    for (const shot of input.consumeTouchShots()) {
      if (shot.super && !(this.mySnap && this.mySnap.su >= 1)) continue;
      const aim = shot.auto ? this.autoAim(shot.super) : { a: shot.angle, d: this.touchDist(shot) };
      this.aim = aim.a; // 轉身面向打出去的方向
      this.net.send({ t: shot.super ? 'sup' : 'atk', a: r2(aim.a), d: Math.round(aim.d) });
      if (!shot.super) this.lastAtkSent = now;
    }
  }

  myDisplayPos() {
    if (!this.me) return null;
    if (this.pred) {
      // 固定每秒 60 步在算位置，但畫面的幀不一定剛好對齊：畫在上一步和這一步之間，才不會一頓一頓的
      const prev = this.prevPred || this.pred;
      const u = clamp01(this.acc / DT);
      return { x: lerp(prev.x, this.pred.x, u) + this.smooth.x, y: lerp(prev.y, this.pred.y, u) + this.smooth.y };
    }
    if (this.mySnap) return { x: this.mySnap.x, y: this.mySnap.y };
    return null;
  }

  pickSnaps(rt) {
    const list = this.snaps;
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].tm <= rt) {
        const s0 = list[i];
        const s1 = list[i + 1] || s0;
        const u = s1 === s0 ? 0 : clamp01((rt - s0.tm) / (s1.tm - s0.tm));
        return [s0, s1, u];
      }
    }
    return [list[0], list[0], 0];
  }

  buildState(now, rt) {
    const [s0, s1, u] = this.pickSnaps(rt);
    const serverNow = now + this.offset;
    const seenFlag = this.myTeam === 'blue' ? FLAG.SEEN_BLUE : FLAG.SEEN_RED;
    const players = [];
    for (const p1 of s1.p) {
      const info = this.byId.get(p1.i);
      if (!info) continue;
      const isMe = p1.i === this.myId;
      const p0 = s0.p.find((p) => p.i === p1.i) || p1;
      const src = isMe && this.mySnap ? this.mySnap : p1;
      let x;
      let y;
      if (isMe) {
        const pos = this.myDisplayPos();
        x = pos.x;
        y = pos.y;
      } else if (p0.al !== p1.al) {
        x = p1.x;
        y = p1.y;
      } else {
        x = lerp(p0.x, p1.x, u);
        y = lerp(p0.y, p1.y, u);
      }
      const isAlly = !isMe && !!this.myTeam && info.team === this.myTeam;
      let flags = src.f;
      if (this.myTeam && info.team !== this.myTeam) {
        if (!(flags & seenFlag)) continue;
        flags &= ~FLAG.HIDDEN;
      }
      let z = 0;
      if (src.lp) {
        const t = isMe ? serverNow : rt;
        z = Math.sin(Math.PI * clamp01((t - src.lp[4]) / (src.lp[5] - src.lp[4]))) * 22;
      }
      const ch = CHAR_BY_ID[info.charId];
      players.push({
        id: p1.i,
        name: info.name,
        team: info.team,
        charId: info.charId,
        x,
        y,
        z,
        aim: isMe ? this.aim : lerpAngle(p0.a, p1.a, u),
        hp: src.h,
        maxHp: ch.hp,
        alive: !!src.al,
        isMe,
        isAlly,
        flags,
        moving: isMe ? this.canMoveLocally() && !!(this.input.moveX || this.input.moveY) : !!(flags & FLAG.MOVING),
        ammo: src.am,
        maxAmmo: ch.ammo,
        superCharge: src.su,
      });
    }

    const projectiles = [];
    for (const q1 of s1.pr) {
      if (q1.k === 1) {
        const [sx, sy, tx, ty, t0, t1] = q1.l;
        if (rt < t0) continue;
        const v = clamp01((rt - t0) / (t1 - t0));
        const dist = Math.hypot(tx - sx, ty - sy);
        projectiles.push({
          id: q1.i, kind: 'lob', sprite: q1.sp, x: lerp(sx, tx, v), y: lerp(sy, ty, v),
          z: Math.sin(Math.PI * v) * (10 + dist * 0.25), angle: v * 10, team: null,
        });
        continue;
      }
      const q0 = s0 === s1 ? q1 : s0.pr.find((q) => q.i === q1.i);
      if (!q0) continue;
      projectiles.push({
        id: q1.i, kind: 'bullet', sprite: q1.sp, x: lerp(q0.x, q1.x, u), y: lerp(q0.y, q1.y, u), z: 0,
        angle: Math.atan2(q1.vy, q1.vx), team: q1.tm === 0 ? 'blue' : 'red',
      });
    }

    const zones = s1.z.map((z) => ({
      id: z.i, kind: z.k, x: z.x, y: z.y, r: z.r, team: z.tm === 0 ? 'blue' : 'red',
      remaining: Math.max(0, (z.u - rt) / 1000),
    }));

    let aim = null;
    const myPos = this.myDisplayPos();
    // 手機只在拖曳按鈕瞄準時才畫瞄準線（大招沒集滿就不畫）
    const touch = this.input.mode === 'touch';
    const touchAim = touch ? this.input.touchAim : null;
    const ready = !!(this.mySnap && this.mySnap.su >= 1);
    const showAim = !touch || (touchAim && (!touchAim.super || ready));
    if (this.me && myPos && this.mySnap && this.mySnap.al && !this.ended && showAim) {
      const useSuper = (touch ? touchAim.super : this.input.superAiming) && ready;
      const spec = aimSpec(useSuper ? this.char.super : this.char.attack);
      aim = { x: myPos.x, y: myPos.y, angle: this.aim, dist: this.aimDist, isSuper: useSuper, ...spec };
    }

    return {
      now: now / 1000,
      camera: this.camera,
      myId: this.myId,
      myTeam: this.myTeam,
      players,
      projectiles,
      zones,
      aim,
    };
  }

  updateCamera(dt, state) {
    const me = state.players.find((p) => p.isMe);
    let target = null;
    if (me && me.alive) {
      // 鏡頭直接跟著自己（不取整數像素）：自己是另外用螢幕解析度畫的，畫面捲動才會一格一格的滑順，不會一頓一頓
      target = { x: me.x, y: me.y };
    } else if (this.me) {
      target = { x: this.myTeam === 'blue' ? 3 * TILE : WORLD_W - 3 * TILE, y: WORLD_H / 2 };
    } else {
      const alive = state.players.filter((p) => p.alive);
      if (alive.length) {
        target = {
          x: alive.reduce((sum, p) => sum + p.x, 0) / alive.length,
          y: alive.reduce((sum, p) => sum + p.y, 0) / alive.length,
        };
      }
    }
    if (!target) return;
    const cam = this.camera;
    if (!this.cameraReady) {
      cam.x = target.x;
      cam.y = target.y;
      this.cameraReady = true;
      return;
    }
    const far = Math.hypot(target.x - cam.x, target.y - cam.y);
    if (me && me.alive && (this.locked || far < 2)) {
      this.locked = true;
      cam.x = target.x;
      cam.y = target.y;
      return;
    }
    this.locked = false;
    const k = 1 - Math.exp(-dt * (me && me.alive ? 10 : 3));
    cam.x = lerp(cam.x, target.x, k);
    cam.y = lerp(cam.y, target.y, k);
  }

  // ---------- 事件（特效、音效、擊倒訊息） ----------

  flushEvents(rt, state) {
    let n = 0;
    while (n < this.events.length && this.events[n].tm <= rt) n++;
    if (!n) return;
    const due = this.events.splice(0, n);
    for (const { ev, snap } of due) this.applyEvent(ev, snap, state);
  }

  posOf(id, snap) {
    const p = snap && snap.p.find((q) => q.i === id);
    if (id === this.myId) {
      const pos = this.myDisplayPos();
      if (pos) return pos;
    }
    return p ? { x: p.x, y: p.y } : null;
  }

  volumeAt(x, y) {
    const d = Math.hypot(x - this.camera.x, y - this.camera.y);
    return Math.max(0.15, 1 - d / 320);
  }

  panAt(x) {
    return Math.max(-0.8, Math.min(0.8, (x - this.camera.x) / 200));
  }

  applyEvent(ev, snap) {
    const fx = this.renderer.fx;
    const audio = this.audio;
    const info = ev.i ? this.byId.get(ev.i) : null;
    const charId = info ? info.charId : null;
    const play = (name, x, y, boost = 1) => {
      audio.play(name, { volume: Math.min(1, this.volumeAt(x, y) * boost), pan: this.panAt(x) });
    };

    switch (ev.k) {
      case 'go':
        audio.play('go');
        break;
      case 'atk': {
        const pos = this.posOf(ev.i, snap);
        if (!pos || !charId) break;
        const kind = CHAR_BY_ID[charId].attack.kind;
        if (kind !== 'melee') fx.muzzle(pos.x, pos.y, ev.a, charId);
        let sound = 'shoot';
        if (kind === 'lob') sound = 'throw';
        else if (kind === 'melee') sound = charId === 'pineapple' || charId === 'pumpkin' ? 'punch' : 'slash';
        else if (charId === 'onsen') sound = 'splash';
        play(sound, pos.x, pos.y, ev.i === this.myId ? 1.2 : 0.8);
        break;
      }
      case 'sup': {
        const pos = this.posOf(ev.i, snap);
        if (!pos) break;
        fx.superCast(pos.x, pos.y, charId);
        play('super', pos.x, pos.y, ev.i === this.myId ? 1.2 : 0.9);
        break;
      }
      case 'slash': {
        const pos = this.posOf(ev.i, snap);
        if (pos) fx.slash(pos.x, pos.y, ev.a, ev.r, ev.w, charId);
        break;
      }
      case 'hit': {
        const pos = this.posOf(ev.i, snap);
        if (!pos) break;
        let style = 'other';
        if (ev.i === this.myId) style = 'taken';
        else if (ev.s === this.myId) style = 'dealt';
        fx.damage(pos.x, pos.y, ev.v, style);
        fx.hitFlash(ev.i);
        if (style === 'dealt') audio.play('hit', { volume: 0.8 });
        else if (style === 'taken') audio.play('hurt', { volume: 0.9 });
        break;
      }
      case 'heal': {
        const pos = this.posOf(ev.i, snap);
        if (!pos || !info) break;
        if (!this.myTeam || info.team === this.myTeam) fx.damage(pos.x, pos.y, ev.v, 'heal');
        if (ev.i === this.myId) audio.play('heal', { volume: 0.5 });
        break;
      }
      case 'ko': {
        if (info) fx.ko(ev.x, ev.y, info.team, charId);
        const killer = ev.s ? this.byId.get(ev.s) : null;
        this.ui.addKillFeed(
          killer ? { name: killer.name, team: killer.team, charId: killer.charId } : null,
          info ? { name: info.name, team: info.team, charId: info.charId } : null,
        );
        play('ko', ev.x, ev.y, ev.i === this.myId || ev.s === this.myId ? 2 : 1);
        break;
      }
      case 'spawn': {
        const pos = this.posOf(ev.i, snap);
        if (pos) fx.spawn(pos.x, pos.y);
        if (ev.i === this.myId) audio.play('spawn');
        break;
      }
      case 'boom':
        fx.boom(ev.x, ev.y, ev.r, ev.sp);
        play('boom', ev.x, ev.y);
        break;
      case 'pop':
      case 'fizz':
        fx.pop(ev.x, ev.y, ev.sp);
        break;
      case 'bonk':
        fx.bonk(ev.x, ev.y);
        play('bonk', ev.x, ev.y, 0.7);
        break;
      case 'slip':
        fx.slip(ev.x, ev.y);
        play('slip', ev.x, ev.y);
        break;
    }
  }

  // ---------- HUD ----------

  updateHUD(now, state) {
    const s = this.latest;
    const clock = s.ph === 'ended' ? s.cl : Math.max(0, s.cl - (now - this.latestAt) / 1000);
    if (s.ph === 'countdown') {
      const n = Math.ceil(clock);
      if (n !== this.lastBeep && n > 0) {
        this.lastBeep = n;
        this.audio.play('countdown');
      }
    }
    const me = this.mySnap;
    const ready = !!(me && me.su >= 1);
    if (ready && !this.superWasReady) this.audio.play('superReady', { volume: 0.7 });
    this.superWasReady = ready;

    this.ui.updateHUD({
      phase: s.ph,
      clock,
      score: s.sc,
      myTeam: this.myTeam,
      superCharge: me ? me.su : 0,
      superName: this.char ? this.char.super.name : '',
      alive: me ? !!me.al : true,
      respawnIn: me && !me.al ? me.rs || 0 : 0,
      ping: this.ping,
      spectator: !this.me,
    });

    if (this.input.tab) {
      const rows = s.p.map((p) => {
        const info = this.byId.get(p.i);
        return info && {
          name: info.name, team: info.team, charId: info.charId, kills: p.k || 0, deaths: p.d || 0, isMe: p.i === this.myId,
        };
      }).filter(Boolean);
      this.ui.setScoreboard(true, rows);
      this.scoreboardOpen = true;
    } else if (this.scoreboardOpen) {
      this.ui.setScoreboard(false, []);
      this.scoreboardOpen = false;
    }
    return state;
  }
}

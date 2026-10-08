// 遊戲畫面：把每一幀的狀態畫到 <canvas id="game"> 上。
// 世界先畫在低解析度的小畫布（1 世界像素 = 1 像素），再整數倍放大貼到螢幕上，所以是道地的像素風；
// 名字、血量數字、傷害數字最後才用螢幕解析度畫，字才清楚。
import { TILE, FLAG } from '../shared/constants.js';
import { WORLD_W, WORLD_H, tileAtPos } from '../shared/map.js';
import { CHAR_BY_ID } from '../shared/characters.js';
import {
  buildMapArt, drawCapybara, ellipseSprite, getProjectile, getProjectileFlat, getPeel, getStar,
  getGhost, getSpringPool, getShieldBubble, makeSplat, makeCrack, weaponTip, ringPoints, hash,
  makeCanvas, MAP_MARGIN,
} from './sprites.js';

const FONT = '"Microsoft JhengHei", "PingFang TC", "Noto Sans TC", sans-serif';
const OUTSIDE = '#16110d';
// 敵我顏色：自己綠、隊友藍、敵人紅（觀戰時藍隊用 ally、紅隊用 enemy 的顏色）
const RING_COLOR = { me: '#8cff6a', ally: '#4aa3ff', enemy: '#ff5a5a' };
const BAR_COLOR = { me: '#5ee86b', ally: '#4aa3ff', enemy: '#ff5a5a' };
const BAR_LIGHT = { me: '#b4ffba', ally: '#a6d4ff', enemy: '#ffaaaa' };
const NAME_COLOR = { me: '#b8ffc0', ally: '#c4e2ff', enemy: '#ffd0d0', none: '#ffffff' };
const MAX_PARTS = 900;
const BULLET_HEIGHT = 5;

// 子彈打中、爆炸時噴出來的顏色
const SPRITE_COLORS = {
  carrot: ['#f08a1e', '#ffb45a', '#c7650f', '#4f9a3a'],
  bigCarrot: ['#f08a1e', '#ffb45a', '#c7650f', '#6cbf4a'],
  orange: ['#f6a21a', '#ffd36b', '#fff1b8', '#e07a10'],
  seed: ['#2e1c12', '#5a3e2e', '#e8434a', '#ff7a80'],
  melon: ['#e8434a', '#ff7a80', '#2f7a2f', '#6cc04f', '#f4f0d0'],
  kernel: ['#f4d23a', '#fff1a0', '#d9a91e'],
  cob: ['#fffbe8', '#f4d23a', '#fff1a0', '#efe0b8'],
  popcorn: ['#fffbe8', '#f4d23a', '#efe0b8'],
  shard: ['#6b4226', '#8a5a36', '#f4ead0'],
  drop: ['#7cc8f0', '#c8ecff', '#ffffff', '#5ab4ea'],
  slam: ['#a8865a', '#8a6a44', '#c8ad84', '#6e5236'],
};
const JUICY = { orange: ['#f6a21a', '#ffd36b'], melon: ['#e8434a', '#ff8a90'], drop: ['#7cc8f0', '#c8ecff'] };

// 各武器的揮砍顏色、槍口火光顏色
const SLASH_COLOR = { banana: '#ffe45a', leek: '#9be06a', pineapple: '#ffc23a', pumpkin: '#ff9a2a' };
const MUZZLE_COLOR = {
  carrot: ['#ffd27a', '#f08a1e'], yuzu: ['#ffe6a0', '#f6a21a'], melon: ['#ff9aa0', '#e8434a'],
  corn: ['#fff3a0', '#f4d23a'], coconut: ['#fff6e0', '#a07850'], onsen: ['#e0f6ff', '#7cc8f0'],
};

const DMG_STYLE = {
  dealt: { fill: '#fff6b0', stroke: '#2a170d', size: 1.45, pop: 0.7 },
  taken: { fill: '#ff5a5a', stroke: '#2a0a0a', size: 1.25, pop: 0.5 },
  other: { fill: '#dedad4', stroke: '#2a2420', size: 0.95, pop: 0.2 },
  heal: { fill: '#6dff7a', stroke: '#0f2a12', size: 1.15, pop: 0.4, prefix: '+' },
};

function layer(w = 1, h = 1) {
  const cv = makeCanvas(w, h);
  const ctx = cv.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  return { cv, ctx };
}

function clamp(v, a, b) {
  return v < a ? a : v > b ? b : v;
}

function idPhase(id) {
  const s = String(id);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return ((h >>> 0) % 1000) / 1000;
}

function rand(a, b) {
  return a + Math.random() * (b - a);
}

function pick(arr) {
  return arr[(Math.random() * arr.length) | 0];
}

// ---------------------------------------------------------------------------

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.dpr = 1;
    this.W = 1;
    this.H = 1;
    this.Z = 2;
    this.cam = { left: 0, top: 0, lx: 0, ly: 0, offX: 0, offY: 0, vw: 1, vh: 1 };
    // 三張低解析度圖層：地面 + 自己後面的人、自己前面的人 + 牆頂草叢、空中的東西。
    // 自己另外用螢幕解析度畫在中間，所以每幀只要放大貼到螢幕三次（手機上少貼幾張全螢幕的圖，比較順）
    this.L = { bg: layer(), over: layer(), top: layer() };
    this.scratch = layer(112, 112); // 自己的角色另外畫（鏡頭跟著時才不會抖）
    this.art = buildMapArt();
    this.now = performance.now() / 1000;
    this.lastNow = null;
    this.players = [];
    this.dustAt = new Map();
    this.hpLag = new Map();
    this.zoneSeen = new Map();
    this.steamAcc = 0;
    this.cleanAt = 0;
    this.mask = new Uint8Array(4096);
    this.fx = new Effects(this);
    this.safe = { l: 0, r: 0, t: 0, b: 0 };
    this.safeProbe = null;
    this.resize();
  }

  // 瀏海、動態島、底部橫條佔掉的寬度（CSS 像素）。畫面照樣畫滿整個螢幕，
  // 但鏡頭不會讓地圖邊緣跑到它們底下，靠牆的水豚才不會被擋住
  readSafeArea() {
    if (!this.safeProbe) {
      const probe = document.createElement('div');
      probe.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;'
        + 'padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)';
      document.body.append(probe);
      this.safeProbe = probe;
    }
    const cs = getComputedStyle(this.safeProbe);
    this.safe = {
      l: parseFloat(cs.paddingLeft) || 0,
      r: parseFloat(cs.paddingRight) || 0,
      t: parseFloat(cs.paddingTop) || 0,
      b: parseFloat(cs.paddingBottom) || 0,
    };
  }

  // 畫布的 CSS 大小（還沒顯示出來時先用視窗大小）
  cssSize() {
    return [this.canvas.clientWidth || window.innerWidth, this.canvas.clientHeight || window.innerHeight];
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const [cssW, cssH] = this.cssSize();
    const W = Math.max(1, Math.round(cssW * dpr));
    const H = Math.max(1, Math.round(cssH * dpr));
    if (this.canvas.width !== W) this.canvas.width = W;
    if (this.canvas.height !== H) this.canvas.height = H;
    this.dpr = dpr;
    this.cssW = cssW;
    this.cssH = cssH;
    this.W = W;
    this.H = H;
    this.readSafeArea();
    // 放大倍率取整數，像素才不會糊。電腦螢幕至少看得到 384x240 的範圍；
    // 手機螢幕小，看到的範圍小一點（橫拿 360x180、直拿 240x360），水豚和字才不會太小
    const phone = Math.min(cssW, cssH) < 500;
    const [minW, minH] = !phone ? [384, 240] : cssW >= cssH ? [360, 180] : [240, 360];
    this.Z = Math.max(2, Math.floor(Math.min(W / minW, H / minH)));
    const vw = Math.ceil(W / this.Z) + 2;
    const vh = Math.ceil(H / this.Z) + 2;
    for (const l of Object.values(this.L)) {
      if (l.cv.width !== vw) l.cv.width = vw;
      if (l.cv.height !== vh) l.cv.height = vh;
      l.ctx.imageSmoothingEnabled = false;
    }
    this.cam.vw = vw;
    this.cam.vh = vh;
    this.ctx.imageSmoothingEnabled = false;
  }

  // 滑鼠位置（CSS 像素）→ 世界座標，用上一幀的鏡頭
  screenToWorld(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const sx = (clientX - rect.left) * (this.W / (rect.width || 1));
    const sy = (clientY - rect.top) * (this.H / (rect.height || 1));
    return { x: sx / this.Z + this.cam.left, y: sy / this.Z + this.cam.top };
  }

  render(state) {
    const dpr = window.devicePixelRatio || 1;
    const [cssW, cssH] = this.cssSize();
    if (dpr !== this.dpr || Math.round(cssW * dpr) !== this.W || Math.round(cssH * dpr) !== this.H) this.resize();

    const now = state.now ?? performance.now() / 1000;
    const dt = this.lastNow == null ? 0 : clamp(now - this.lastNow, 0, 0.1);
    this.lastNow = now;
    this.now = now;

    const players = (state.players || []).filter((p) => p.alive !== false);
    this.players = players;
    this.lastZones = state.zones || [];
    this.myTeam = state.myTeam || null;
    const me = players.find((p) => p.isMe && !p.ambient) || null;

    // 鏡頭：地圖比螢幕小就置中，不然貼齊地圖邊緣（手機的瀏海、動態島那一截不算，地圖邊緣停在它們旁邊）
    const Z = this.Z;
    const viewW = this.W / Z;
    const viewH = this.H / Z;
    const k = this.dpr / Z; // CSS 像素 → 世界像素
    const sl = this.safe.l * k;
    const sr = this.safe.r * k;
    const st = this.safe.t * k;
    const sb = this.safe.b * k;
    const camX = state.camera?.x ?? WORLD_W / 2;
    const camY = state.camera?.y ?? WORLD_H / 2;
    const left = WORLD_W <= viewW - sl - sr
      ? (WORLD_W - viewW) / 2 + (sr - sl) / 2
      : clamp(camX - viewW / 2, -sl, WORLD_W - viewW + sr);
    const top = WORLD_H <= viewH - st - sb
      ? (WORLD_H - viewH) / 2 + (sb - st) / 2
      : clamp(camY - viewH / 2, -st, WORLD_H - viewH + sb);
    const cam = this.cam;
    cam.left = left;
    cam.top = top;
    cam.lx = Math.floor(left);
    cam.ly = Math.floor(top);
    cam.offX = Math.round((left - cam.lx) * Z);
    cam.offY = Math.round((top - cam.ly) * Z);

    this.fx.update(dt);
    this.ambient(state, players, dt, now);
    this.updateHpLag(players, dt);

    const { bg, over, top: topL } = this.L;
    const vw = cam.vw;
    const vh = cam.vh;
    const lx = cam.lx;
    const ly = cam.ly;

    // ---- 1. 地面層 ----
    const b = bg.ctx;
    b.globalAlpha = 1;
    b.fillStyle = OUTSIDE;
    b.fillRect(0, 0, vw, vh);
    b.drawImage(this.art.ground, -lx - MAP_MARGIN, -ly - MAP_MARGIN);
    this.drawWaterAnim(b, now);
    this.fx.drawDecals(b, lx, ly);
    this.drawZones(b, state.zones || [], now);
    if (state.aim && me) this.drawAim(b, state.aim, now);

    const others = players.filter((p) => p !== me).sort((p, q) => p.y - q.y);
    for (const p of others) this.drawGroundMarks(b, p, Math.round(p.x) - lx, Math.round(p.y) - ly, now, false);
    const meAir = me && (me.z || 0) > 2;
    if (meAir) this.drawGroundMarks(b, me, Math.round(me.x) - lx, Math.round(me.y) - ly, now, true);
    this.drawProjectileShadows(b, state.projectiles || []);

    // ---- 2. 角色：在自己後面的直接畫在地面層，在自己前面的畫在上層（自己夾在中間）----
    const o = over.ctx;
    o.clearRect(0, 0, vw, vh);
    for (const p of others) {
      if ((p.z || 0) > 2) continue;
      this.drawPlayerBody(me && p.y >= me.y ? o : b, p, Math.round(p.x) - lx, Math.round(p.y) - ly, now);
    }

    let meBlit = null;
    if (me) {
      const s = this.scratch;
      const SX = 56;
      const SY = 80;
      s.ctx.clearRect(0, 0, s.cv.width, s.cv.height);
      if (!meAir) this.drawGroundMarks(s.ctx, me, SX, SY, now, true);
      this.drawPlayerBody(s.ctx, me, SX, SY, now);
      meBlit = {
        x: Math.round((me.x - left) * Z) - SX * Z,
        y: Math.round((me.y - top) * Z) - SY * Z,
      };
    }

    // ---- 3. 蓋在角色上面的：牆頂、草叢 ----
    o.drawImage(this.art.lips, -lx - MAP_MARGIN, -ly - MAP_MARGIN);
    this.drawBushes(o, players, me);

    // ---- 4. 空中的東西：跳起來的人、子彈、特效 ----
    const t = topL.ctx;
    t.clearRect(0, 0, vw, vh);
    for (const p of others) {
      if ((p.z || 0) > 2) this.drawPlayerBody(t, p, Math.round(p.x) - lx, Math.round(p.y) - ly, now);
    }
    for (const p of players) if (p.flags & FLAG.DASH) this.drawSpeedLines(t, p, now);
    this.drawProjectiles(t, state.projectiles || [], now);
    this.fx.drawTop(t, lx, ly, now);

    // ---- 合成到螢幕 ----
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.globalAlpha = 1;
    const BW = vw * Z;
    const BH = vh * Z;
    ctx.drawImage(bg.cv, -cam.offX, -cam.offY, BW, BH);
    const sc = this.scratch.cv;
    if (meBlit && !meAir) ctx.drawImage(sc, meBlit.x, meBlit.y, sc.width * Z, sc.height * Z);
    ctx.drawImage(over.cv, -cam.offX, -cam.offY, BW, BH);
    if (meBlit && meAir) ctx.drawImage(sc, meBlit.x, meBlit.y, sc.width * Z, sc.height * Z);
    ctx.drawImage(topL.cv, -cam.offX, -cam.offY, BW, BH);

    this.drawHuds(ctx, players, me);
    this.fx.drawTexts(ctx);
  }

  // 這個人跟我是什麼關係：'me' | 'ally' | 'enemy'。觀戰（myTeam 為 null）時藍隊算 ally、紅隊算 enemy。
  relOf(p) {
    if (p.isMe) return 'me';
    if (this.myTeam) return p.isAlly || p.team === this.myTeam ? 'ally' : 'enemy';
    return p.team === 'red' ? 'enemy' : 'ally';
  }

  // 場地物件的敵我顏色：'blue' = 自己人、'red' = 敵人
  sideColor(team) {
    if (this.myTeam) return team === this.myTeam ? 'blue' : 'red';
    return team === 'red' ? 'red' : 'blue';
  }

  // 世界座標 → 螢幕像素。自己用精確位置，其他人跟著低解析度的像素格。
  toScreen(p, wx, wy) {
    const { Z, cam } = this;
    if (p && p.isMe && !p.ambient) {
      return { x: Math.round((wx - cam.left) * Z), y: Math.round((wy - cam.top) * Z) };
    }
    return { x: (Math.round(wx) - cam.lx) * Z - cam.offX, y: (Math.round(wy) - cam.ly) * Z - cam.offY };
  }

  // ---------- 每幀自己產生的小特效：走路灰塵、溫泉蒸氣 ----------

  ambient(state, players, dt, now) {
    const fx = this.fx;
    for (const p of players) {
      if (!p.moving || (p.z || 0) > 1) continue;
      const last = this.dustAt.get(p.id) ?? -1;
      if (now - last < 0.25) continue;
      this.dustAt.set(p.id, now);
      const face = Math.cos(p.aim || 0) >= 0 ? 1 : -1;
      const tile = tileAtPos(p.x, p.y);
      if (tile === '~' || tile === 'h' || p.inSpring) {
        for (let i = 0; i < 3; i++) {
          fx.part({
            x: p.x + rand(-8, 8), y: p.y + 2, z: 2, vx: rand(-14, 14), vy: rand(-4, 4), vz: rand(25, 45), g: 160,
            life: 0.45, c: pick(['#e0f6ff', '#ffffff', '#9fdcff']), s: 1,
          });
        }
      } else {
        for (let i = 0; i < 2; i++) {
          fx.part({
            x: p.x - face * rand(5, 9), y: p.y + 5 + rand(-1, 1), z: 1, vx: -face * rand(4, 12), vy: rand(-3, 1), vz: rand(4, 10),
            life: rand(0.3, 0.45), c: pick(['#d9c9a3', '#c8b58c', '#e8dcc0']), s: 2, k: 2, s2: 1, a: 0.8,
          });
        }
      }
    }
    // 溫泉蒸氣
    const sp = this.art.spring;
    let rate = sp ? 7 : 0;
    const zoneList = (state.zones || []).filter((z) => z.kind === 'spring');
    for (const z of zoneList) rate += z.r * z.r * 0.008;
    this.steamAcc += dt * rate;
    let guard = 0;
    while (this.steamAcc >= 1 && guard++ < 20) {
      this.steamAcc -= 1;
      let x;
      let y;
      const pickZone = zoneList.length && (!sp || Math.random() < (rate - 7) / rate);
      if (pickZone) {
        const z = pick(zoneList);
        const a = Math.random() * Math.PI * 2;
        const r = Math.sqrt(Math.random()) * (z.r - 3);
        x = z.x + Math.cos(a) * r;
        y = z.y + Math.sin(a) * r;
      } else if (sp) {
        for (let k = 0; k < 6; k++) {
          x = rand(sp.x0, sp.x1);
          y = rand(sp.y0, sp.y1);
          if (sp.k(x, y) < 0.8) break;
        }
      } else break;
      fx.part({
        x, y, z: 0, vx: rand(-2, 2), vy: 0, vz: rand(7, 12), life: rand(1.2, 2), c: '#ffffff',
        s: Math.random() < 0.3 ? 2 : 1, a: 0.5, wob: rand(0, 6),
      });
    }
    // 泡湯的人頭上冒煙
    for (const p of players) {
      if (!(p.inSpring || tileAtPos(p.x, p.y) === 'h') || Math.random() > dt * 3) continue;
      fx.part({ x: p.x + rand(-4, 6), y: p.y, z: 10, vz: rand(6, 10), vx: rand(-2, 2), life: 1.2, c: '#ffffff', s: 1, a: 0.55, wob: rand(0, 6) });
    }
    // 偶爾清掉離開的人的資料
    if (now > this.cleanAt) {
      this.cleanAt = now + 5;
      const ids = new Set(players.map((p) => p.id));
      for (const m of [this.dustAt, this.hpLag, this.fx.flashes, this.fx.actions]) {
        for (const k of m.keys()) if (!ids.has(k)) m.delete(k);
      }
      const zids = new Set((state.zones || []).map((z) => z.id));
      for (const k of this.zoneSeen.keys()) if (!zids.has(k)) this.zoneSeen.delete(k);
    }
  }

  updateHpLag(players, dt) {
    for (const p of players) {
      if (p.ambient) continue;
      const max = p.maxHp || 1;
      let lag = this.hpLag.get(p.id);
      if (lag === undefined || p.hp > lag) lag = p.hp;
      else lag = Math.max(p.hp, lag - max * 0.7 * dt);
      this.hpLag.set(p.id, lag);
    }
  }

  // ---------- 地面 ----------

  drawWaterAnim(b, now) {
    const { lx, ly, vw, vh } = this.cam;
    for (const { tx, ty } of this.art.water) {
      const x0 = tx * TILE - lx;
      const y0 = ty * TILE - ly;
      if (x0 < -TILE || y0 < -TILE || x0 > vw || y0 > vh) continue;
      for (let k = 0; k < 3; k++) {
        const h1 = hash(tx, ty, 200 + k);
        const h2 = hash(tx, ty, 210 + k);
        const s = Math.sin(now * (1.1 + h2) + h1 * 6.28);
        if (s < 0.1) continue;
        const x = x0 + 2 + Math.floor(h2 * 10) + Math.round(Math.sin(now * 0.7 + h1 * 9) * 1.5);
        const y = y0 + 5 + Math.floor(h1 * 9);
        b.fillStyle = s > 0.75 ? '#d4f0ff' : '#8fd0fb';
        b.fillRect(x, y, s > 0.75 ? 3 : 2, 1);
      }
    }
    const sp = this.art.spring;
    if (!sp) return;
    if (sp.x1 - lx < 0 || sp.x0 - lx > vw || sp.y1 - ly < 0 || sp.y0 - ly > vh) return;
    for (let k = 0; k < 14; k++) {
      const h1 = hash(k, 3, 300);
      const h2 = hash(k, 5, 301);
      const s = Math.sin(now * (1.3 + h2) + h1 * 6.28);
      if (s < 0.2) continue;
      const x = sp.x0 + 8 + Math.floor(h1 * (sp.x1 - sp.x0 - 18)) + Math.round(Math.sin(now * 0.6 + k) * 1.5);
      const y = sp.y0 + 8 + Math.floor(h2 * (sp.y1 - sp.y0 - 16));
      if (sp.k(x, y) > 0.82) continue;
      b.fillStyle = s > 0.8 ? '#ffffff' : '#c8f4ec';
      b.fillRect(x - lx, y - ly, s > 0.8 ? 3 : 2, 1);
    }
    // 漂來漂去的小柚子
    const yx = Math.round(sp.cx + Math.cos(now * 0.35) * 12 - 4);
    const yy = Math.round(sp.cy + Math.sin(now * 0.5) * 9 + Math.sin(now * 2.2) * 0.6);
    const ring = ellipseSprite(5, 2, '#e6fffb', 1);
    b.globalAlpha = 0.8;
    b.drawImage(ring, yx - 5 - lx, yy + 3 - ly);
    b.globalAlpha = 1;
    const yz = getProjectileFlat('orange');
    b.drawImage(yz, yx - (yz.width >> 1) - lx, yy - (yz.height >> 1) - ly);
  }

  drawZones(b, zones, now) {
    const { lx, ly } = this.cam;
    const list = zones.slice().sort((p, q) => p.y - q.y);
    for (const z of list) {
      const x = Math.round(z.x) - lx;
      const y = Math.round(z.y) - ly;
      if (z.kind === 'trap') {
        const cv = getPeel(this.sideColor(z.team));
        b.drawImage(cv, x - (cv.width >> 1), y - (cv.height >> 1));
      } else if (z.kind === 'spring') {
        let seen = this.zoneSeen.get(z.id);
        if (seen === undefined) {
          seen = now;
          this.zoneSeen.set(z.id, now);
        }
        const grow = clamp((now - seen) / 0.22, 0.15, 1);
        const r = Math.max(3, Math.round(z.r * grow));
        const alpha = z.remaining == null ? 1 : clamp(z.remaining / 0.5, 0, 1);
        b.globalAlpha = alpha * 0.95;
        b.drawImage(getSpringPool(r, this.sideColor(z.team)), x - r, y - r);
        b.globalAlpha = alpha;
        for (let k = 0; k < 6; k++) {
          const s = Math.sin(now * 1.6 + k * 2.1 + z.id);
          if (s < 0.3) continue;
          const a = hash(k, z.id | 0, 5) * Math.PI * 2;
          const d = hash(k, z.id | 0, 6) * (r - 6);
          b.fillStyle = s > 0.8 ? '#ffffff' : '#d8fbf5';
          b.fillRect(x + Math.round(Math.cos(a) * d), y + Math.round(Math.sin(a) * d), 2, 1);
        }
        b.globalAlpha = 1;
      }
    }
  }

  drawProjectileShadows(b, list) {
    const { lx, ly } = this.cam;
    b.globalAlpha = 0.25;
    for (const pr of list) {
      const x = Math.round(pr.x) - lx;
      const y = Math.round(pr.y) - ly;
      if (pr.kind === 'lob') {
        const r = clamp(Math.round(4 - (pr.z || 0) / 12), 2, 4);
        b.drawImage(ellipseSprite(r, 1, '#000000'), x - r, y - 1);
      } else if (pr.sprite === 'melon') {
        b.drawImage(ellipseSprite(6, 2, '#000000'), x - 6, y - 1);
      } else {
        b.drawImage(ellipseSprite(2, 1, '#000000'), x - 2, y - 1);
      }
    }
    b.globalAlpha = 1;
  }

  // 影子、隊伍光圈、大招準備好的黃色光環
  drawGroundMarks(c, p, ix, iy, now, isMe) {
    const z = p.z || 0;
    const sr = z > 0 ? clamp(Math.round(8 - z / 5), 4, 8) : 8;
    c.globalAlpha = z > 0 ? 0.22 : 0.3;
    c.drawImage(ellipseSprite(sr, 2, '#000000'), ix - sr, iy + 5 - 2);
    c.globalAlpha = 1;
    if (p.ambient) return;
    if (isMe && p.superCharge >= 1) {
      const pulse = (Math.sin(now * 7) + 1) / 2;
      const r = 12 + Math.round(pulse * 2);
      c.globalAlpha = 0.18 + pulse * 0.12;
      c.drawImage(ellipseSprite(r, Math.round(r * 0.42), '#ffe14a'), ix - r, iy + 5 - Math.round(r * 0.42));
      c.globalAlpha = 0.55 + pulse * 0.45;
      c.drawImage(ellipseSprite(r, Math.round(r * 0.42), '#ffe14a', 1), ix - r, iy + 5 - Math.round(r * 0.42));
      c.globalAlpha = 1;
    }
    const ring = isMe ? ellipseSprite(10, 4, RING_COLOR.me, 2) : ellipseSprite(10, 4, RING_COLOR[this.relOf(p)], 1);
    c.globalAlpha = isMe ? 1 : 0.9;
    c.drawImage(ring, ix - 10, iy + 5 - 4);
    c.globalAlpha = 1;
  }

  // ---------- 角色 ----------

  drawPlayerBody(c, p, ix, iy, now) {
    const flags = p.flags | 0;
    const z = Math.round(p.z || 0);
    const ph = idPhase(p.id);
    const stunned = flags & FLAG.STUN;
    let alpha = 1;
    if (flags & FLAG.HIDDEN) alpha *= 0.5;
    if (flags & FLAG.PROTECT) alpha *= Math.floor(now * 12) % 2 ? 0.35 : 1;
    const white = this.fx.isFlashing(p.id, now);

    const tile = tileAtPos(p.x, p.y);
    let wet = z < 1 && (tile === '~' || tile === 'h' || p.inSpring);
    if (!wet && z < 1 && this.inSpringZone(p)) wet = true;

    let frame = 'idle';
    let bob = 0;
    if (p.moving && !stunned && !wet) {
      const st = Math.floor(now * 10 + ph * 4) % 4;
      frame = ['a', 'idle', 'b', 'idle'][st];
      bob = st % 2;
    } else {
      if ((now + ph * 7) % 3.6 < 0.13) frame = 'blink';
      bob = wet ? (Math.sin(now * 2.2 + ph * 6) > 0.3 ? 1 : 0) : Math.floor(now * 1.25 + ph * 2) % 2;
    }

    const opts = { aim: p.aim || 0, frame, bob, white };
    if (wet) opts.crop = 4;
    const act = this.fx.actions.get(p.id);
    if (act && now - act.t0 < act.dur) {
      const u = clamp((now - act.t0) / act.dur, 0, 1);
      if (act.kind === 'swing') {
        const s = -act.arc / 2 + act.arc * (1 - (1 - u) * (1 - u));
        opts.swing = Math.cos(opts.aim) < 0 ? -s : s;
      } else if (act.kind === 'punch') {
        opts.punch = Math.round(Math.sin(u * Math.PI) * 5);
      } else if (act.kind === 'recoil') {
        opts.recoil = Math.round((1 - u) * 2);
      }
    }
    if (flags & FLAG.SPIN) {
      opts.spinAngle = now * 22 + ph * 6;
      opts.facingLeft = Math.floor(now * 9) % 2 === 1;
    }

    const y = iy - z;
    c.globalAlpha = alpha;

    // 衝刺殘影
    if (flags & FLAG.DASH) {
      const dx = Math.cos(opts.aim);
      const dy = Math.sin(opts.aim);
      for (let k = 2; k >= 1; k--) {
        c.globalAlpha = alpha * (k === 1 ? 0.4 : 0.2);
        drawCapybara(c, p.charId, ix - Math.round(dx * 7 * k), y - Math.round(dy * 7 * k), { ...opts, white: true });
      }
      c.globalAlpha = alpha;
    }

    // 旋風的拖影（身體後面那一半）
    if (flags & FLAG.SPIN) this.drawSpinTrail(c, ix, y - 2, opts.spinAngle, alpha, false);

    drawCapybara(c, p.charId, ix, y, opts);

    if (flags & FLAG.SPIN) this.drawSpinTrail(c, ix, y - 2, opts.spinAngle, alpha, true);

    if (wet) {
      const rx = 10 + (Math.sin(now * 3 + ph * 5) > 0 ? 1 : 0);
      c.globalAlpha = alpha * 0.85;
      c.drawImage(ellipseSprite(rx, 2, '#e6f8ff', 1), ix - rx, y + 1 - 2);
      c.globalAlpha = alpha;
    }

    if (flags & FLAG.SHIELD) {
      const bub = getShieldBubble();
      c.globalAlpha = alpha * (0.85 + Math.sin(now * 8) * 0.15);
      c.drawImage(bub, ix - (bub.width >> 1), y - 2 - (bub.height >> 1));
      c.globalAlpha = alpha;
    }

    c.globalAlpha = 1;

    if (stunned) {
      const st = getStar();
      for (let k = 0; k < 3; k++) {
        const a = now * 5 + (k * Math.PI * 2) / 3;
        const sx = ix + Math.round(Math.cos(a) * 8) - (st.width >> 1);
        const sy = y - 16 + Math.round(Math.sin(a) * 2.5) - (st.height >> 1);
        c.globalAlpha = Math.sin(a) < 0 ? 0.75 : 1;
        c.drawImage(Math.sin(a) < 0 ? getStar(true) : st, sx, sy);
      }
      c.globalAlpha = 1;
    }
  }

  inSpringZone(p) {
    const zones = this.lastZones;
    if (!zones) return false;
    for (const z of zones) {
      if (z.kind === 'spring' && Math.hypot(p.x - z.x, p.y - z.y) < z.r - 3) return true;
    }
    return false;
  }

  drawSpinTrail(c, x, y, angle, alpha, front) {
    for (const r of [15, 19]) {
      const pts = ringPoints(r);
      for (const pt of pts) {
        const isFront = pt.y >= 0;
        if (isFront !== front) continue;
        let d = angle - pt.a;
        d = ((d % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
        if (d > 2.6) continue;
        const k = 1 - d / 2.6;
        c.globalAlpha = alpha * (k > 0.66 ? 0.9 : k > 0.33 ? 0.55 : 0.25);
        c.fillStyle = r === 19 ? '#d8f5b0' : '#ffffff';
        c.fillRect(x + pt.x, y + Math.round(pt.y * 0.75), 1, 1);
      }
    }
    c.globalAlpha = alpha;
  }

  drawSpeedLines(t, p, now) {
    const { lx, ly } = this.cam;
    const dx = Math.cos(p.aim || 0);
    const dy = Math.sin(p.aim || 0);
    const x = p.x;
    const y = p.y - (p.z || 0) - 3;
    t.fillStyle = '#ffffff';
    for (let k = 0; k < 5; k++) {
      const off = (k - 2) * 3.5 + Math.sin(now * 40 + k * 3) * 1;
      const start = 11 + ((k * 7 + Math.floor(now * 30)) % 5);
      const len = 6 + ((k * 3) % 5);
      t.globalAlpha = 0.75;
      const x0 = x - dx * start - dy * off;
      const y0 = y - dy * start + dx * off;
      pxLine(t, Math.round(x0) - lx, Math.round(y0) - ly, Math.round(x0 - dx * len) - lx, Math.round(y0 - dy * len) - ly);
    }
    t.globalAlpha = 1;
  }

  // ---------- 子彈 ----------

  drawProjectiles(t, list, now) {
    const { lx, ly } = this.cam;
    for (const pr of list) {
      const x = Math.round(pr.x) - lx;
      if (pr.kind === 'lob') {
        const y = Math.round(pr.y - (pr.z || 0)) - ly;
        const spin = now * (pr.sprite === 'cob' ? 12 : 7) + (pr.id || 0);
        const r = getProjectile(pr.sprite, spin);
        t.drawImage(r.cv, x - r.o, y - r.o);
        continue;
      }
      let a = pr.angle || 0;
      let h = BULLET_HEIGHT;
      if (pr.sprite === 'melon') {
        a = now * 9 * (Math.cos(a) >= 0 ? 1 : -1);
        h = 6;
      } else if (pr.sprite === 'popcorn') {
        a = now * 8 + (pr.id || 0);
      }
      const y = Math.round(pr.y - h) - ly;
      if (pr.sprite === 'kernel' || pr.sprite === 'bigCarrot') {
        const dx = Math.cos(pr.angle || 0);
        const dy = Math.sin(pr.angle || 0);
        t.fillStyle = pr.sprite === 'kernel' ? '#fff1a0' : '#ffd27a';
        const n = pr.sprite === 'kernel' ? 7 : 5;
        for (let k = 3; k < n + 3; k++) {
          t.globalAlpha = 0.7 * (1 - (k - 3) / n);
          t.fillRect(x - Math.round(dx * k), y - Math.round(dy * k), 1, 1);
        }
        t.globalAlpha = 1;
      }
      const r = getProjectile(pr.sprite, a);
      t.drawImage(r.cv, x - r.o, y - r.o);
    }
  }

  // ---------- 草叢 ----------

  drawBushes(o, players, me) {
    const { lx, ly, vw, vh } = this.cam;
    const near = [];
    if (me && tileAtPos(me.x, me.y) === 'b') near.push([Math.floor(me.x / TILE), Math.floor(me.y / TILE), 2]);
    for (const p of players) {
      if (p.isAlly && (p.flags & FLAG.HIDDEN)) near.push([Math.floor(p.x / TILE), Math.floor(p.y / TILE), 1]);
    }
    for (const bu of this.art.bushes) {
      const x = bu.x - lx;
      const y = bu.y - ly;
      if (x > vw || y > vh || x + bu.cv.width < 0 || y + bu.cv.height < 0) continue;
      let see = false;
      for (const [tx, ty, r] of near) {
        if (Math.abs(bu.tx - tx) <= r && Math.abs(bu.ty - ty) <= r) {
          see = true;
          break;
        }
      }
      o.globalAlpha = see ? 0.5 : 1;
      o.drawImage(bu.cv, x, y);
    }
    o.globalAlpha = 1;
  }

  // ---------- 瞄準輔助線 ----------

  drawAim(b, aim, now) {
    const sup = !!aim.isSuper;
    const colors = sup
      ? [null, 'rgba(255,214,64,0.26)', 'rgba(255,226,96,0.8)']
      : [null, 'rgba(255,255,255,0.24)', 'rgba(255,255,255,0.5)'];
    const ox = aim.x;
    const oy = aim.y;
    const a = aim.angle || 0;
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    const range = aim.range || 60;
    const dist = clamp(aim.dist ?? range, 0, range);
    const tx = ox + dx * dist;
    const ty = oy + dy * dist;

    const circle = (cx, cy, R) => {
      const R2 = R * R;
      this.raster(b, cx - R - 1, cy - R - 1, cx + R + 1, cy + R + 1,
        (x, y) => ((x - cx) ** 2 + (y - cy) ** 2 <= R2 ? 1 : 0), colors, true);
    };
    const rect = (L, hw) => {
      const ex = ox + dx * L;
      const ey = oy + dy * L;
      this.raster(b, Math.min(ox, ex) - hw - 1, Math.min(oy, ey) - hw - 1, Math.max(ox, ex) + hw + 1, Math.max(oy, ey) + hw + 1,
        (x, y) => {
          const rx = x - ox;
          const ry = y - oy;
          const u = rx * dx + ry * dy;
          const v = -rx * dy + ry * dx;
          return u >= 0 && u <= L && v >= -hw && v <= hw ? 1 : 0;
        }, colors, true);
    };
    const wedge = (R, arc) => {
      const half = Math.min(Math.PI, arc / 2);
      const cosH = Math.cos(half);
      let x0 = ox;
      let x1 = ox;
      let y0 = oy;
      let y1 = oy;
      for (let k = 0; k <= 8; k++) {
        const t = a - half + (half * 2 * k) / 8;
        x0 = Math.min(x0, ox + Math.cos(t) * R);
        x1 = Math.max(x1, ox + Math.cos(t) * R);
        y0 = Math.min(y0, oy + Math.sin(t) * R);
        y1 = Math.max(y1, oy + Math.sin(t) * R);
      }
      const R2 = R * R;
      this.raster(b, x0 - 1, y0 - 1, x1 + 1, y1 + 1, (x, y) => {
        const rx = x - ox;
        const ry = y - oy;
        const d2 = rx * rx + ry * ry;
        if (d2 > R2) return 0;
        if (d2 < 4) return 1;
        return (rx * dx + ry * dy) / Math.sqrt(d2) >= cosH ? 1 : 0;
      }, colors, true);
    };
    const arcDash = (height) => {
      const { lx, ly } = this.cam;
      const L = Math.max(1, Math.hypot(tx - ox, ty - oy));
      const steps = Math.ceil(L * 1.3);
      b.fillStyle = colors[2];
      let lastX = null;
      let lastY = null;
      for (let i = 0; i <= steps; i++) {
        const u = i / steps;
        const s = u * L;
        if ((((Math.floor((s - now * 22) / 4)) % 2) + 2) % 2) continue;
        const x = Math.round(ox + (tx - ox) * u);
        const y = Math.round(oy + (ty - oy) * u - 4 * height * u * (1 - u));
        if (x === lastX && y === lastY) continue;
        lastX = x;
        lastY = y;
        b.fillRect(x - lx, y - ly, 1, 1);
      }
    };

    switch (aim.kind) {
      case 'bullet':
        if ((aim.spread || 0) > 0.02) wedge(range, aim.spread + 0.08);
        else rect(range, sup ? 3.5 : 2.5);
        break;
      case 'lob':
        arcDash(Math.min(26, dist * 0.32));
        circle(tx, ty, aim.aoe || 16);
        break;
      case 'melee':
        wedge(range, aim.arc || 1.5);
        break;
      case 'trap':
      case 'zone':
      case 'leap':
        arcDash(Math.min(22, dist * 0.28));
        circle(tx, ty, aim.aoe || 12);
        break;
      case 'dash':
        rect(range, 6);
        break;
      case 'spin':
        circle(ox, oy, aim.aoe || 26);
        break;
      case 'shield':
        circle(ox, oy, aim.aoe || 14);
        break;
      default:
        rect(range, 2);
    }
  }

  // 自己點陣化：fn(世界x, 世界y) 回傳 0（不畫）/1/2 → 用 colors[值] 畫。autoEdge：形狀邊緣自動變成 2。
  raster(c, x0, y0, x1, y1, fn, colors, autoEdge) {
    const { lx, ly, vw, vh } = this.cam;
    x0 = Math.max(Math.floor(x0), lx - 1);
    y0 = Math.max(Math.floor(y0), ly - 1);
    x1 = Math.min(Math.ceil(x1), lx + vw);
    y1 = Math.min(Math.ceil(y1), ly + vh);
    const w = x1 - x0 + 1;
    const h = y1 - y0 + 1;
    if (w <= 0 || h <= 0) return;
    const W2 = w + 2;
    const need = W2 * (h + 2);
    if (this.mask.length < need) this.mask = new Uint8Array(Math.ceil(need * 1.5));
    const m = this.mask;
    m.fill(0, 0, need);
    for (let j = 0; j < h; j++) {
      const row = (j + 1) * W2 + 1;
      for (let i = 0; i < w; i++) m[row + i] = fn(x0 + i + 0.5, y0 + j + 0.5);
    }
    if (autoEdge) {
      for (let j = 0; j < h; j++) {
        const row = (j + 1) * W2 + 1;
        for (let i = 0; i < w; i++) {
          const k = row + i;
          if (m[k] === 1 && (!m[k - 1] || !m[k + 1] || !m[k - W2] || !m[k + W2])) m[k] = 2;
        }
      }
    }
    for (let j = 0; j < h; j++) {
      const row = (j + 1) * W2 + 1;
      let runV = 0;
      let runS = 0;
      for (let i = 0; i <= w; i++) {
        const v = i < w ? m[row + i] : 0;
        if (v === runV) continue;
        if (runV && colors[runV]) {
          c.fillStyle = colors[runV];
          c.fillRect(x0 + runS - lx, y0 + j - ly, i - runS, 1);
        }
        runV = v;
        runS = i;
      }
    }
  }

  // ---------- 血條、名字（螢幕解析度）----------

  drawHuds(ctx, players, me) {
    const Z = this.Z;
    const dpr = this.dpr;
    const nameSize = Math.round(Math.max(12 * dpr, Z * 3.2));
    const hpSize = Math.round(Math.max(13 * dpr, Z * 3.9));
    const items = [];
    for (const p of players) {
      if (p.ambient || !(p.maxHp > 0)) continue;
      const rel = this.relOf(p);
      const s = this.toScreen(p, p.x, p.y - (p.z || 0));
      const isMe = !!p.isMe;
      const barTop = s.y + (isMe ? -24 : -20) * Z;
      const x0 = s.x - 11 * Z;
      const frac = clamp(p.hp / p.maxHp, 0, 1);
      const lagFrac = clamp((this.hpLag.get(p.id) ?? p.hp) / p.maxHp, 0, 1);
      // 外框 22x5、裡面 20x3（以世界像素為單位）
      ctx.fillStyle = '#140c08';
      ctx.fillRect(x0, barTop, 22 * Z, 5 * Z);
      ctx.fillStyle = '#3d2c22';
      ctx.fillRect(x0 + Z, barTop + Z, 20 * Z, 3 * Z);
      const lagW = Math.ceil(20 * lagFrac);
      const w = frac > 0 ? Math.max(1, Math.round(20 * frac)) : 0;
      if (lagW > w) {
        ctx.fillStyle = '#fff1c8';
        ctx.fillRect(x0 + Z + w * Z, barTop + Z, (lagW - w) * Z, 3 * Z);
      }
      if (w > 0) {
        ctx.fillStyle = BAR_COLOR[rel];
        ctx.fillRect(x0 + Z, barTop + Z, w * Z, 3 * Z);
        ctx.fillStyle = BAR_LIGHT[rel];
        ctx.fillRect(x0 + Z, barTop + Z, w * Z, Z);
      }
      // 自己的子彈格
      if (isMe && p.maxAmmo > 0) {
        const n = Math.round(p.maxAmmo);
        const ay = barTop + 5 * Z;
        ctx.fillStyle = '#140c08';
        ctx.fillRect(x0, ay, 22 * Z, 4 * Z);
        for (let i = 0; i < n; i++) {
          const sx0 = Math.round((i * 21) / n);
          const sx1 = Math.round(((i + 1) * 21) / n) - 1;
          const segW = sx1 - sx0;
          const fill = clamp((p.ammo ?? 0) - i, 0, 1);
          ctx.fillStyle = '#3d2c22';
          ctx.fillRect(x0 + Z + sx0 * Z, ay + Z, segW * Z, 2 * Z);
          if (fill >= 1) {
            ctx.fillStyle = '#ff9a2e';
            ctx.fillRect(x0 + Z + sx0 * Z, ay + Z, segW * Z, 2 * Z);
            ctx.fillStyle = '#ffd08a';
            ctx.fillRect(x0 + Z + sx0 * Z, ay + Z, segW * Z, Z);
          } else if (fill > 0) {
            ctx.fillStyle = '#b8641c';
            ctx.fillRect(x0 + Z + sx0 * Z, ay + Z, Math.round(segW * Z * fill), 2 * Z);
          }
        }
      }
      items.push({ p, rel, x: s.x, y: barTop });
    }
    // 文字
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.lineJoin = 'round';
    ctx.font = `900 ${hpSize}px ${FONT}`;
    ctx.lineWidth = Math.max(2, Math.round(hpSize * 0.26));
    ctx.strokeStyle = '#1a0f0a';
    for (const it of items) {
      const txt = String(Math.max(0, Math.ceil(it.p.hp)));
      const y = it.y - Math.round(Z * 0.6);
      ctx.strokeText(txt, it.x, y);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(txt, it.x, y);
    }
    ctx.font = `700 ${nameSize}px ${FONT}`;
    ctx.lineWidth = Math.max(2, Math.round(nameSize * 0.3));
    for (const it of items) {
      if (!it.p.name) continue;
      const y = it.y - Math.round(Z * 0.6) - hpSize - Math.round(Z * 0.2);
      ctx.strokeText(it.p.name, it.x, y);
      ctx.fillStyle = NAME_COLOR[it.rel];
      ctx.fillText(it.p.name, it.x, y);
    }
  }
}

// Bresenham 直線（1 像素）
function pxLine(c, x0, y0, x1, y1) {
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (let n = 0; n < 64; n++) {
    c.fillRect(x0, y0, 1, 1);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x0 += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y0 += sy;
    }
  }
}

// ---------------------------------------------------------------------------
// 特效：遊戲收到伺服器事件時呼叫。所有位置都是世界座標（玩家相關的就給玩家腳底的位置）。

class Effects {
  constructor(r) {
    this.r = r;
    this.parts = [];
    this.texts = [];
    this.slashes = [];
    this.rings = [];
    this.decals = [];
    this.ghosts = [];
    this.flashes = new Map();
    this.actions = new Map();
  }

  get t() {
    return this.r.now;
  }

  isFlashing(id, now) {
    const u = this.flashes.get(id);
    return u !== undefined && now < u;
  }

  part(o) {
    if (this.parts.length >= MAX_PARTS) return;
    this.parts.push({
      x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, g: 0, drag: 0, age: 0, life: 0.5, c: '#ffffff', s: 1, k: 0, a: 1, ...o,
    });
  }

  ring(x, y, r0, r1, c, life, th = 1, delay = 0) {
    this.rings.push({ x, y, r0, r1, c, life, th, age: -delay });
  }

  // 找最接近這個位置、同角色的玩家，讓他的武器動一下（揮砍、後座力）
  act(x, y, charId, kind, dur, arc = 0) {
    let best = null;
    let bd = 26 * 26;
    for (const p of this.r.players) {
      if (charId && p.charId !== charId) continue;
      const d = (p.x - x) ** 2 + (p.y - y) ** 2;
      if (d < bd) {
        bd = d;
        best = p;
      }
    }
    if (best) this.actions.set(best.id, { kind, t0: this.t, dur, arc });
  }

  update(dt) {
    const P = this.parts;
    for (let i = P.length - 1; i >= 0; i--) {
      const p = P[i];
      p.age += dt;
      if (p.age >= p.life) {
        P[i] = P[P.length - 1];
        P.pop();
        continue;
      }
      if (p.drag) {
        const f = Math.max(0, 1 - p.drag * dt);
        p.vx *= f;
        p.vy *= f;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.wob !== undefined) p.x += Math.sin(p.age * 3 + p.wob) * 4 * dt;
      if (p.g) {
        p.vz -= p.g * dt;
        p.z += p.vz * dt;
        if (p.z < 0) {
          p.z = 0;
          p.vz = -p.vz * 0.35;
          p.vx *= 0.5;
          p.vy *= 0.5;
        }
      } else {
        p.z += p.vz * dt;
      }
    }
    const age = (list) => {
      for (let i = list.length - 1; i >= 0; i--) {
        list[i].age += dt;
        if (list[i].age >= list[i].life) list.splice(i, 1);
      }
    };
    age(this.texts);
    age(this.slashes);
    age(this.rings);
    age(this.decals);
    age(this.ghosts);
  }

  drawDecals(c, ox, oy) {
    for (const d of this.decals) {
      const u = d.age / d.life;
      c.globalAlpha = (u < 0.6 ? 1 : 1 - (u - 0.6) / 0.4) * (d.a ?? 1);
      c.drawImage(d.cv, Math.round(d.x) - ox - (d.cv.width >> 1), Math.round(d.y) - oy - (d.cv.height >> 1));
    }
    c.globalAlpha = 1;
  }

  drawTop(c, ox, oy, now) {
    // 小幽靈
    const ghost = getGhost();
    for (const g of this.ghosts) {
      if (g.age < 0) continue;
      const u = g.age / g.life;
      c.globalAlpha = 0.9 * (u < 0.7 ? 1 : 1 - (u - 0.7) / 0.3);
      const gx = Math.round(g.x + Math.sin(g.age * 5) * 2.5) - ox;
      const gy = Math.round(g.y - 8 - g.age * 22) - oy;
      if (g.left) {
        c.save();
        c.translate(gx, 0);
        c.scale(-1, 1);
        c.drawImage(ghost, -(ghost.width >> 1), gy - (ghost.height >> 1));
        c.restore();
      } else {
        c.drawImage(ghost, gx - (ghost.width >> 1), gy - (ghost.height >> 1));
      }
    }
    c.globalAlpha = 1;

    // 揮砍的弧線
    for (const s of this.slashes) this.drawSlash(c, s);

    // 擴散的圓圈
    for (const r of this.rings) {
      if (r.age < 0) continue;
      const u = r.age / r.life;
      const e = 1 - (1 - u) * (1 - u);
      const rad = Math.round(r.r0 + (r.r1 - r.r0) * e);
      if (rad < 1) continue;
      c.globalAlpha = u < 0.5 ? 1 : 1 - (u - 0.5) / 0.5;
      const th = u > 0.6 ? 1 : r.th;
      const cv = ellipseSprite(rad, rad, r.c, th);
      c.drawImage(cv, Math.round(r.x) - ox - rad, Math.round(r.y) - oy - rad);
    }
    c.globalAlpha = 1;

    // 粒子
    const star = getStar();
    const tiny = getStar(true);
    for (const p of this.parts) {
      const u = p.age / p.life;
      c.globalAlpha = (u < 0.6 ? 1 : 1 - (u - 0.6) / 0.4) * p.a;
      const x = Math.round(p.x) - ox;
      const y = Math.round(p.y - p.z) - oy;
      switch (p.k) {
        case 0: {
          const s = p.s;
          c.fillStyle = p.c;
          c.fillRect(x - (s >> 1), y - (s >> 1), s, s);
          break;
        }
        case 1: {
          c.fillStyle = p.c;
          if (u < 0.5) {
            c.fillRect(x - 1, y, 3, 1);
            c.fillRect(x, y - 1, 1, 3);
          } else {
            c.fillRect(x, y, 1, 1);
          }
          break;
        }
        case 2: {
          const rad = Math.round(p.s + ((p.s2 ?? p.s * 2) - p.s) * u);
          const cv = ellipseSprite(rad, rad, p.c);
          c.drawImage(cv, x - rad, y - rad);
          break;
        }
        case 3: {
          const cv = p.s > 1 ? star : tiny;
          c.drawImage(cv, x - (cv.width >> 1), y - (cv.height >> 1));
          break;
        }
        default:
          break;
      }
    }
    c.globalAlpha = 1;
  }

  drawSlash(c, s) {
    const u = s.age / s.life;
    const half = s.arc / 2;
    const a0 = s.angle - half;
    const sweep = s.arc * Math.min(1, u / 0.45);
    const tail = s.arc * Math.max(0, (u - 0.45) / 0.55);
    const R = Math.max(10, s.range * 0.9);
    const maxTh = Math.max(3, Math.round(R / 7));
    const cx = s.x;
    const cy = s.y;
    const colors = [null, s.c, '#ffffff'];
    const R2o = (R + 0.5) * (R + 0.5);
    const inner = (R - maxTh - 0.5) ** 2;
    c.globalAlpha = u < 0.6 ? 1 : 1 - (u - 0.6) / 0.4;
    this.r.raster(c, cx - R - 1, cy - R - 1, cx + R + 1, cy + R + 1, (x, y) => {
      const rx = x - cx;
      const ry = y - cy;
      const d2 = rx * rx + ry * ry;
      if (d2 > R2o || d2 < inner) return 0;
      let t = Math.atan2(ry, rx) - a0;
      t = ((t % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
      if (t > sweep || t < tail) return 0;
      const f = (t - tail) / Math.max(0.01, sweep - tail);
      const th = 1 + (maxTh - 1) * Math.sin(Math.min(1, f) * Math.PI * 0.5 + 0.0001) ** 0.7;
      const d = Math.sqrt(d2);
      if (d < R - th) return 0;
      return d > R - 1.2 ? 2 : 1;
    }, colors, false);
    c.globalAlpha = 1;
  }

  drawTexts(ctx) {
    const { Z, dpr, cam } = this.r;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    for (const t of this.texts) {
      const u = t.age / t.life;
      const rise = 14 * (1 - (1 - u) * (1 - u));
      const pop = u < 0.12 ? 1 + t.pop * (1 - u / 0.12) : 1;
      const size = Math.round(Math.max(12 * dpr, Z * 3.6) * t.size * pop);
      const x = (t.x - cam.left) * Z;
      const y = (t.y - rise - cam.top) * Z;
      ctx.globalAlpha = u < 0.65 ? 1 : 1 - (u - 0.65) / 0.35;
      ctx.font = `900 ${size}px ${FONT}`;
      ctx.lineWidth = Math.max(2, Math.round(size * 0.28));
      ctx.strokeStyle = t.stroke;
      ctx.strokeText(t.text, x, y);
      ctx.fillStyle = t.fill;
      ctx.fillText(t.text, x, y);
    }
    ctx.globalAlpha = 1;
  }

  // ---------- 對外的特效 API ----------

  // 飄起來的數字。style：'dealt' | 'taken' | 'other' | 'heal'
  damage(x, y, amount, style = 'other') {
    const st = DMG_STYLE[style] || DMG_STYLE.other;
    let stack = 0;
    for (const t of this.texts) {
      if (t.age < 0.3 && Math.abs(t.x0 - x) < 14 && Math.abs(t.y0 - y) < 14) stack++;
    }
    if (this.texts.length > 60) this.texts.shift();
    this.texts.push({
      x0: x, y0: y, x: x + rand(-5, 5), y: y - 22 - stack * 5, text: `${st.prefix || ''}${Math.round(amount)}`,
      fill: st.fill, stroke: st.stroke, size: st.size, pop: st.pop, age: 0, life: 0.8,
    });
  }

  hitFlash(playerId) {
    this.flashes.set(playerId, this.t + 0.1);
  }

  slash(x, y, angle, range, arc, charId) {
    const weapon = CHAR_BY_ID[charId]?.look.weapon;
    const key = charId in SLASH_COLOR ? charId : null;
    const col = SLASH_COLOR[key] || (weapon === 'banana' ? SLASH_COLOR.banana : '#ffffff');
    this.slashes.push({ x, y: y - 2, angle, range: range || 24, arc: arc || 1.5, c: col, age: 0, life: 0.17 });
    const orbit = weapon === 'fist' || weapon === 'shield';
    this.act(x, y, charId, orbit ? 'punch' : 'swing', orbit ? 0.16 : 0.14, arc || 1.5);
    for (let i = 0; i < 4; i++) {
      const a = angle + rand(-arc / 2, arc / 2);
      const d = (range || 24) * rand(0.6, 1);
      this.part({ x: x + Math.cos(a) * d, y: y - 2 + Math.sin(a) * d, vx: Math.cos(a) * 20, vy: Math.sin(a) * 20, life: 0.2, c: i % 2 ? '#ffffff' : col, k: 1 });
    }
  }

  boom(x, y, radius, sprite) {
    const R = Math.max(6, radius || 16);
    const cols = SPRITE_COLORS[sprite] || ['#ffffff', '#dddddd'];
    if (sprite === 'slam') {
      this.ring(x, y, 3, R, '#c8ad84', 0.35, 2);
      this.ring(x, y, 2, R * 0.6, '#ffffff', 0.18, 1);
      this.decals.push({ x, y, cv: makeCrack(Math.round(R * 0.75), (Math.random() * 1000) | 0), age: 0, life: 1.8 });
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2 + rand(-0.2, 0.2);
        const sp = rand(30, 60);
        this.part({
          x: x + Math.cos(a) * R * 0.4, y: y + Math.sin(a) * R * 0.4, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp * 0.8, vz: rand(5, 15),
          drag: 3, life: rand(0.45, 0.7), c: pick(cols), s: 2, s2: rand(3, 5), k: 2, a: 0.85,
        });
      }
      for (let i = 0; i < 10; i++) {
        const a = Math.random() * Math.PI * 2;
        const sp = rand(20, 60);
        this.part({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, vz: rand(40, 80), g: 260, life: 0.7, c: pick(['#6e5236', '#8a6a44']), s: 1 + (i % 2) });
      }
      return;
    }
    this.ring(x, y, 2, R, cols[0], 0.3, 2);
    this.ring(x, y, 1, R * 0.55, '#ffffff', 0.15, 1);
    this.part({ x, y, z: 2, life: 0.12, c: '#ffffff', s: 4, s2: 7, k: 2 });
    const n = sprite === 'cob' ? 22 : 18;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = rand(25, 85) * (R / 18);
      const big = sprite === 'cob' && i % 3 === 0;
      this.part({
        x, y, z: 2, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, vz: rand(30, 90), g: 240, drag: 1,
        life: rand(0.45, 0.8), c: pick(cols), s: big ? 3 : 1 + (i % 2), k: sprite === 'cob' && i % 4 === 1 ? 1 : 0,
      });
    }
    if (JUICY[sprite]) {
      this.decals.push({ x, y, cv: makeSplat(Math.round(R * 0.55), JUICY[sprite], (Math.random() * 1000) | 0), age: 0, life: 1.4, a: 0.75 });
    }
  }

  pop(x, y, sprite) {
    const cols = SPRITE_COLORS[sprite] || ['#ffffff', '#dddddd'];
    const big = sprite === 'bigCarrot' || sprite === 'melon';
    this.ring(x, y - BULLET_HEIGHT, 1, big ? 8 : 4, cols[1] || cols[0], 0.15, 1);
    for (let i = 0; i < (big ? 12 : 7); i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = rand(15, 50);
      this.part({
        x, y, z: BULLET_HEIGHT, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, vz: rand(10, 50), g: 200,
        life: rand(0.25, 0.45), c: pick(cols), s: 1,
      });
    }
  }

  ko(x, y, team, charId) {
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const sp = rand(14, 30);
      this.part({
        x: x + Math.cos(a) * 3, y: y - 2 + Math.sin(a) * 2, z: rand(0, 6), vx: Math.cos(a) * sp, vy: Math.sin(a) * sp * 0.7, vz: rand(4, 14),
        drag: 3, life: rand(0.45, 0.7), c: pick(['#ffffff', '#e8e4dc', '#cfc9be']), s: 2, s2: rand(4, 6), k: 2,
      });
    }
    const tc = this.r.sideColor(team) === 'red' ? '#ff8a8a' : '#8ac8ff';
    for (let i = 0; i < 5; i++) {
      const a = Math.random() * Math.PI * 2;
      this.part({ x, y, z: 6, vx: Math.cos(a) * 30, vy: Math.sin(a) * 20, vz: rand(30, 50), g: 80, life: 0.6, c: i % 2 ? tc : '#ffe14a', k: 3, s: 1 });
    }
    const left = this.r.players.find((p) => p.charId === charId && Math.abs(p.x - x) < 20 && Math.abs(p.y - y) < 20);
    this.ghosts.push({ x, y, age: -0.12, life: 1.4, charId, left: left ? Math.cos(left.aim || 0) < 0 : false });
  }

  spawn(x, y) {
    this.ring(x, y + 4, 2, 14, '#bff4ff', 0.35, 1);
    this.ring(x, y + 4, 2, 20, '#ffffff', 0.45, 1, 0.08);
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      this.part({
        x: x + Math.cos(a) * 6, y: y + 3 + Math.sin(a) * 3, vx: Math.cos(a) * 22, vy: Math.sin(a) * 12, vz: rand(15, 35),
        drag: 2, life: rand(0.5, 0.8), c: pick(['#ffffff', '#bff4ff', '#fff6a0']), k: 1,
      });
    }
    for (let i = 0; i < 8; i++) {
      this.part({ x: x + rand(-6, 6), y: y + rand(-1, 4), vz: rand(25, 45), life: rand(0.4, 0.7), c: '#ffffff', s: 1, a: 0.85 });
    }
  }

  slip(x, y) {
    for (let i = 0; i < 12; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = rand(15, 45);
      this.part({ x, y, z: 2, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, vz: rand(30, 70), g: 220, life: 0.55, c: pick(['#f8dc3a', '#fff3b0', '#d9b21e']), s: 1 + (i % 2) });
    }
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2;
      this.part({ x, y, z: 8, vx: Math.cos(a) * 22, vy: Math.sin(a) * 14, vz: rand(25, 40), g: 60, life: 0.7, c: '#ffe14a', k: 3, s: 2 });
    }
    this.ring(x, y, 2, 10, '#fff3b0', 0.25, 1);
  }

  bonk(x, y) {
    for (let i = 0; i < 6; i++) {
      const a = Math.random() * Math.PI * 2;
      this.part({
        x, y, z: 3, vx: Math.cos(a) * 18, vy: Math.sin(a) * 12, vz: rand(4, 12), drag: 3,
        life: rand(0.3, 0.45), c: pick(['#d9c9a3', '#c8b58c', '#ffffff']), s: 1, s2: 3, k: 2, a: 0.85,
      });
    }
    this.part({ x, y, z: 8, vz: 20, vx: rand(-8, 8), g: 50, life: 0.45, c: '#ffe14a', k: 3, s: 1 });
  }

  // (x, y) 是開火那個人的腳底位置；火光會自動放在武器尖端
  muzzle(x, y, angle, charId) {
    const tip = weaponTip(charId, x, y, angle);
    const [c1, c2] = MUZZLE_COLOR[charId] || ['#ffffff', '#ffe14a'];
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    this.part({ x: tip.x, y: tip.y, life: 0.07, c: '#ffffff', s: 2, s2: 3, k: 2 });
    for (let i = 0; i < 4; i++) {
      const a = angle + rand(-0.6, 0.6);
      const sp = rand(30, 70);
      this.part({ x: tip.x, y: tip.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, drag: 6, life: rand(0.1, 0.2), c: i % 2 ? c1 : c2, s: 1 });
    }
    this.part({ x: tip.x + dx * 2, y: tip.y + dy * 2, vx: dx * 10, vy: dy * 10 - 4, drag: 4, life: 0.3, c: '#e8e4dc', s: 1, s2: 2, k: 2, a: 0.6 });
    const ch = CHAR_BY_ID[charId];
    const orbit = ch && (ch.look.weapon === 'orange' || ch.look.weapon === 'bucket');
    this.act(x, y, charId, orbit ? 'punch' : 'recoil', orbit ? 0.18 : 0.1);
  }

  superCast(x, y, charId) {
    this.ring(x, y - 2, 4, 26, '#ffe14a', 0.4, 2);
    this.ring(x, y - 2, 2, 14, '#ffffff', 0.22, 1);
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2;
      this.part({
        x: x + Math.cos(a) * 8, y: y + Math.sin(a) * 4, z: 2, vx: Math.cos(a) * 30, vy: Math.sin(a) * 18, vz: rand(20, 45),
        drag: 2.5, life: rand(0.5, 0.75), c: pick(['#ffe14a', '#fff6c0', '#ffc23a']), k: i % 3 === 0 ? 3 : 1, s: 1,
      });
    }
  }
}

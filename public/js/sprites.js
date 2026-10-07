// 水豚大亂鬥的像素美術：全部在執行時用程式畫出來，不載入任何圖檔。
// 每張圖是一串 ASCII（一個字元 = 一個像素），只畫填色，深棕色外框自動補上；
// 畫好的小畫布會快取起來，之後每一幀直接貼上。
import { TILE } from '/shared/constants.js';
import { MAP_W, MAP_H, WORLD_W, WORLD_H, tileAt } from '/shared/map.js';
import { CHAR_BY_ID, CHARACTERS } from '/shared/characters.js';

export const OUTLINE = '#2a170d';

// ---------- 基本工具 ----------

export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(w));
  c.height = Math.max(1, Math.ceil(h));
  return c;
}

const rgbCache = new Map();
function rgb(hex) {
  let v = rgbCache.get(hex);
  if (!v) {
    const n = parseInt(hex.slice(1), 16);
    v = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    rgbCache.set(hex, v);
  }
  return v;
}

// 固定的雜湊亂數（0~1），讓地圖每次畫出來都一樣
export function hash(x, y, s = 0) {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(s | 0, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function vnoise(x, y, scale, seed) {
  const fx = x / scale;
  const fy = y / scale;
  const ix = Math.floor(fx);
  const iy = Math.floor(fy);
  const tx = fx - ix;
  const ty = fy - iy;
  const a = hash(ix, iy, seed);
  const b = hash(ix + 1, iy, seed);
  const c = hash(ix, iy + 1, seed);
  const d = hash(ix + 1, iy + 1, seed);
  const sx = tx * tx * (3 - 2 * tx);
  const sy = ty * ty * (3 - 2 * ty);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

// 像素格：{ w, h, c: 每格的顏色字串或 null }
function gridFromRows(rows, pal) {
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const c = new Array(w * h).fill(null);
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      if (ch !== '.' && ch !== ' ') c[y * w + x] = pal[ch] || '#ff00ff';
    }
  });
  return { w, h, c };
}

// 自動外框：格子四周多 1 像素，貼著填色的空格塗上外框色
function outlineGrid(g, color = OUTLINE) {
  const w = g.w + 2;
  const h = g.h + 2;
  const c = new Array(w * h).fill(null);
  const filled = (x, y) => x >= 0 && y >= 0 && x < g.w && y < g.h && g.c[y * g.w + x] !== null;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = x - 1;
      const sy = y - 1;
      if (filled(sx, sy)) c[y * w + x] = g.c[sy * g.w + sx];
      else if (color && (filled(sx + 1, sy) || filled(sx - 1, sy) || filled(sx, sy + 1) || filled(sx, sy - 1))) c[y * w + x] = color;
    }
  }
  return { w, h, c };
}

function gridToCanvas(g) {
  const cv = makeCanvas(g.w, g.h);
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(g.w, g.h);
  for (let i = 0; i < g.c.length; i++) {
    const col = g.c[i];
    if (!col) continue;
    const [r, gg, b] = rgb(col);
    img.data[i * 4] = r;
    img.data[i * 4 + 1] = gg;
    img.data[i * 4 + 2] = b;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return cv;
}

export function spriteFrom(rows, pal, outline = OUTLINE) {
  return gridToCanvas(outlineGrid(gridFromRows(rows, pal), outline));
}

// 以 (pcx, pcy) 為中心旋轉像素格（最近鄰取樣，像素不會糊掉）。flipY：先上下翻轉再轉。
function rotateGrid(g, angle, pcx, pcy, flipY = false) {
  let R = 0;
  for (const [x, y] of [[0, 0], [g.w, 0], [0, g.h], [g.w, g.h]]) R = Math.max(R, Math.hypot(x - pcx, y - pcy));
  const half = Math.ceil(R);
  const S = half * 2 + 1;
  const c = new Array(S * S).fill(null);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  for (let v = 0; v < S; v++) {
    for (let u = 0; u < S; u++) {
      const rx = u - half;
      const ry = v - half;
      const sx = rx * cos + ry * sin;
      let sy = -rx * sin + ry * cos;
      if (flipY) sy = -sy;
      const gx = Math.floor(pcx + sx + 1e-6);
      const gy = Math.floor(pcy + sy + 1e-6);
      if (gx < 0 || gy < 0 || gx >= g.w || gy >= g.h) continue;
      c[v * S + u] = g.c[gy * g.w + gx];
    }
  }
  return { grid: { w: S, h: S, c }, half };
}

// 純白剪影（受傷閃白用）
const whiteCache = new WeakMap();
export function whiteOf(cv) {
  let w = whiteCache.get(cv);
  if (!w) {
    w = makeCanvas(cv.width, cv.height);
    const x = w.getContext('2d');
    x.drawImage(cv, 0, 0);
    x.globalCompositeOperation = 'source-in';
    x.fillStyle = '#ffffff';
    x.fillRect(0, 0, w.width, w.height);
    whiteCache.set(cv, w);
  }
  return w;
}

function flipH(cv) {
  const f = makeCanvas(cv.width, cv.height);
  const x = f.getContext('2d');
  x.translate(cv.width, 0);
  x.scale(-1, 1);
  x.drawImage(cv, 0, 0);
  return f;
}

// 像素橢圓：thick = 0 實心；thick > 0 只畫外圈；edge 給的話外圈 1 像素用 edge 色
const shapeCache = new Map();
export function ellipseSprite(rx, ry, fill, thick = 0, edge = null) {
  rx = Math.max(0, Math.round(rx));
  ry = Math.max(0, Math.round(ry));
  const key = `${rx}|${ry}|${fill}|${thick}|${edge}`;
  let cv = shapeCache.get(key);
  if (cv) return cv;
  const w = rx * 2 + 1;
  const h = ry * 2 + 1;
  const g = { w, h, c: new Array(w * h).fill(null) };
  const inside = (dx, dy, a, b) => a > 0 && b > 0 && (dx * dx) / (a * a) + (dy * dy) / (b * b) <= 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x - rx;
      const dy = y - ry;
      if (!inside(dx, dy, rx + 0.5, ry + 0.5)) continue;
      const ring1 = !inside(dx, dy, rx - 0.5, ry - 0.5);
      if (thick > 0 && inside(dx, dy, rx + 0.5 - thick, ry + 0.5 - thick)) continue;
      g.c[y * w + x] = edge && ring1 ? edge : fill;
    }
  }
  cv = gridToCanvas(g);
  shapeCache.set(key, cv);
  return cv;
}

// 圓周上的像素點（含角度），轉圈的拖影會用到
const ringPtsCache = new Map();
export function ringPoints(r) {
  r = Math.round(r);
  let pts = ringPtsCache.get(r);
  if (pts) return pts;
  pts = [];
  for (let y = -r - 1; y <= r + 1; y++) {
    for (let x = -r - 1; x <= r + 1; x++) {
      const d = Math.hypot(x, y);
      if (d <= r + 0.5 && d > r - 0.5) pts.push({ x, y, a: Math.atan2(y, x) });
    }
  }
  ringPtsCache.set(r, pts);
  return pts;
}

// ---------- 水豚本體 ----------

const FUR_COMMON = { e: '#1a0f0a', n: '#3d2215', c: '#e8a090', m: '#3d2215' };
const FURS = {
  normal: { l: '#c99456', b: '#a8703f', d: '#83532d', r: '#6b4024', g: '#6e4425' },
  light: { l: '#dcac6e', b: '#bd8a52', d: '#98693c', r: '#7b4f2c', g: '#7d5232' },
  dark: { l: '#ad7a48', b: '#8c5c34', d: '#6c4325', r: '#55331b', g: '#593820' },
  golden: { l: '#e8bb62', b: '#cf9a40', d: '#a8762c', r: '#80541e', g: '#875a24' },
  grey: { l: '#bba48d', b: '#9b826b', d: '#7a6452', r: '#5f4b3c', g: '#62503f' },
};

const CAPY_TOP = [
  '...........rr.....',
  '..........lllllll.',
  '...lllllllllllllll',
  '.lllllllllllllebbb',
  'bbbbbbbbbbbbbbbbbn',
  'bbbbbbbbbbbbbbbbbb',
  'bbbbbbbbbbbbbbcbmm',
  'dbbbbbbbbbbbbbbbb.',
  '.ddddddddddddddd..',
];
const LEGS = {
  idle: ['.gg..gg....gg..gg.', '.gg..gg....gg..gg.'],
  a: ['.gg..gg....gg..gg.', 'gg.....gg.gg....gg'],
  b: ['.gg..gg....gg..gg.', '..gg.gg.....gggg..'],
};

function bodyRows(frame) {
  const top = CAPY_TOP.slice();
  if (frame === 'blink') top[3] = top[3].replace('e', 'd');
  return top.concat(LEGS[frame] || LEGS.idle);
}

// 帽子：[調色盤, x, y（相對身體左上角）, 圖]
const HATS = {
  cap: [{ G: '#4f7d3a', g: '#6a9a4c', k: '#3e6230' }, 8, -2, [
    '..GGGGG...',
    '.GGgGGGG..',
    'GGGGGGGGkkk']],
  yuzu: [{ O: '#f6a21a', o: '#ffd36b', g: '#4f9a3a' }, 11, -5, [
    '..gg.',
    '.OOO.',
    'OOoOO',
    'OOOOO',
    '.OOO.']],
  melon: [{ G: '#2f7a2f', g: '#5fb54a', r: '#e8434a', w: '#f4f0d0' }, 8, -3, [
    '..GgGgGg..',
    '.GgGgGgGg.',
    'GgGgGgGgGg',
    'wwwwwwwwww']],
  straw: [{ Y: '#e8c25a', y: '#c9a040', R: '#d0402a' }, 8, -3, [
    '...YYYY...',
    '...RRRR...',
    'YYYYYYYYYYY']],
  band: [{ R: '#e03b3b', r: '#b02a2a' }, 6, 2, [
    '....RRRRRRRR',
    '..RR........',
    '.R.r........']],
  kasa: [{ Y: '#d9b25a', y: '#b48a3a' }, 7, -4, [
    '.....yy.....',
    '...YYyyYY...',
    '.YYYYyyYYYY.',
    'YYYYYyyYYYYY']],
  crown: [{ g: '#3f9a3a', G: '#6ccf4f' }, 11, -4, [
    'g.G.g',
    'gGgGg',
    '.GgG.']],
  pumpkin: [{ O: '#f08a1e', o: '#c7650f', s: '#4f7d3a' }, 8, -4, [
    '....s.....',
    '..OOOOOO..',
    '.OoOOoOOo.',
    'OOoOOoOOoO',
    'OoOOoOOoOO']],
  coco: [{ C: '#6b4226', c: '#8a5a36', w: '#f4ead0' }, 8, -3, [
    '..CCcCC...',
    '.CcCCCcC..',
    'CCCCcCCCC.',
    'wwwwwwwww.']],
  towel: [{ W: '#ffffff', w: '#dfe8ee', B: '#5aa0e0' }, 9, -2, [
    '.WWWWWW.',
    'wBBBBBBw',
    'WWWWWWWW']],
};

// 武器：圖（武器畫在身體 (12,5) 的位置，朝右）＋握把（旋轉中心）
// style 'rotate'：繞握把轉向瞄準方向；'orbit'：圓圓的武器，在身體前方繞著跑、不旋轉
const WEAPONS = {
  carrot: { style: 'rotate', pivot: [3, 2], pal: { g: '#4f9a3a', O: '#f08a1e', o: '#c7650f', H: '#5a3a22' }, rows: [
    'gg.........',
    '.gOOOOOOo..',
    'ggOOOOOOOOo',
    '.gOoOOOOo..',
    '...HH......',
    '...HH......'] },
  orange: { style: 'orbit', pal: { O: '#f6a21a', o: '#ffd36b', g: '#4f9a3a' }, rows: [
    '.gg.',
    'OOoO',
    'OOOO',
    '.OO.'] },
  melon: { style: 'rotate', pivot: [2, 2], pal: { G: '#2f7a2f', R: '#e8434a', k: '#2a1a10', w: '#f4f0d0', H: '#5a3a22' }, rows: [
    'GGGGGGG...',
    'wRRRRRRRR.',
    'wRkRRkRRRR',
    'wRRRRRRRR.',
    'GGGGGGG...',
    '..HH......'] },
  corn: { style: 'rotate', pivot: [2, 2], pal: { G: '#4f9a3a', Y: '#f4d23a', y: '#d9a91e', H: '#5a3a22' }, rows: [
    'GG............',
    'GYYYYYYYYYYYY.',
    'GYyYyYyYyYyYYY',
    'GYYYYYYYYYYYY.',
    'GG..HH........'] },
  banana: { style: 'rotate', pivot: [1, 3], pal: { Y: '#f8dc3a', y: '#d9b21e', b: '#5a3a22' }, rows: [
    '..........yy',
    '........yYY.',
    'bYYYYYYYYY..',
    'bYYYYYYy....'] },
  leek: { style: 'rotate', pivot: [2, 1], pal: { W: '#f4f4ec', L: '#b8e07a', G: '#4f9a3a', r: '#d8cfa8' }, rows: [
    'rWWWWWWLLLLLLGGG',
    'rWWWWWWLLLLLLGG.'] },
  fist: { style: 'orbit', pal: { g: '#3f9a3a', Y: '#f4c63a', y: '#c9932a' }, rows: [
    '.g.g.',
    'ggggg',
    'YyYyY',
    'yYyYy',
    'YyYyY',
    '.YYY.'] },
  shield: { style: 'orbit', pal: { O: '#f08a1e', o: '#c7650f', s: '#4f7d3a' }, rows: [
    '..OOOO..',
    '.OoOOoO.',
    'OOoOOoOO',
    'OOoOOoOO',
    'OOoOOoOO',
    '.OoOOoO.',
    '..OOOO..'] },
  coco: { style: 'rotate', pivot: [2, 2], pal: { C: '#6b4226', c: '#8a5a36', w: '#f4ead0', W: '#ffffff' }, rows: [
    '.CCCCCC..',
    'CCcCCCCww',
    'CCCCCCCwW',
    'CCcCCCCww',
    '.CCCCCC..'] },
  bucket: { style: 'orbit', pal: { b: '#7cc8f0', W: '#b07a45', h: '#5a3a22' }, rows: [
    'bbbbbbb',
    'WWWWWWW',
    'WhWWWhW',
    'WWWWWWW',
    '.WWWWW.'] },
};
for (const w of Object.values(WEAPONS)) {
  w.grid = gridFromRows(w.rows, w.pal);
  if (w.style === 'orbit') {
    w.rx = 3 + w.grid.w / 2;
    w.canvas = gridToCanvas(outlineGrid(w.grid));
    w.canvasL = flipH(w.canvas);
  }
}

// 身體合成圖：畫布 24x21，身體填色左上角在 (3, 8)
const PAD_L = 3;
const PAD_T = 8;
const BODY_CW = 24;
const BODY_CH = 21;
// 腳底中心 (x, y) → 合成圖左上角 = (x - BODY_OX, y - BODY_OY)；腳底那一排像素在 y+5
export const BODY_OX = 9 + PAD_L;
export const BODY_OY = 5 + PAD_T;

function lookOf(charId) {
  return (CHAR_BY_ID[charId] || CHARACTERS[0]).look;
}

const bodyCache = new Map();
export function getBody(charId, frame = 'idle', left = false, white = false) {
  const key = `${charId}|${frame}|${left ? 1 : 0}`;
  let entry = bodyCache.get(key);
  if (!entry) {
    let cv;
    if (left) {
      cv = flipH(getBody(charId, frame, false));
    } else {
      const look = lookOf(charId);
      const pal = { ...FUR_COMMON, ...(FURS[look.fur] || FURS.normal) };
      cv = makeCanvas(BODY_CW, BODY_CH);
      const x = cv.getContext('2d');
      x.drawImage(spriteFrom(bodyRows(frame), pal), PAD_L - 1, PAD_T - 1);
      const hat = HATS[look.hat];
      if (hat) x.drawImage(spriteFrom(hat[3], hat[0]), PAD_L + hat[1] - 1, PAD_T + hat[2] - 1);
    }
    entry = { cv };
    bodyCache.set(key, entry);
  }
  if (white) return entry.white || (entry.white = whiteOf(entry.cv));
  return entry.cv;
}

const ROT_STEPS = 64;
const rotCache = new Map();
function rotatedWeapon(name, angle, flip) {
  const step = ((Math.round((angle / (Math.PI * 2)) * ROT_STEPS) % ROT_STEPS) + ROT_STEPS) % ROT_STEPS;
  const key = `${name}|${step}|${flip ? 1 : 0}`;
  let r = rotCache.get(key);
  if (!r) {
    const w = WEAPONS[name];
    const a = (step / ROT_STEPS) * Math.PI * 2;
    const { grid, half } = rotateGrid(w.grid, a, w.pivot[0] + 0.5, w.pivot[1] + 0.5, flip);
    r = { cv: gridToCanvas(outlineGrid(grid)), o: half + 1 };
    rotCache.set(key, r);
  }
  return r;
}

function normAngle(a) {
  a %= Math.PI * 2;
  if (a > Math.PI) a -= Math.PI * 2;
  if (a < -Math.PI) a += Math.PI * 2;
  return a;
}

// 武器尖端位置（世界座標），槍口火光用
export function weaponTip(charId, x, y, aim) {
  const w = WEAPONS[lookOf(charId).weapon];
  const dx = Math.cos(aim);
  const dy = Math.sin(aim);
  if (!w) return { x: x + dx * 10, y: y - 2 + dy * 10 };
  if (w.style === 'orbit') {
    const ry = dy < 0 ? w.rx * 1.1 : w.rx * 0.55;
    const r = w.grid.w / 2 + 1;
    return { x: x + w.rx * dx + dx * r, y: y + w.grid.h / 2 + ry * dy + dy * r };
  }
  const left = dx < 0;
  const ax = 12 + w.pivot[0];
  const ay = 5 + w.pivot[1];
  const px = x + (left ? 8 - ax : ax - 9) + 0.5;
  const py = y - 5 + ay + 0.5;
  const len = w.grid.w - w.pivot[0];
  return { x: px + dx * len, y: py + dy * len };
}

// 畫一隻水豚（含帽子、武器）。(x, y) 是腳底中心，必須是整數像素。
// o: { aim, frame, bob, white, facingLeft, crop（泡在水裡要藏起來的下半身像素）,
//      swing（揮砍時武器額外角度）, recoil（後座力像素）, punch（往前推的像素）, spinAngle（旋風時武器角度） }
export function drawCapybara(ctx, charId, x, y, o = {}) {
  const look = lookOf(charId);
  const aim = o.aim ?? 0;
  const left = o.facingLeft ?? Math.cos(aim) < 0;
  const bob = o.bob || 0;
  const white = !!o.white;
  const body = getBody(charId, o.frame || 'idle', left, white);
  const bx = x - BODY_OX;
  const by = y - BODY_OY - bob;
  const w = WEAPONS[look.weapon];

  let wcv = null;
  let wx = 0;
  let wy = 0;
  let behind = false;
  if (w) {
    if (o.spinAngle != null && w.style === 'rotate') {
      const a = o.spinAngle;
      const r = rotatedWeapon(look.weapon, a, Math.cos(a) < 0);
      wcv = r.cv;
      wx = x - r.o + Math.round(Math.cos(a) * 3);
      wy = y - 2 - bob - r.o + Math.round(Math.sin(a) * 2);
      behind = Math.sin(a) < 0;
    } else if (w.style === 'rotate') {
      const a = aim + (o.swing || 0);
      const r = rotatedWeapon(look.weapon, a, left);
      const ax = 12 + w.pivot[0];
      const ay = 5 + w.pivot[1];
      const back = o.recoil || 0;
      wcv = r.cv;
      wx = x + (left ? 8 - ax : ax - 9) - r.o - Math.round(Math.cos(aim) * back);
      wy = y - 5 + ay - bob - r.o - Math.round(Math.sin(aim) * back);
      behind = Math.sin(normAngle(a)) < -0.8;
    } else {
      const dx = Math.cos(aim);
      const dy = Math.sin(aim);
      const ry = dy < 0 ? w.rx * 1.1 : w.rx * 0.55;
      const push = (o.punch || 0) - (o.recoil || 0);
      const cx = x + w.rx * dx + dx * push;
      const cy = y + w.grid.h / 2 + ry * dy + dy * push * 0.6 - bob;
      wcv = left ? w.canvasL : w.canvas;
      wx = Math.round(cx - w.grid.w / 2) - 1;
      wy = Math.round(cy - w.grid.h / 2) - 1;
      behind = dy < -0.5;
    }
    if (white) wcv = whiteOf(wcv);
  }

  if (wcv && behind) ctx.drawImage(wcv, wx, wy);
  if (o.crop) {
    const sh = BODY_CH - 1 - o.crop;
    if (sh > 0) ctx.drawImage(body, 0, 0, BODY_CW, sh, bx, by, BODY_CW, sh);
  } else {
    ctx.drawImage(body, bx, by);
  }
  if (wcv && !behind) ctx.drawImage(wcv, wx, wy);
}

// ---------- 大廳角色卡用的頭像 ----------

let portraitBoxes = null;
function measurePortraits() {
  portraitBoxes = {};
  const S = 80;
  const cv = makeCanvas(S, S);
  const x = cv.getContext('2d', { willReadFrequently: true });
  let top = S;
  let bottom = 0;
  for (const ch of CHARACTERS) {
    x.clearRect(0, 0, S, S);
    drawCapybara(x, ch.id, 40, 40, { aim: 0 });
    const d = x.getImageData(0, 0, S, S).data;
    let x0 = S;
    let x1 = 0;
    for (let yy = 0; yy < S; yy++) {
      for (let xx = 0; xx < S; xx++) {
        if (d[(yy * S + xx) * 4 + 3] === 0) continue;
        x0 = Math.min(x0, xx);
        x1 = Math.max(x1, xx);
        top = Math.min(top, yy);
        bottom = Math.max(bottom, yy);
      }
    }
    portraitBoxes[ch.id] = { x0: x0 - 40, x1: x1 - 40 };
  }
  portraitBoxes.top = top - 40;
  portraitBoxes.bottom = bottom - 40;
}

// 在 canvas 上畫角色頭像（朝右、站著），整數倍放大、不模糊。
// 所有角色的頭像高度一樣、腳底在同一條線上；寬度依武器長短而不同。
export function drawPortrait(canvas, charId, scale = 4) {
  if (!portraitBoxes) measurePortraits();
  const box = portraitBoxes[charId] || portraitBoxes[CHARACTERS[0].id];
  const s = Math.max(1, Math.round(scale));
  const x0 = Math.min(box.x0, -9) - 1;
  const x1 = Math.max(box.x1, 9) + 1;
  const y0 = portraitBoxes.top - 1;
  const y1 = Math.max(portraitBoxes.bottom, 7) + 1;
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  const tmp = makeCanvas(w, h);
  const t = tmp.getContext('2d');
  t.globalAlpha = 0.25;
  const sh = ellipseSprite(9, 2, '#000000');
  t.drawImage(sh, -x0 - 9, -y0 + 5 - 1);
  t.globalAlpha = 1;
  drawCapybara(t, charId, -x0, -y0, { aim: 0 });
  canvas.width = w * s;
  canvas.height = h * s;
  canvas.style.imageRendering = 'pixelated';
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(tmp, 0, 0, w * s, h * s);
}

// ---------- 子彈與道具 ----------

const PROJ = {
  carrot: { pal: { g: '#4f9a3a', O: '#f08a1e', o: '#c7650f', h: '#ffb45a' }, rows: [
    'gg......',
    '.gOhhO..',
    'ggOOOOoO',
    '.gOoOo..',
    'gg......'] },
  bigCarrot: { pal: { g: '#4f9a3a', G: '#6cbf4a', O: '#f08a1e', o: '#c7650f', h: '#ffb45a' }, rows: [
    'gG............',
    '.gGOOOOo......',
    'gGOOhhhhOOo...',
    '.gOOoOOOoOOOOo',
    'gGOOOOOOOOo...',
    '.gGOOoOo......',
    'gG............'] },
  orange: { pal: { O: '#f6a21a', h: '#ffd36b', d: '#d07a12', g: '#4f9a3a' }, rows: [
    '..gg..',
    '.OOgO.',
    'OOhhOO',
    'OOhOOO',
    'dOOOOO',
    '.ddOO.'] },
  seed: { pal: { k: '#2e1c12', h: '#7a5a46' }, rows: [
    '.kk.',
    'khkk',
    '.kk.'] },
  melon: { pal: { G: '#2f7a2f', g: '#6cc04f', h: '#b6ec8a' }, rows: [
    '....GgGG....',
    '..GgGGgGGg..',
    '.GghGgGGgGG.',
    '.GhGGgGGgGG.',
    'GGgGGgGGgGGG',
    'GgGGgGGgGGgG',
    'GgGGgGGgGGgG',
    'GGgGGgGGgGGG',
    '.GgGGgGGgGG.',
    '.GGgGGgGGgG.',
    '..GGgGGgGG..',
    '....GGgG....'] },
  kernel: { pal: { Y: '#f4d23a', h: '#fff1a0', y: '#d9a91e' }, rows: [
    '.YYY.',
    'YhYYY',
    '.yyy.'] },
  cob: { pal: { Y: '#f4d23a', y: '#d9a91e', g: '#4f9a3a', G: '#6cbf4a' }, rows: [
    '.YYY.',
    'YyYyY',
    'YYyYY',
    'YyYyY',
    'YYyYY',
    'YyYyY',
    'gYYYg',
    'gGYGg',
    '.ggg.'] },
  popcorn: { pal: { w: '#fffbe8', W: '#efe0b8', y: '#f4d23a' }, rows: [
    '.ww..',
    'wwwWw',
    'wWwww',
    '.wwy.'] },
  shard: { pal: { C: '#6b4226', c: '#8a5a36', w: '#f4ead0' }, rows: [
    'CCc..',
    'Cwwww',
    '.CCc.'] },
  drop: { pal: { b: '#5ab4ea', B: '#9fdcff', W: '#ffffff' }, rows: [
    '...BB.',
    'bbBBWB',
    '...BB.'], outline: '#1f4a6e' },
};
for (const p of Object.values(PROJ)) {
  p.grid = gridFromRows(p.rows, p.pal);
  p.canvas = gridToCanvas(outlineGrid(p.grid, p.outline || OUTLINE));
}

const PROJ_STEPS = 32;
const projCache = new Map();
// 子彈圖（依角度旋轉，中心點在 (o, o)）
export function getProjectile(name, angle = 0) {
  const p = PROJ[name] || PROJ.carrot;
  const step = ((Math.round((angle / (Math.PI * 2)) * PROJ_STEPS) % PROJ_STEPS) + PROJ_STEPS) % PROJ_STEPS;
  const key = `${name}|${step}`;
  let r = projCache.get(key);
  if (!r) {
    const a = (step / PROJ_STEPS) * Math.PI * 2;
    const { grid, half } = rotateGrid(p.grid, a, p.grid.w / 2, p.grid.h / 2);
    r = { cv: gridToCanvas(outlineGrid(grid, p.outline || OUTLINE)), o: half + 1 };
    projCache.set(key, r);
  }
  return r;
}

// 不旋轉的原圖
export function getProjectileFlat(name) {
  return (PROJ[name] || PROJ.carrot).canvas;
}

const PEEL_ROWS = [
  '.....bb......',
  '.....YY......',
  '....YwwY.....',
  '...YwwwwY....',
  '..yYwwwwYYy..',
  '.yYYYwwYYYYy.',
  'yY..YYYY...Yy',
  'y...yY.Yy....',
  '.......y.....',
];
const PEEL_PAL = { Y: '#f8dc3a', y: '#c9a020', w: '#fff3b0', b: '#6b4a24' };
const peelCache = {};
// 香蕉皮（外框顏色淡淡區分敵我）。color：'blue'（自己人）/'red'（敵人）/其他 = 一般外框
export function getPeel(team) {
  const k = team || 'none';
  if (!peelCache[k]) {
    const color = team === 'blue' ? '#1d4f8f' : team === 'red' ? '#8f1d24' : OUTLINE;
    peelCache[k] = spriteFrom(PEEL_ROWS, PEEL_PAL, color);
  }
  return peelCache[k];
}

let starSprite = null;
let tinyStar = null;
// 暈眩的小星星
export function getStar(small = false) {
  if (!starSprite) {
    starSprite = spriteFrom(['..Y..', '.YYY.', 'YYWYY', '.YYY.', '.Y.Y.'], { Y: '#ffd84a', W: '#fff8d0' });
    tinyStar = spriteFrom(['.Y.', 'YWY', '.Y.'], { Y: '#ffd84a', W: '#fffbe0' });
  }
  return small ? tinyStar : starSprite;
}

const GHOST_ROWS = [
  '...........ww.....',
  '..........wwwwwww.',
  '...wwwwwwwwwwwwwww',
  '.wwwwwwwwwwwwwewww',
  'wwwwwwwwwwwwwwwwwn',
  'wwwwwwwwwwwwwwwwww',
  'wwwwwwwwwwwwwwcwww',
  'wwwwwwwwwwwwwwwww.',
  '.www..wwww..www.w.',
  '..w....ww....w....',
];
let ghostSprite = null;
// 被擊倒時飄上天的水豚小幽靈
export function getGhost() {
  if (!ghostSprite) {
    ghostSprite = spriteFrom(GHOST_ROWS, { w: '#eef6ff', e: '#33405a', n: '#8fa4c4', c: '#f5b8c8' }, '#7d99c4');
  }
  return ghostSprite;
}

// 溫泉池（技能變出來的）：水面 + 隊伍顏色的池邊
const springCache = new Map();
export function getSpringPool(r, team) {
  r = Math.round(r);
  const key = `${r}|${team}`;
  let cv = springCache.get(key);
  if (cv) return cv;
  const rim = team === 'red' ? ['#ff5a5a', '#c83a3a'] : ['#4aa3ff', '#2f72c0'];
  const S = r * 2 + 1;
  const g = { w: S, h: S, c: new Array(S * S).fill(null) };
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const d = Math.hypot(x - r, y - r);
      if (d > r + 0.5) continue;
      let col;
      if (d > r - 0.5) col = rim[1];
      else if (d > r - 2.2) col = rim[0];
      else if (d > r - 3.2) col = '#d8fbf5';
      else if (d > r - 7) col = '#a6ebe1';
      else if (d > r * 0.45) col = '#86ded3';
      else col = '#6fd2c7';
      if (d < r - 3.5 && hash(x, y, r) > 0.97) col = '#e6fffb';
      g.c[y * S + x] = col;
    }
  }
  cv = gridToCanvas(g);
  springCache.set(key, cv);
  return cv;
}

// 南瓜護盾泡泡
let bubbleSprite = null;
export function getShieldBubble() {
  if (bubbleSprite) return bubbleSprite;
  const rx = 13;
  const ry = 12;
  const w = rx * 2 + 1;
  const h = ry * 2 + 1;
  const cv = makeCanvas(w, h);
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(w, h);
  const put = (x, y, hex, a) => {
    const [r, g, b] = rgb(hex);
    const i = (y * w + x) * 4;
    img.data[i] = r;
    img.data[i + 1] = g;
    img.data[i + 2] = b;
    img.data[i + 3] = a;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (x - rx) / (rx + 0.5);
      const dy = (y - ry) / (ry + 0.5);
      const d = dx * dx + dy * dy;
      if (d > 1) continue;
      const inner = ((x - rx) / (rx - 0.6)) ** 2 + ((y - ry) / (ry - 0.6)) ** 2;
      if (inner > 1) put(x, y, '#e8741a', 230);
      else if (inner > 0.78) put(x, y, '#ffb04a', 150);
      else if (Math.abs(x - rx) === 6 || x === rx) put(x, y, '#ff9a2a', 70);
      else put(x, y, '#ffa940', 46);
    }
  }
  // 左上角的反光
  for (const [x, y] of [[6, 5], [7, 4], [8, 3], [9, 3], [5, 6], [5, 7]]) put(x, y, '#fff6e0', 230);
  // 頂端的南瓜蒂
  for (const [x, y] of [[rx, 0], [rx + 1, 0], [rx, 1]]) put(x, y, '#4f7d3a', 255);
  ctx.putImageData(img, 0, 0);
  bubbleSprite = cv;
  return cv;
}

// 遠方看得到的一團團小東西：裂痕、果汁漬（特效用）
export function makeSplat(r, colors, seed) {
  const S = r * 2 + 3;
  const g = { w: S, h: S, c: new Array(S * S).fill(null) };
  const c0 = r + 1;
  const blobs = [[c0, c0, r * 0.55]];
  for (let i = 0; i < 7; i++) {
    const a = hash(i, seed, 7) * Math.PI * 2;
    const d = r * (0.45 + hash(i, seed, 8) * 0.5);
    blobs.push([c0 + Math.cos(a) * d, c0 + Math.sin(a) * d, 0.8 + hash(i, seed, 9) * r * 0.22]);
  }
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      for (const [bx, by, br] of blobs) {
        if (Math.hypot(x + 0.5 - bx, y + 0.5 - by) <= br) {
          g.c[y * S + x] = hash(x, y, seed) > 0.9 ? colors[1] : colors[0];
          break;
        }
      }
    }
  }
  return gridToCanvas(g);
}

export function makeCrack(r, seed) {
  const S = r * 2 + 3;
  const g = { w: S, h: S, c: new Array(S * S).fill(null) };
  const c0 = r + 1;
  const n = 7;
  for (let i = 0; i < n; i++) {
    let a = ((i + hash(i, seed, 1) * 0.6) / n) * Math.PI * 2;
    let x = c0;
    let y = c0;
    const len = r * (0.6 + hash(i, seed, 2) * 0.4);
    for (let s = 0; s < len; s++) {
      a += (hash(i, s, seed) - 0.5) * 0.7;
      x += Math.cos(a);
      y += Math.sin(a) * 0.8;
      const ix = Math.round(x);
      const iy = Math.round(y);
      if (ix < 0 || iy < 0 || ix >= S || iy >= S) break;
      g.c[iy * S + ix] = '#3a2a1a';
      if (s < len * 0.5 && iy + 1 < S) g.c[(iy + 1) * S + ix] = g.c[(iy + 1) * S + ix] || '#5a4430';
    }
  }
  return gridToCanvas(g);
}

// ---------- 地圖 ----------

// 直接在 RGBA 陣列上點像素（畫整張地圖用）
class Painter {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.d = new Uint8ClampedArray(w * h * 4);
  }

  set(x, y, hex, a = 255) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const [r, g, b] = rgb(hex);
    const i = (y * this.w + x) * 4;
    this.d[i] = r;
    this.d[i + 1] = g;
    this.d[i + 2] = b;
    this.d[i + 3] = a;
  }

  has(x, y) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return false;
    return this.d[(y * this.w + x) * 4 + 3] > 0;
  }

  shade(x, y, f) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 4;
    this.d[i] *= f;
    this.d[i + 1] *= f;
    this.d[i + 2] *= f;
  }

  rows(x, y, rows, pal) {
    rows.forEach((row, j) => {
      for (let i = 0; i < row.length; i++) {
        const ch = row[i];
        if (ch !== '.' && pal[ch]) this.set(x + i, y + j, pal[ch]);
      }
    });
  }

  grid(x, y, g) {
    for (let j = 0; j < g.h; j++) {
      for (let i = 0; i < g.w; i++) {
        const col = g.c[j * g.w + i];
        if (col) this.set(x + i, y + j, col);
      }
    }
  }

  copyFrom(src, x, y, w, h) {
    for (let j = y; j < y + h; j++) {
      for (let i = x; i < x + w; i++) {
        if (i < 0 || j < 0 || i >= this.w || j >= this.h) continue;
        const k = (j * this.w + i) * 4;
        if (src.d[k + 3] === 0) continue;
        this.d[k] = src.d[k];
        this.d[k + 1] = src.d[k + 1];
        this.d[k + 2] = src.d[k + 2];
        this.d[k + 3] = src.d[k + 3];
      }
    }
  }

  toCanvas() {
    const cv = makeCanvas(this.w, this.h);
    cv.getContext('2d').putImageData(new ImageData(this.d, this.w, this.h), 0, 0);
    return cv;
  }
}

// 一團團圓形（草叢的葉子、溫泉邊的石頭），左上亮、右下暗，最後加外框
function paintBlobs(P, blobs, colors, outline) {
  blobs.sort((a, b) => a.y - b.y);
  for (const bl of blobs) {
    const r = bl.r;
    for (let y = Math.floor(bl.y - r); y <= Math.ceil(bl.y + r); y++) {
      for (let x = Math.floor(bl.x - r); x <= Math.ceil(bl.x + r); x++) {
        const dx = x + 0.5 - bl.x;
        const dy = y + 0.5 - bl.y;
        if (dx * dx + dy * dy > r * r) continue;
        const s = (dx + dy * 1.3) / r;
        let col = s < -0.75 ? colors[0] : s < 0.45 ? colors[1] : colors[2];
        if (s < -0.95 && colors[3]) col = colors[3];
        P.set(x, y, col);
      }
    }
  }
  if (!outline || !blobs.length) return;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const bl of blobs) {
    x0 = Math.min(x0, Math.floor(bl.x - bl.r) - 2);
    y0 = Math.min(y0, Math.floor(bl.y - bl.r) - 2);
    x1 = Math.max(x1, Math.ceil(bl.x + bl.r) + 2);
    y1 = Math.max(y1, Math.ceil(bl.y + bl.r) + 2);
  }
  const marks = [];
  for (let y = Math.max(0, y0); y < Math.min(P.h, y1); y++) {
    for (let x = Math.max(0, x0); x < Math.min(P.w, x1); x++) {
      if (P.has(x, y)) continue;
      if (P.has(x + 1, y) || P.has(x - 1, y) || P.has(x, y + 1) || P.has(x, y - 1)) marks.push(x, y);
    }
  }
  for (let i = 0; i < marks.length; i += 2) P.set(marks[i], marks[i + 1], outline);
}

const GRASS = [
  ['#5a9a47', '#61a24d', '#69ab54'],
  ['#5c9d49', '#64a650', '#6caf57'],
];
const CRATE_TOP = [
  'kkkkkkkkkkkkkkkk',
  'kFFFFFFFFFFFFFFk',
  'kFnFFFFFFFFFFnfk',
  'kFFPPPPPPPPPPffk',
  'kFFPPPPPPPPPPffk',
  'kFFppppppppppffk',
  'kFFPPPPPPPPPPffk',
  'kFFPPPPPPPPPPffk',
  'kFFppppppppppffk',
  'kFFPPPPPPPPPPffk',
  'kFFPPPPPPPPPPffk',
  'kFFppppppppppffk',
  'kFFPPPPPPPPPPffk',
  'kFnffffffffffnfk',
  'kffffffffffffffk',
  'kkkkkkkkkkkkkkkk',
];
const CRATE_FRONT = [
  'kDDDDdDDDDdDDDDk',
  'kDDDDdDDDDdDDDDk',
  'kDDDDdDDDDdDDDDk',
  'kDDDDdDDDDdDDDDk',
  'kddddddddddddddk',
  'kkkkkkkkkkkkkkkk',
];
const CRATE_PAL = {
  k: '#3a2312', F: '#d6a062', f: '#b07840', P: '#c48a4e', p: '#9a6534', n: '#f2dcaa',
  D: '#8a5530', d: '#6b3f22',
};
const LILY = ['.ggg.', 'gGgGg', 'gg.gg', '.ggg.'];
const FLOWER = ['.p.', 'pcp', '.p.'];

export const MAP_MARGIN = 8;
export const WALL_RAISE = 6; // 牆的頂面往上凸 6 像素，站在牆後面的人腳會被擋住

// 畫整張地圖。回傳：
//   ground：地面＋牆（不含會動的東西），畫布原點 = 世界 (-MAP_MARGIN, -MAP_MARGIN)
//   lips：牆頂往上凸的那一條（要蓋在角色上面）
//   bushes：每格草叢一小張圖 [{ tx, ty, x, y, cv }]（x, y 是世界座標）
//   water：水格子清單；spring：地圖中央溫泉的範圍
export function buildMapArt() {
  const M = MAP_MARGIN;
  const PW = WORLD_W + M * 2;
  const PH = WORLD_H + M * 2;
  const P = new Painter(PW, PH);
  const T = TILE;
  const at = (tx, ty) => tileAt(tx, ty);
  const isWall = (tx, ty) => at(tx, ty) === '#';
  const isSpawn = (c) => c === 'B' || c === 'R';

  // 1. 逐像素的地面
  for (let wy = 0; wy < WORLD_H; wy++) {
    for (let wx = 0; wx < WORLD_W; wx++) {
      const tx = Math.floor(wx / T);
      const ty = Math.floor(wy / T);
      const c = at(tx, ty);
      const lx = wx - tx * T;
      const ly = wy - ty * T;
      let col;
      if (c === '~') {
        col = waterColor(tx, ty, lx, ly, wx, wy);
      } else if (isSpawn(c)) {
        col = spawnColor(c, tx, ty, lx, ly, wx, wy);
      } else {
        const n = vnoise(wx, wy, 22, 3) * 0.75 + vnoise(wx, wy, 7, 9) * 0.25;
        const set = GRASS[(tx + ty) & 1];
        col = n < 0.38 ? set[0] : n < 0.62 ? set[1] : set[2];
        const h = hash(wx, wy, 1);
        if (h < 0.035) col = '#4f8b3f';
        else if (h > 0.985) col = '#7dbd62';
        if (c === 'b') col = n < 0.5 ? '#3f7a35' : '#447f39';
      }
      if (col) P.set(wx + M, wy + M, col);
    }
  }

  function waterColor(tx, ty, lx, ly, wx, wy) {
    const W = (a, b) => at(a, b) === '~';
    const dTop = W(tx, ty - 1) ? 99 : ly;
    const dBot = W(tx, ty + 1) ? 99 : T - 1 - ly;
    const dL = W(tx - 1, ty) ? 99 : lx;
    const dR = W(tx + 1, ty) ? 99 : T - 1 - lx;
    // 圓角
    const R = 3;
    for (const [dx, dy] of [[dL, dTop], [dR, dTop], [dL, dBot], [dR, dBot]]) {
      if (dx < R && dy < R && Math.hypot(R - dx - 0.5, R - dy - 0.5) > R) {
        const g = GRASS[(tx + ty) & 1];
        return g[1];
      }
    }
    const d = Math.min(dL, dR, dBot);
    if (dTop <= 1) return '#3b6b31';
    if (dTop <= 3) return '#2a6db0';
    if (d === 0) return '#bfe6ff';
    if (d === 1) return '#5aa6e6';
    const n = vnoise(wx, wy, 9, 5);
    if (hash(wx >> 1, wy, 4) > 0.985) return '#8fd0fb';
    return n > 0.6 ? '#4497de' : '#3b8cd5';
  }

  function spawnColor(c, tx, ty, lx, ly, wx, wy) {
    const pal = c === 'B'
      ? { base: '#5d8fd0', alt: '#6699d8', grout: '#43699e', edge: '#9cc8ff', dark: '#33507a' }
      : { base: '#cf6f66', alt: '#d77a70', grout: '#9e4a46', edge: '#ffb0a6', dark: '#7a3330' };
    const S = (a, b) => at(a, b) === c;
    const dTop = S(tx, ty - 1) ? 99 : ly;
    const dBot = S(tx, ty + 1) ? 99 : T - 1 - ly;
    const dL = S(tx - 1, ty) ? 99 : lx;
    const dR = S(tx + 1, ty) ? 99 : T - 1 - lx;
    const d = Math.min(dTop, dBot, dL, dR);
    if (d === 0) return pal.dark;
    if (d === 1) return pal.edge;
    if (wx % 8 === 0 || wy % 8 === 0) return pal.grout;
    const n = hash(wx >> 3, wy >> 3, 11);
    if ((wx % 8 === 1 || wy % 8 === 1) && hash(wx, wy, 2) > 0.3) return n > 0.5 ? pal.alt : pal.base;
    return n > 0.5 ? pal.alt : pal.base;
  }

  // 2. 草地小裝飾：草叢、小花、小石頭
  const TUFTS = [['x.x', '.x.'], ['x.x.x', '.x.x.'], ['.x.', 'x.x']];
  for (let ty = 0; ty < MAP_H; ty++) {
    for (let tx = 0; tx < MAP_W; tx++) {
      if (at(tx, ty) !== '.') continue;
      const n = Math.floor(hash(tx, ty, 21) * 3);
      for (let i = 0; i < n; i++) {
        const t = TUFTS[Math.floor(hash(tx, ty, 30 + i) * TUFTS.length)];
        const x = tx * T + 1 + Math.floor(hash(tx, ty, 40 + i) * 11);
        const y = ty * T + 1 + Math.floor(hash(tx, ty, 50 + i) * 12);
        P.rows(x + M, y + M, t, { x: '#4a843c' });
        P.set(x + M, y + M - 1, '#7cbd62');
      }
      const f = hash(tx, ty, 60);
      if (f < 0.16) {
        const kind = Math.floor(hash(tx, ty, 61) * 3);
        const pal = [
          { p: '#f6f3e6', c: '#f2c94c' },
          { p: '#f49ab8', c: '#fff0a0' },
          { p: '#f6d860', c: '#e0862a' },
        ][kind];
        const x = tx * T + 2 + Math.floor(hash(tx, ty, 62) * 10);
        const y = ty * T + 2 + Math.floor(hash(tx, ty, 63) * 10);
        P.rows(x + M, y + M, FLOWER, pal);
        P.set(x + 1 + M, y + 3 + M, '#4a843c');
      } else if (f > 0.92) {
        const x = tx * T + 2 + Math.floor(hash(tx, ty, 64) * 11);
        const y = ty * T + 2 + Math.floor(hash(tx, ty, 65) * 11);
        P.rows(x + M, y + M, ['hh.', 'sss'], { h: '#c2bdb0', s: '#8e897d' });
      }
    }
  }

  // 3. 水上的荷葉
  const water = [];
  for (let ty = 0; ty < MAP_H; ty++) {
    for (let tx = 0; tx < MAP_W; tx++) {
      if (at(tx, ty) !== '~') continue;
      water.push({ tx, ty });
      if (hash(tx, ty, 70) < 0.3) {
        const x = tx * T + 4 + Math.floor(hash(tx, ty, 71) * 6);
        const y = ty * T + 5 + Math.floor(hash(tx, ty, 72) * 5);
        P.grid(x + M - 1, y + M - 1, outlineGrid(gridFromRows(LILY, { g: '#5aa848', G: '#7cc65a' }), '#24563a'));
        if (hash(tx, ty, 73) < 0.5) P.rows(x + M + 1, y + M, ['p.', 'pp'], { p: '#f49ab8' });
      }
    }
  }

  // 4. 中央溫泉：圓角池子＋一圈石頭
  let spring = null;
  {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let ty = 0; ty < MAP_H; ty++) {
      for (let tx = 0; tx < MAP_W; tx++) {
        if (at(tx, ty) !== 'h') continue;
        x0 = Math.min(x0, tx * T);
        y0 = Math.min(y0, ty * T);
        x1 = Math.max(x1, tx * T + T);
        y1 = Math.max(y1, ty * T + T);
      }
    }
    if (x0 < x1) {
      const cx = (x0 + x1) / 2;
      const cy = (y0 + y1) / 2;
      const a = (x1 - x0) / 2 - 0.5;
      const b = (y1 - y0) / 2 - 0.5;
      const N = 4;
      const k = (x, y) => (Math.abs((x - cx) / a) ** N + Math.abs((y - cy) / b) ** N) ** (1 / N);
      spring = { x0, y0, x1, y1, cx, cy, a, b, k };
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const kk = k(x + 0.5, y + 0.5);
          if (kk > 1) continue;
          const depth = (1 - kk) * Math.min(a, b);
          let col;
          if (depth < 4) col = '#7f7767';
          else if (depth < 6) col = '#c8f4ec';
          else if (depth < 10) col = '#a6ebe1';
          else if (depth < 18) col = '#86ded3';
          else col = '#6fd2c7';
          if (depth > 6 && hash(x, y, 80) > 0.985) col = '#e6fffb';
          P.set(x + M, y + M, col);
        }
      }
      // 石頭沿著池邊排一圈
      const stones = [];
      let last = null;
      let first = null;
      for (let i = 0; i < 720; i++) {
        const t = (i / 720) * Math.PI * 2;
        const c = Math.cos(t);
        const s = Math.sin(t);
        const px = cx + (a - 2) * Math.sign(c) * Math.abs(c) ** (2 / N);
        const py = cy + (b - 2) * Math.sign(s) * Math.abs(s) ** (2 / N);
        if (last && Math.hypot(px - last[0], py - last[1]) < 5.5) continue;
        if (first && Math.hypot(px - first[0], py - first[1]) < 4.5) continue;
        last = [px, py];
        if (!first) first = last;
        stones.push({ x: px + M, y: py + M, r: 2.6 + hash(i, 3, 81) * 1.1 });
      }
      const SP = new Painter(PW, PH);
      paintBlobs(SP, stones, ['#d6cfbf', '#aea694', '#878070', '#ece6d8'], '#4f483e');
      P.copyFrom(SP, x0 + M - 4, y0 + M - 4, x1 - x0 + 8, y1 - y0 + 8);
    }
  }

  // 5. 牆的影子（光從左上來，影子落在右邊和下面）
  for (let ty = 0; ty < MAP_H; ty++) {
    for (let tx = 0; tx < MAP_W; tx++) {
      if (!isWall(tx, ty)) continue;
      if (!isWall(tx, ty + 1) && ty + 1 < MAP_H) {
        for (let j = 0; j < 3; j++) {
          for (let i = 0; i < T; i++) P.shade(tx * T + i + M, (ty + 1) * T + j + M, j < 2 ? 0.72 : 0.86);
        }
      }
      if (!isWall(tx + 1, ty) && tx + 1 < MAP_W) {
        for (let j = 4; j < T + 2; j++) {
          for (let i = 0; i < 2; i++) P.shade((tx + 1) * T + i + M, ty * T + j + M, i === 0 ? 0.8 : 0.9);
        }
      }
    }
  }

  // 6. 牆：外圍是石牆，裡面的牆是木箱
  const R = WALL_RAISE;
  for (let ty = 0; ty < MAP_H; ty++) {
    for (let tx = 0; tx < MAP_W; tx++) {
      if (!isWall(tx, ty)) continue;
      const border = tx === 0 || ty === 0 || tx === MAP_W - 1 || ty === MAP_H - 1;
      const px = tx * T + M;
      const py = ty * T + M - R;
      const front = !isWall(tx, ty + 1) || ty === MAP_H - 1;
      if (border) {
        paintStoneTop(tx, ty, px, py);
        if (front) paintStoneFront(tx, ty, px, py + T);
      } else {
        P.rows(px, py, CRATE_TOP, CRATE_PAL);
        if (front) P.rows(px, py + T, CRATE_FRONT, CRATE_PAL);
      }
    }
  }

  function paintStoneTop(tx, ty, px, py) {
    const open = (a, b) => !isWall(a, b) && a >= 0 && b >= 0 && a < MAP_W && b < MAP_H;
    for (let j = 0; j < T; j++) {
      for (let i = 0; i < T; i++) {
        const wx = tx * T + i;
        const wy = ty * T + j;
        const row = Math.floor(wy / 8);
        const u = (wx + (row % 2) * 4) % 8;
        const v = wy % 8;
        const sx = Math.floor((wx + (row % 2) * 4) / 8);
        const tint = hash(sx, row, 90);
        let col = tint < 0.33 ? '#9d968a' : tint < 0.66 ? '#a59e91' : '#948d81';
        if (u === 0 || v === 0) col = '#6a645a';
        else if (u === 1 || v === 1) col = '#bbb4a6';
        else if (u === 7 || v === 7) col = '#837d71';
        else if (hash(wx, wy, 91) < 0.05) col = '#6f9a4c';
        if ((j === 0 && open(tx, ty - 1)) || (i === 0 && open(tx - 1, ty)) || (i === T - 1 && open(tx + 1, ty))) col = '#2e2a25';
        P.set(px + i, py + j, col);
      }
    }
  }

  function paintStoneFront(tx, ty, px, py) {
    for (let j = 0; j < R; j++) {
      for (let i = 0; i < T; i++) {
        const wx = tx * T + i;
        const row = Math.floor(j / 3);
        const u = (wx + row * 4) % 8;
        let col = j % 3 === 0 ? '#7d776c' : '#6c665c';
        if (u === 0 || j % 3 === 2) col = '#4c4740';
        if (j === 0) col = '#3e3a34';
        if (j === R - 1) col = '#2e2a25';
        P.set(px + i, py + j, col);
      }
    }
  }

  const ground = P.toCanvas();

  // 牆頂往上凸的部分另外存一張，畫在角色上面
  const lips = makeCanvas(PW, PH);
  const lctx = lips.getContext('2d');
  for (let ty = 0; ty < MAP_H; ty++) {
    for (let tx = 0; tx < MAP_W; tx++) {
      if (!isWall(tx, ty) || (ty > 0 && isWall(tx, ty - 1))) continue;
      const x = tx * T + M;
      const y = ty * T + M - R;
      lctx.drawImage(ground, x, y, T, R, x, y, T, R);
    }
  }

  // 7. 草叢（蓋在角色上面），每格切成一小張，靠近時可以單獨變半透明
  const BP = new Painter(PW, PH);
  const blobs = [];
  const bushTiles = [];
  for (let ty = 0; ty < MAP_H; ty++) {
    for (let tx = 0; tx < MAP_W; tx++) {
      if (at(tx, ty) !== 'b') continue;
      bushTiles.push({ tx, ty });
      for (let j = 0; j < 4; j++) {
        for (let i = 0; i < 4; i++) {
          const jx = (hash(tx * 4 + i, ty * 4 + j, 100) - 0.5) * 1.6;
          const jy = (hash(tx * 4 + i, ty * 4 + j, 101) - 0.5) * 1.6;
          const r = 3.3 + hash(tx * 4 + i, ty * 4 + j, 102) * 1.0;
          blobs.push({ x: tx * T + 2.5 + i * 3.7 + jx + M, y: ty * T - 1 + j * 4.3 + jy + M, r });
        }
      }
    }
  }
  paintBlobs(BP, blobs, ['#64b851', '#469a40', '#337a34', '#8fd46c'], '#1d4a25');
  // 少少的紅色小果子
  for (const { tx, ty } of bushTiles) {
    if (hash(tx, ty, 110) < 0.35) {
      const x = tx * T + 3 + Math.floor(hash(tx, ty, 111) * 9) + M;
      const y = ty * T + 2 + Math.floor(hash(tx, ty, 112) * 8) + M;
      BP.set(x, y, '#e04050');
      BP.set(x + 1, y + 1, '#e04050');
      BP.set(x, y - 1, '#ff8a90');
    }
  }
  const PADB = 6;
  const bushes = bushTiles.map(({ tx, ty }) => {
    const cv = makeCanvas(T + PADB * 2, T + PADB * 2);
    return { tx, ty, x: tx * T - PADB, y: ty * T - PADB, cv, img: cv.getContext('2d').createImageData(T + PADB * 2, T + PADB * 2) };
  });
  const bushGrid = new Array(MAP_W * MAP_H).fill(null);
  for (const b of bushes) bushGrid[b.ty * MAP_W + b.tx] = b;
  const bushAt = (tx, ty) => (tx < 0 || ty < 0 || tx >= MAP_W || ty >= MAP_H ? null : bushGrid[ty * MAP_W + tx]);
  for (let py = 0; py < PH; py++) {
    for (let px = 0; px < PW; px++) {
      const k = (py * PW + px) * 4;
      if (BP.d[k + 3] === 0) continue;
      const wx = px - M;
      const wy = py - M;
      const tx = Math.floor(wx / T);
      const ty = Math.floor(wy / T);
      let owner = bushAt(tx, ty);
      if (!owner) {
        let best = Infinity;
        for (let j = -1; j <= 1; j++) {
          for (let i = -1; i <= 1; i++) {
            const b = bushAt(tx + i, ty + j);
            if (!b) continue;
            const ddx = Math.max(b.tx * T - wx, 0, wx - (b.tx * T + T - 1));
            const ddy = Math.max(b.ty * T - wy, 0, wy - (b.ty * T + T - 1));
            const d = ddx * ddx + ddy * ddy;
            if (d < best) {
              best = d;
              owner = b;
            }
          }
        }
      }
      if (!owner) continue;
      const lx = wx - owner.x;
      const ly = wy - owner.y;
      if (lx < 0 || ly < 0 || lx >= owner.cv.width || ly >= owner.cv.height) continue;
      const o = (ly * owner.cv.width + lx) * 4;
      owner.img.data[o] = BP.d[k];
      owner.img.data[o + 1] = BP.d[k + 1];
      owner.img.data[o + 2] = BP.d[k + 2];
      owner.img.data[o + 3] = 255;
    }
  }
  for (const b of bushes) {
    b.cv.getContext('2d').putImageData(b.img, 0, 0);
    delete b.img;
  }

  return { ground, lips, bushes, water, spring, margin: M };
}

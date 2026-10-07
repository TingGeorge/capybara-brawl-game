import { TILE, PLAYER_HALF, WATER_SPEED, FLAG } from './constants.js';
import { isSolidTile, tileAtPos } from './map.js';

// 方塊（中心 x,y、半徑 half）有沒有碰到牆
export function boxHitsWall(x, y, half = PLAYER_HALF) {
  const x0 = Math.floor((x - half) / TILE);
  const x1 = Math.floor((x + half) / TILE);
  const y0 = Math.floor((y - half) / TILE);
  const y1 = Math.floor((y + half) / TILE);
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      if (isSolidTile(tx, ty)) return true;
    }
  }
  return false;
}

export function pointInWall(x, y) {
  return isSolidTile(Math.floor(x / TILE), Math.floor(y / TILE));
}

// 先動 x 再動 y，撞到牆就貼齊牆面（可以沿著牆滑）
export function moveBox(x, y, dx, dy, half = PLAYER_HALF) {
  if (dx) {
    let nx = x + dx;
    if (boxHitsWall(nx, y, half)) {
      nx = dx > 0
        ? Math.floor((nx + half) / TILE) * TILE - half - 0.01
        : (Math.floor((nx - half) / TILE) + 1) * TILE + half + 0.01;
      if (boxHitsWall(nx, y, half)) nx = x;
    }
    x = nx;
  }
  if (dy) {
    let ny = y + dy;
    if (boxHitsWall(x, ny, half)) {
      ny = dy > 0
        ? Math.floor((ny + half) / TILE) * TILE - half - 0.01
        : (Math.floor((ny - half) / TILE) + 1) * TILE + half + 0.01;
      if (boxHitsWall(x, ny, half)) ny = y;
    }
    y = ny;
  }
  return [x, y];
}

export function lineOfSight(x0, y0, x1, y1) {
  const dist = Math.hypot(x1 - x0, y1 - y0);
  const steps = Math.ceil(dist / 4);
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    if (pointInWall(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t)) return false;
  }
  return true;
}

// 移動速度倍率：伺服器和瀏覽器（預測自己的位置）都用同一個公式
export function moveMultiplier(flags, x, y) {
  if (flags & (FLAG.STUN | FLAG.DASH | FLAG.LEAP)) return 0;
  let mul = 1;
  if (flags & FLAG.SPIN) mul *= 1.25;
  if (flags & FLAG.SHIELD) mul *= 1.15;
  if (tileAtPos(x, y) === '~') mul *= WATER_SPEED;
  return mul;
}

// 走一步。mx、my 是 -1/0/1 的方向鍵輸入
export function stepMove(x, y, mx, my, speed, dt) {
  if (!mx && !my) return [x, y];
  const len = Math.hypot(mx, my);
  return moveBox(x, y, (mx / len) * speed * dt, (my / len) * speed * dt);
}

export function angleDiff(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

import { TILE } from './constants.js';

// 地圖左半邊，右半邊自動左右鏡射（藍隊出生點 B 會變成紅隊出生點 R）。
// #：牆  b：草叢（可以躲）  ~：水（跑比較快）  h：溫泉（會回血）  B：出生點
const LEFT_HALF = [
  '####################',
  '#...................',
  '#..bbbb.............',
  '#..bbbb.....##......',
  '#...........##...bbb',
  '#.....~~~~.......bbb',
  '#.##..~~~~..........',
  '#.##.......###......',
  '#..........#........',
  '#BB.....bb.#....##..',
  '#BB.....bb......##..',
  '#BB...............hh',
  '#BB....###........hh',
  '#BB....###........hh',
  '#BB...............hh',
  '#BB.....bb......##..',
  '#BB.....bb.#....##..',
  '#..........#........',
  '#.##.......###......',
  '#.##..~~~~..........',
  '#.....~~~~.......bbb',
  '#...........##...bbb',
  '#..bbbb.....##......',
  '#..bbbb.............',
  '#...................',
  '####################',
];

export const MAP_ROWS = LEFT_HALF.map(
  (row) => row + [...row].reverse().map((c) => (c === 'B' ? 'R' : c)).join(''),
);
export const MAP_W = MAP_ROWS[0].length;
export const MAP_H = MAP_ROWS.length;
export const WORLD_W = MAP_W * TILE;
export const WORLD_H = MAP_H * TILE;

export function tileAt(tx, ty) {
  if (tx < 0 || ty < 0 || tx >= MAP_W || ty >= MAP_H) return '#';
  return MAP_ROWS[ty][tx];
}

export function tileAtPos(x, y) {
  return tileAt(Math.floor(x / TILE), Math.floor(y / TILE));
}

export function isSolidTile(tx, ty) {
  return tileAt(tx, ty) === '#';
}

// 每隊的出生格（格子中心點）
export const SPAWN_POINTS = { blue: [], red: [] };
for (let ty = 0; ty < MAP_H; ty++) {
  for (let tx = 0; tx < MAP_W; tx++) {
    const c = MAP_ROWS[ty][tx];
    const point = { x: (tx + 0.5) * TILE, y: (ty + 0.5) * TILE };
    if (c === 'B') SPAWN_POINTS.blue.push(point);
    if (c === 'R') SPAWN_POINTS.red.push(point);
  }
}

// 開場時三個位置排好隊站
export function startPoint(team, slot) {
  const x = team === 'blue' ? 2 * TILE : WORLD_W - 2 * TILE;
  const y = WORLD_H / 2 + (slot - 1) * 40;
  return { x, y };
}

export const SPRING_CENTER = { x: WORLD_W / 2, y: WORLD_H / 2 };

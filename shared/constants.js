// 伺服器和瀏覽器共用的遊戲常數。
// 長度單位是「像素」，一格地圖 = 16 像素；時間單位是秒。

export const TILE = 16;
export const TICK_RATE = 60;
export const DT = 1 / TICK_RATE;
export const SNAPSHOT_EVERY = 2; // 每 2 個 tick 送一次畫面狀態（每秒 30 次）

export const PLAYER_HALF = 5.5; // 撞牆用的方塊半徑
export const PLAYER_RADIUS = 7; // 被打中的圓形半徑

export const TEAM_SIZE = 3;
export const MAX_HUMANS = 6;
export const TEAMS = ['blue', 'red'];

export const MATCH_SECONDS = 180;
export const KO_TARGET = 15;
export const COUNTDOWN_SECONDS = 3;
export const RESPAWN_SECONDS = 3;
export const SPAWN_SHIELD_SECONDS = 1.5;
export const RESULT_SECONDS = 8;

export const REGEN_DELAY = 3; // 沒攻擊、沒受傷 3 秒後開始回血
export const REGEN_RATE = 0.12; // 每秒回最大血量的 12%
export const SPRING_HEAL_RATE = 0.1; // 站在地圖中央溫泉每秒回 10%
export const WATER_SPEED = 1.2; // 水豚很會游泳：在水裡跑比較快
export const BUSH_REVEAL_DIST = 36; // 敵人靠這麼近就能看到草叢裡的人
export const REVEAL_AFTER_ATTACK = 1;

export const ROLE_NAMES = { tank: '坦克', melee: '近戰', ranged: '射手' };

// 快照裡每位玩家的狀態旗標
export const FLAG = {
  STUN: 1,
  SHIELD: 2,
  SPIN: 4,
  DASH: 8,
  LEAP: 16,
  PROTECT: 32,
  HIDDEN: 64,
  SEEN_BLUE: 128,
  SEEN_RED: 256,
  MOVING: 512,
};

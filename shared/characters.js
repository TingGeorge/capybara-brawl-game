import { TILE } from './constants.js';

// 10 隻水豚角色。
// 射手：血少、射程長、速度中等；近戰：血多、跑得快；坦克：血最多、速度慢。
//
// 普攻 attack.kind：
//   bullet 直線子彈（count 發、spread 散開角度）
//   lob    拋物線投擲，會飛過牆，落地爆炸
//   melee  近身揮擊（arc 是扇形角度）
// 大招 super.kind：bullet、lob、trap、spin、dash、leap、shield、zone

const T = TILE;

export const CHARACTERS = [
  {
    id: 'carrot',
    name: '蘿蔔丁',
    role: 'ranged',
    weapon: '胡蘿蔔槍',
    desc: '冷靜的神射手，走到哪都抱著心愛的胡蘿蔔槍。',
    hp: 2800,
    speed: 50,
    ammo: 3,
    reload: 1.3,
    cooldown: 0.4,
    attack: {
      kind: 'bullet', damage: 720, count: 1, spread: 0, speed: 240, range: 9 * T, radius: 3, sprite: 'carrot',
      desc: '射出一根直直飛的胡蘿蔔。',
    },
    super: {
      kind: 'bullet', name: '超級大蘿蔔', damage: 1300, count: 1, spread: 0, speed: 260, range: 11 * T, radius: 6,
      pierce: true, sprite: 'bigCarrot', desc: '發射一根巨大胡蘿蔔，會穿過路上所有敵人。',
    },
    superHits: 4,
    look: { hat: 'cap', weapon: 'carrot', fur: 'normal' },
  },
  {
    id: 'yuzu',
    name: '柚柚',
    role: 'ranged',
    weapon: '橘子手榴彈',
    desc: '泡完柚子湯就上戰場，頭上那顆是備用彈藥。',
    hp: 2600,
    speed: 50,
    ammo: 3,
    reload: 1.6,
    cooldown: 0.5,
    attack: {
      kind: 'lob', damage: 950, range: 7 * T, aoe: 18, flight: 0.6, sprite: 'orange',
      desc: '拋出橘子手榴彈，可以越過牆壁，落地爆炸造成範圍傷害。',
    },
    super: {
      kind: 'lob', name: '柚子雨', damage: 800, count: 5, scatter: 26, range: 8 * T, aoe: 18, flight: 0.75,
      sprite: 'orange', desc: '一口氣丟出 5 顆橘子，把一整片區域炸開。',
    },
    superHits: 4,
    look: { hat: 'yuzu', weapon: 'orange', fur: 'light' },
  },
  {
    id: 'melon',
    name: '西瓜籽',
    role: 'ranged',
    weapon: '西瓜籽連發槍',
    desc: '夏天最愛吃西瓜，吃剩的籽全部拿來當子彈。',
    hp: 3000,
    speed: 50,
    ammo: 3,
    reload: 1.4,
    cooldown: 0.35,
    attack: {
      kind: 'bullet', damage: 300, count: 3, spread: 0.24, speed: 220, range: 7.5 * T, radius: 2.5, sprite: 'seed',
      desc: '一次噴出 3 顆西瓜籽，呈扇形散開。',
    },
    super: {
      kind: 'bullet', name: '滾滾大西瓜', damage: 1200, count: 1, spread: 0, speed: 150, range: 14 * T, radius: 7,
      pierce: true, bounce: 3, sprite: 'melon', desc: '滾出一顆大西瓜，會穿過敵人，撞到牆還會反彈。',
    },
    superHits: 4,
    look: { hat: 'melon', weapon: 'melon', fur: 'normal' },
  },
  {
    id: 'corn',
    name: '玉米',
    role: 'ranged',
    weapon: '玉米狙擊槍',
    desc: '躲在草叢裡一動也不動，等待最好的時機。',
    hp: 2400,
    speed: 50,
    ammo: 3,
    reload: 1.9,
    cooldown: 0.6,
    attack: {
      kind: 'bullet', damage: 1150, count: 1, spread: 0, speed: 330, range: 10.5 * T, radius: 2.5, sprite: 'kernel',
      desc: '射程超遠、傷害很高，但是裝填比較慢。',
    },
    super: {
      kind: 'lob', name: '爆米花', damage: 600, count: 1, range: 8 * T, aoe: 16, flight: 0.7, sprite: 'cob',
      split: { count: 10, damage: 350, speed: 160, range: 4 * T, radius: 2.5, sprite: 'popcorn' },
      desc: '丟出一根玉米，落地爆炸後再炸出一圈爆米花。',
    },
    superHits: 3,
    look: { hat: 'straw', weapon: 'corn', fur: 'dark' },
  },
  {
    id: 'banana',
    name: '香蕉武士',
    role: 'melee',
    weapon: '香蕉刀',
    desc: '修練香蕉流劍術多年，刀法又快又準。',
    hp: 4400,
    speed: 58,
    ammo: 3,
    reload: 1.1,
    cooldown: 0.4,
    attack: {
      kind: 'melee', damage: 1050, range: 26, arc: 1.9,
      desc: '用香蕉刀往前方揮出一道弧形斬擊。',
    },
    super: {
      kind: 'trap', name: '香蕉皮陷阱', damage: 500, range: 7 * T, radius: 9, stun: 1.5, life: 12, max: 3,
      desc: '丟出香蕉皮，踩到的敵人會滑倒，暈眩 1.5 秒。',
    },
    superHits: 3,
    look: { hat: 'band', weapon: 'banana', fur: 'normal' },
  },
  {
    id: 'leek',
    name: '蔥劍客',
    role: 'melee',
    weapon: '青蔥長劍',
    desc: '戴著斗笠的流浪劍客，劍上有淡淡的蔥香。',
    hp: 4200,
    speed: 58,
    ammo: 3,
    reload: 1.0,
    cooldown: 0.35,
    attack: {
      kind: 'melee', damage: 900, range: 34, arc: 0.8,
      desc: '往前突刺，攻擊距離比一般近戰更長。',
    },
    super: {
      kind: 'spin', name: '青蔥旋風', damage: 320, duration: 3, interval: 0.25, radius: 26,
      desc: '原地高速旋轉 3 秒，持續傷害周圍敵人，移動也變快。',
    },
    superHits: 3,
    look: { hat: 'kasa', weapon: 'leek', fur: 'light' },
  },
  {
    id: 'pineapple',
    name: '鳳梨拳王',
    role: 'melee',
    weapon: '鳳梨拳套',
    desc: '全場跑最快的水豚，每一拳都很痛。',
    hp: 4000,
    speed: 62,
    ammo: 3,
    reload: 0.9,
    cooldown: 0.28,
    attack: {
      kind: 'melee', damage: 750, range: 22, arc: 1.4,
      desc: '近距離快速出拳，裝填超快。',
    },
    super: {
      kind: 'dash', name: '鳳梨衝刺', damage: 1300, distance: 6 * T, speed: 320, width: 10, knockback: 30,
      desc: '往前猛衝，撞到的敵人會受到重擊並被撞飛。',
    },
    superHits: 4,
    look: { hat: 'crown', weapon: 'fist', fur: 'golden' },
  },
  {
    id: 'pumpkin',
    name: '南瓜騎士',
    role: 'tank',
    weapon: '南瓜盾',
    desc: '戴著南瓜頭盔的騎士，負責擋在隊友前面。',
    hp: 7200,
    speed: 44,
    ammo: 3,
    reload: 1.3,
    cooldown: 0.5,
    attack: {
      kind: 'melee', damage: 1000, range: 28, arc: 2.4, knockback: 16,
      desc: '用南瓜盾大範圍橫掃，把敵人推開。',
    },
    super: {
      kind: 'shield', name: '南瓜堡壘', duration: 4, reduction: 0.6,
      desc: '4 秒內受到的傷害減少 60%，移動也稍微變快。',
    },
    superHits: 3,
    look: { hat: 'pumpkin', weapon: 'shield', fur: 'dark' },
  },
  {
    id: 'coconut',
    name: '椰子大力士',
    role: 'tank',
    weapon: '椰子霰彈砲',
    desc: '力氣超大，可以把整顆椰子捏碎當霰彈。',
    hp: 6600,
    speed: 46,
    ammo: 3,
    reload: 1.5,
    cooldown: 0.5,
    attack: {
      kind: 'bullet', damage: 320, count: 5, spread: 0.6, speed: 210, range: 4 * T, radius: 2.5, sprite: 'shard',
      desc: '近距離噴出 5 片椰殼碎片，貼臉打最痛。',
    },
    super: {
      kind: 'leap', name: '椰子大跳躍', damage: 1500, range: 6 * T, duration: 0.65, aoe: 28, knockback: 30,
      desc: '跳到目標地點砸向地面，造成範圍傷害並把敵人震開。',
    },
    superHits: 3,
    look: { hat: 'coco', weapon: 'coco', fur: 'normal' },
  },
  {
    id: 'onsen',
    name: '泡湯長老',
    role: 'tank',
    weapon: '溫泉木桶',
    desc: '活了很久的老水豚，走到哪都帶著一桶熱溫泉。',
    hp: 6200,
    speed: 44,
    ammo: 3,
    reload: 1.4,
    cooldown: 0.45,
    attack: {
      kind: 'bullet', damage: 330, count: 4, spread: 0.5, speed: 180, range: 4.5 * T, radius: 3, sprite: 'drop',
      desc: '潑出 4 道熱水，短距離扇形攻擊。',
    },
    super: {
      kind: 'zone', name: '露天溫泉', heal: 600, damage: 200, range: 6 * T, radius: 28, duration: 5,
      desc: '在目標地點變出溫泉池 5 秒：隊友泡在裡面快速回血，敵人會被燙到。',
    },
    superHits: 4,
    look: { hat: 'towel', weapon: 'bucket', fur: 'grey' },
  },
];

for (const c of CHARACTERS) {
  const full = c.attack.damage * (c.attack.count || 1);
  c.chargePerDamage = 1 / (full * c.superHits);
  c.attackRange = c.attack.range;
}

export const CHAR_BY_ID = Object.fromEntries(CHARACTERS.map((c) => [c.id, c]));

// 介面預覽：用假資料把每個畫面叫出來（網址參數 ?screen=xxx&nobar=1）
import * as ui from '/js/ui.js';
import { audio } from '/js/audio.js';
import { CHARACTERS, CHAR_BY_ID } from '/shared/characters.js';

// 1) 把正式 index.html 裡的畫布和介面元素搬進來（確保測的是同一份標記）
const html = await (await fetch('/index.html')).text();
const doc = new DOMParser().parseFromString(html, 'text/html');
document.body.prepend(doc.getElementById('game'), doc.getElementById('ui'));

// 2) 假的頭像：16x16 像素的水豚臉，帽子顏色依角色不同
const HAT = {
  carrot: '#ff8a2a', yuzu: '#ffc23d', melon: '#3fbf5a', corn: '#f5d84a', banana: '#ffe066',
  leek: '#7bd36a', pineapple: '#f2b632', pumpkin: '#ff7b1c', coconut: '#8a5a33', onsen: '#e9f1ff',
};
const FUR = { normal: '#a8703f', light: '#c48a52', dark: '#86552c', golden: '#c9944a', grey: '#9a8577' };

function stubPortrait(canvas, charId, scale) {
  const ch = CHAR_BY_ID[charId];
  const s = canvas.width / 16;
  const g = canvas.getContext('2d');
  g.clearRect(0, 0, canvas.width, canvas.height);
  const px = (x, y, w, h, c) => {
    g.fillStyle = c;
    g.fillRect(Math.round(x * s), Math.round(y * s), Math.round(w * s), Math.round(h * s));
  };
  const fur = FUR[(ch && ch.look && ch.look.fur) || 'normal'];
  // 外框
  px(2, 4, 12, 11, '#2a1608');
  px(3, 3, 10, 13, '#2a1608');
  // 身體（棕色圓角方塊）
  px(3, 5, 10, 10, fur);
  px(4, 4, 8, 12, fur);
  // 耳朵
  px(3, 3, 2, 2, '#5b3418');
  px(11, 3, 2, 2, '#5b3418');
  // 帽子
  px(5, 2, 6, 2, HAT[charId] || '#ffd34d');
  px(4, 3, 8, 1, HAT[charId] || '#ffd34d');
  // 眼睛
  px(5, 8, 1, 1, '#120a04');
  px(10, 8, 1, 1, '#120a04');
  // 鼻子
  px(6, 10, 4, 3, '#7a4a24');
  px(7, 11, 1, 1, '#2a1608');
  px(8, 11, 1, 1, '#2a1608');
  // 腮紅
  px(4, 10, 1, 1, '#e98a7a');
  px(11, 10, 1, 1, '#e98a7a');
}

// 3) 背景假地圖，讓 HUD 看起來像在遊戲裡
function paintFakeMap() {
  const c = document.getElementById('game');
  const T = 16;
  const cols = 40;
  const rows = 26;
  c.width = cols * T;
  c.height = rows * T;
  const g = c.getContext('2d');
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const edge = x === 0 || y === 0 || x === cols - 1 || y === rows - 1;
      const wall = edge || ((x === 12 || x === 27) && y > 7 && y < 12) || (y === 18 && x > 16 && x < 23);
      const water = x > 5 && x < 10 && y > 4 && y < 7;
      const bush = (x > 2 && x < 7 && y > 19 && y < 23) || (x > 32 && x < 37 && y > 2 && y < 6);
      g.fillStyle = wall ? '#5a4a6e' : water ? '#3d8ccf' : bush ? '#2f8a3d' : (x + y) % 2 ? '#5fae4e' : '#58a447';
      g.fillRect(x * T, y * T, T, T);
      if (wall) {
        g.fillStyle = '#7a6890';
        g.fillRect(x * T, y * T, T, 4);
      }
    }
  }
  const pc = document.createElement('canvas');
  pc.width = pc.height = 16;
  const spots = [['carrot', 8, 12], ['pumpkin', 14, 15], ['banana', 25, 13], ['coconut', 30, 8], ['onsen', 18, 6]];
  for (const [id, x, y] of spots) {
    drawPortrait(pc, id, 1);
    g.drawImage(pc, x * T, y * T);
  }
}

// 有正式的 sprites.js 就用正式頭像（?stub=1 強制用假的）
const params0 = new URLSearchParams(location.search);
let drawPortrait = stubPortrait;
if (!params0.has('stub')) {
  try {
    drawPortrait = (await import('/js/sprites.js')).drawPortrait || stubPortrait;
  } catch (err) {
    console.info('sprites.js 還不能用，改用假頭像', err.message);
  }
}
ui.initUI({ drawPortrait });
paintFakeMap();
window.__ui = ui;
window.__audio = audio;

// ---------- 假資料 ----------
const URLS = ['http://192.168.1.23:3000', 'http://10.0.0.5:3000'];
const LOBBY_PLAYERS = [
  { id: 'p1', name: '康康', team: 'blue', charId: 'carrot' },
  { id: 'p2', name: '小美', team: 'blue', charId: 'pumpkin' },
  { id: 'p3', name: '阿凱超級無敵強', team: 'red', charId: 'banana' },
  { id: 'p4', name: '肥肥', team: 'red', charId: 'carrot' },
];
const handlers = {
  onPick: (id) => {
    console.log('onPick', id);
    const me = lobbyState.players.find((p) => p.id === lobbyMe);
    if (me) me.charId = id;
    setTimeout(() => ui.showLobby(lobbyState, lobbyMe, handlers), 60);
  },
  onTeam: (team) => {
    console.log('onTeam', team);
    const me = lobbyState.players.find((p) => p.id === lobbyMe);
    if (me) me.team = team;
    ui.showLobby(lobbyState, lobbyMe, handlers);
  },
  onBots: (v) => {
    console.log('onBots', v);
    lobbyState.bots = v;
    ui.showLobby(lobbyState, lobbyMe, handlers);
  },
  onStart: () => {
    console.log('onStart');
    ui.showToast('兩隊都至少要有一隻水豚。可以打開「電腦補位」或請朋友換隊。');
  },
};
let lobbyState = null;
let lobbyMe = null;

const GAME_PLAYERS = [
  { id: 'p1', name: '康康', team: 'blue', charId: 'carrot', isBot: false },
  { id: 'p2', name: '小美', team: 'blue', charId: 'pumpkin', isBot: false },
  { id: 'b1', name: '麻糬（電腦）', team: 'blue', charId: 'onsen', isBot: true },
  { id: 'p3', name: '阿凱超級無敵強', team: 'red', charId: 'banana', isBot: false },
  { id: 'p4', name: '肥肥', team: 'red', charId: 'coconut', isBot: false },
  { id: 'b2', name: '布丁（電腦）', team: 'red', charId: 'yuzu', isBot: true },
];
const STATS = {
  p1: [5, 2, 6120], p2: [2, 3, 4380], b1: [1, 4, 2950],
  p3: [4, 3, 5870], p4: [3, 2, 7310], b2: [0, 5, 1820],
};
const byId = (id) => GAME_PLAYERS.find((p) => p.id === id);

let hudState = null;
function loop() {
  if (hudState) ui.updateHUD(hudState);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

function baseHud(extra) {
  return {
    phase: 'playing', clock: 83.4, score: [4, 6], myTeam: 'blue', superCharge: 0.62,
    superName: CHAR_BY_ID.carrot.super.name, alive: true, respawnIn: 0, ping: 23, spectator: false, ...extra,
  };
}

function startGame(spectator = false) {
  paintFakeMap();
  ui.showGame({ players: GAME_PLAYERS, koTarget: 10, duration: 150, spectator }, spectator ? 'p9' : 'p1');
}

function feed() {
  ui.addKillFeed(byId('p3'), byId('b1'));
  ui.addKillFeed(byId('p4'), byId('p2'));
  ui.addKillFeed(null, byId('b2'));
  ui.addKillFeed(byId('p1'), byId('p3'));
}

function scoreRows() {
  return GAME_PLAYERS.map((p) => ({
    name: p.name, team: p.team, charId: p.charId, kills: STATS[p.id][0], deaths: STATS[p.id][1], isMe: p.id === 'p1',
  }));
}

function result(winner, me = 'p1') {
  ui.showResult(
    {
      winner,
      score: winner === 'blue' ? [10, 7] : winner === 'red' ? [6, 10] : [8, 8],
      players: GAME_PLAYERS.map((p) => ({ ...p, kills: STATS[p.id][0], deaths: STATS[p.id][1], damage: STATS[p.id][2] })),
    },
    me,
  );
}

const SCENES = {
  join: () => ui.showJoin({ defaultName: '水豚7號', onJoin: (n) => ui.setJoinError(n ? '' : '名字不能空白喔') }),
  'join-error': () => {
    ui.showJoin({ defaultName: '康康', onJoin: () => {} });
    ui.setJoinError('房間已經滿了（最多 6 個人）');
  },
  'lobby-host': () => {
    lobbyState = { phase: 'lobby', hostId: 'p1', bots: true, urls: URLS, players: structuredClone(LOBBY_PLAYERS) };
    lobbyMe = 'p1';
    ui.showLobby(lobbyState, lobbyMe, handlers);
  },
  'lobby-guest': () => {
    lobbyState = { phase: 'lobby', hostId: 'p1', bots: false, urls: URLS.slice(0, 1), players: structuredClone(LOBBY_PLAYERS) };
    lobbyMe = 'p3';
    ui.showLobby(lobbyState, lobbyMe, handlers);
  },
  'lobby-match': () => {
    const players = [...structuredClone(LOBBY_PLAYERS), { id: 'p5', name: '遲到的阿明', team: 'blue', charId: 'leek' }];
    lobbyState = { phase: 'match', hostId: 'p1', bots: true, urls: [], players };
    lobbyMe = 'p5';
    ui.showLobby(lobbyState, lobbyMe, handlers);
  },
  'lobby-full': () => {
    const players = [
      ...structuredClone(LOBBY_PLAYERS),
      { id: 'p5', name: 'Abcdefghij', team: 'blue', charId: 'pineapple' },
      { id: 'p6', name: '小白', team: 'red', charId: 'corn' },
    ];
    lobbyState = { phase: 'lobby', hostId: 'p2', bots: true, urls: URLS, players };
    lobbyMe = 'p5';
    ui.showLobby(lobbyState, lobbyMe, handlers);
  },
  'hud-countdown': () => {
    startGame();
    hudState = baseHud({ phase: 'countdown', clock: 2.4, score: [0, 0], superCharge: 0 });
  },
  'hud-go': () => {
    startGame();
    hudState = baseHud({ phase: 'countdown', clock: 0.3, score: [0, 0], superCharge: 0 });
    setTimeout(() => (hudState = baseHud({ phase: 'playing', clock: 150, score: [0, 0], superCharge: 0 })), 150);
  },
  'hud-playing': () => {
    startGame();
    hudState = baseHud();
    feed();
  },
  'hud-dead': () => {
    startGame();
    hudState = baseHud({ alive: false, respawnIn: 2.3, superCharge: 0.35, ping: 140 });
    feed();
  },
  'hud-full': () => {
    startGame();
    hudState = baseHud({ superCharge: 1, clock: 8.2, score: [9, 8], ping: 310 });
    ui.addKillFeed(byId('p1'), byId('p4'));
  },
  'hud-spectator': () => {
    startGame(true);
    hudState = baseHud({ spectator: true, myTeam: null, alive: false, ping: null });
    feed();
  },
  scoreboard: () => {
    startGame();
    hudState = baseHud();
    ui.setScoreboard(true, scoreRows());
  },
  'result-win': () => {
    startGame();
    result('blue');
  },
  'result-lose': () => {
    startGame();
    result('red');
  },
  'result-draw': () => {
    startGame();
    result('draw');
  },
  disconnected: () => ui.showDisconnected(() => setTimeout(() => ui.showDisconnected(() => {}), 1200)),
  toast: () => {
    SCENES['lobby-host']();
    ui.showToast('兩隊都至少要有一隻水豚。可以打開「電腦補位」或請朋友換隊。');
    ui.showToast('已複製網址：http://192.168.1.23:3000');
  },
  // 一整場的快轉示範
  demo: () => {
    startGame();
    let t = 0;
    hudState = baseHud({ phase: 'countdown', clock: 3, score: [0, 0], superCharge: 0 });
    const timer = setInterval(() => {
      t += 0.1;
      if (t < 3) hudState = { ...hudState, phase: 'countdown', clock: 3 - t };
      else {
        const k = Math.floor((t - 3) / 2);
        hudState = {
          ...hudState, phase: 'playing', clock: 150 - (t - 3) * 10, score: [Math.floor(k / 2), Math.ceil(k / 2)],
          superCharge: Math.min(1, ((t - 3) % 8) / 6), alive: ((t - 3) % 10) < 7, respawnIn: 3 - (((t - 3) % 10) - 7),
        };
        if (Math.abs(((t - 3) % 2)) < 0.1) ui.addKillFeed(GAME_PLAYERS[k % 6], GAME_PLAYERS[(k + 3) % 6]);
      }
      if (t > 25) clearInterval(timer);
    }, 100);
  },
};

function run(name) {
  hudState = null;
  ui.setScoreboard(false, []);
  (SCENES[name] || SCENES.join)();
}

// ---------- 工具列 ----------
const params = new URLSearchParams(location.search);
const bar = document.getElementById('devbar');
if (params.has('nobar')) bar.remove();
else {
  const add = (label, fn) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.addEventListener('click', fn);
    bar.append(b);
  };
  const title = (t) => {
    const b = document.createElement('b');
    b.textContent = t;
    bar.append(b);
  };
  bar.querySelector('.toggle').addEventListener('click', () => bar.classList.toggle('min'));
  title('畫面');
  for (const name of Object.keys(SCENES)) add(name, () => run(name));
  add('+擊倒訊息', () => ui.addKillFeed(byId('p1'), GAME_PLAYERS[Math.floor(Math.random() * 6)]));
  add('Tab 計分板', () => ui.setScoreboard(document.getElementById('scoreboard').hidden, scoreRows()));
  title('音效（先點一下解鎖）');
  for (const name of ['shoot', 'throw', 'slash', 'punch', 'hit', 'hurt', 'boom', 'ko', 'super', 'superReady', 'heal',
    'slip', 'spawn', 'countdown', 'go', 'win', 'lose', 'click', 'splash', 'bonk']) {
    add(name, () => {
      audio.unlock();
      audio.play(name, { pan: name === 'boom' ? -0.6 : 0 });
    });
  }
  add('靜音切換', () => ui.showToast(audio.toggleMute() ? '已靜音' : '已開啟聲音'));
}
addEventListener('pointerdown', () => audio.unlock(), { once: true });
addEventListener('keydown', (e) => {
  if (e.key === 'Tab') {
    e.preventDefault();
    ui.setScoreboard(true, scoreRows());
  }
});
addEventListener('keyup', (e) => {
  if (e.key === 'Tab') ui.setScoreboard(false, []);
});

run(params.get('screen') || 'join');
window.__ready = true;

// 進入點：把連線、畫面（ui.js）、繪圖（renderer.js）、音效和對戰邏輯串起來。
// 兩種玩法用同一套流程：連線對戰（net.js，連到房主的伺服器）、單人對戰（local-net.js，整場在瀏覽器裡跑）。
import {
  initUI, showJoin, setJoinError, showLobby, showToast, showGame, updateHUD, addKillFeed, setScoreboard,
  showResult, showDisconnected, setHudHandlers, setTouchMode,
} from './ui.js';
import { audio } from './audio.js';
import { Renderer } from './renderer.js';
import { drawPortrait } from './sprites.js';
import { Net } from './net.js';
import { LocalNet } from './local-net.js';
import { LAN_SERVER } from './config.js';
import { Input } from './input.js';
import { TouchControls } from './touch.js';
import { ClientGame } from './client-game.js';
import { CHARACTERS } from '../shared/characters.js';
import { WORLD_W, WORLD_H, tileAtPos } from '../shared/map.js';
import { stepMove } from '../shared/physics.js';

const canvas = document.getElementById('game');
const renderer = new Renderer(canvas);
const input = new Input(canvas);
new TouchControls(input, {
  zone: document.getElementById('touch-zone'),
  stick: document.getElementById('touch-stick'),
  attack: document.getElementById('touch-attack'),
  superBtn: document.getElementById('hud-super'),
});
const lanNet = new Net();
const soloNet = new LocalNet();
const ui = { updateHUD, addKillFeed, setScoreboard };

let net = null; // 目前用的連線：lanNet 或 soloNet
let myId = null;
let game = null;
let lobby = null;
let ping = null;
let joined = false;

function storage(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch {
    return null;
  }
  return null;
}

addEventListener('resize', () => renderer.resize());
input.onMute = () => {
  const muted = audio.toggleMute();
  const how = input.mode === 'touch' ? '再按一次開啟聲音' : '按 M 開啟聲音';
  showToast(muted ? `已靜音（${how}）` : '聲音已開啟');
};
setTouchMode(input.mode === 'touch');
input.onModeChange = (mode) => setTouchMode(mode === 'touch');
// iPhone 要在手指放開（touchend / click）時才能開啟聲音
const unlock = () => audio.unlock();
for (const type of ['pointerdown', 'touchend', 'click', 'keydown']) addEventListener(type, unlock);

// 擋掉 iPhone 的雙指縮放（Safari 不理會 viewport 的 user-scalable=no；雙擊放大由 CSS 的 touch-action 擋）
for (const type of ['gesturestart', 'gesturechange']) document.addEventListener(type, (e) => e.preventDefault());

// 手機瀏覽器：進遊戲時切成全螢幕、鎖定橫向（不支援就算了，已安裝成 App 時本來就是全螢幕）
async function enterFullscreen() {
  if (input.mode !== 'touch' || document.fullscreenElement || !document.fullscreenEnabled) return;
  if (matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches) return;
  try {
    await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
    await screen.orientation.lock('landscape');
  } catch {
    // 有些瀏覽器（例如 iPhone 的 Safari）不能全螢幕或鎖方向
  }
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else enterFullscreen();
}

// ---------- 大廳 ----------

const lobbyHandlers = {
  onLeave() {
    leave();
    audio.play('click');
  },
  onFullscreen: toggleFullscreen,
  onPick(charId) {
    storage('capybrawl.char', charId);
    net.send({ t: 'pick', charId });
    audio.play('click');
  },
  onTeam(team) {
    net.send({ t: 'team', team });
    audio.play('click');
  },
  onBots(v) {
    net.send({ t: 'bots', v });
  },
  onStart() {
    net.send({ t: 'start' });
    audio.play('click');
  },
};

setHudHandlers({
  onScoreboard() {
    input.tab = !input.tab;
  },
  onMute() {
    input.onMute();
  },
  onLeave: () => leave(),
});

// 自己離開（大廳的「離開」、單人對戰中的「離開」）：關掉連線，回到開頭畫面
function leave() {
  const n = net;
  net = null;
  joined = false;
  game = null;
  lobby = null;
  input.setEnabled(false);
  if (n) n.close();
  showTitle();
}

function enterLobby() {
  if (game) {
    game = null;
    input.setEnabled(false);
  }
  if (lobby) showLobby(lobby, myId, lobbyHandlers);
}

// 兩種連線收到的訊息都用同一套處理；n 不是目前用的連線就不理（例如剛離開的單人模式）
function wire(n) {
  const on = (type, fn) => n.on(type, (m) => n === net && fn(m));
  on('welcome', (m) => {
    myId = m.id;
    joined = true;
  });

  on('lobby', (m) => {
    lobby = m;
    // 對戰還沒結束（包含看結算畫面的時候）就先不切回大廳
    if (game && m.phase === 'match') return;
    enterLobby();
  });

  on('start', (m) => {
    game = new ClientGame({ info: m, myId, net, input, renderer, audio, ui });
    game.ping = ping;
    showGame(m, myId, { solo: net === soloNet });
    if (input.mode === 'touch' && !m.spectator && innerHeight > innerWidth) showToast('把手機轉成橫的，畫面更大更好玩！');
    input.setEnabled(!m.spectator);
  });

  on('s', (m) => {
    if (game) game.onSnapshot(m);
  });

  on('result', (m) => {
    if (!game) return;
    game.ended = true;
    input.setEnabled(false);
    showResult(m, myId);
    const me = m.players.find((p) => p.id === myId);
    if (me && m.winner !== 'draw') audio.play(me.team === m.winner ? 'win' : 'lose');
  });

  on('error', (m) => {
    if (!joined) setJoinError(m.msg);
    else showToast(m.msg);
  });

  on('pong', (m) => {
    ping = Math.round(performance.now() - m.c);
    if (game) game.ping = ping;
  });

  n.onclose = () => {
    // 還沒進大廳就被斷線（例如房間滿了）：留在開頭畫面，讓剛剛的錯誤訊息繼續顯示
    if (n !== net || !joined) return;
    game = null;
    input.setEnabled(false);
    showDisconnected(() => location.reload());
  };
}
wire(lanNet);
wire(soloNet);

setInterval(() => net && net.send({ t: 'ping', c: performance.now() }), 2000);

// ---------- 開頭畫面 ----------

async function join(n, name) {
  setJoinError('');
  audio.unlock();
  audio.play('click');
  storage('capybrawl.name', name);
  enterFullscreen();
  if (net && net !== n) net.close();
  net = n;
  try {
    if (!n.connected) await n.connect();
  } catch {
    if (net === n) net = null;
    setJoinError('連不上伺服器，請確認房主的伺服器還開著，網址也打對了。也可以先玩單人對戰！');
    return;
  }
  n.send({ t: 'hello', name, charId: storage('capybrawl.char') || undefined });
}

function showTitle() {
  showJoin({
    defaultName: storage('capybrawl.name') || '',
    lan: LAN_SERVER,
    onJoin: (name) => join(lanNet, name),
    onSolo: (name) => join(soloNet, name),
  });
}

initUI({ drawPortrait });
showTitle();

// 離線也能開（PWA）：只有 https 或 localhost 才能註冊 service worker，區域網路的 http 網址會自動略過
if ('serviceWorker' in navigator && window.isSecureContext) {
  addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

// ---------- 大廳背景：一群水豚在地圖上散步 ----------

const strollers = CHARACTERS.slice(0, 7).map((c, i) => ({
  id: `npc${i}`,
  charId: c.id,
  team: i % 2 ? 'red' : 'blue',
  x: WORLD_W / 2 + (Math.random() - 0.5) * 200,
  y: WORLD_H / 2 + (Math.random() - 0.5) * 120,
  dir: Math.random() * Math.PI * 2,
  rest: Math.random() * 2,
}));

function attractState(now) {
  const t = now / 1000;
  for (const s of strollers) {
    s.rest -= 1 / 60;
    if (s.rest < -2 - Math.random() * 2) {
      s.rest = 1 + Math.random() * 2;
      s.dir = Math.random() * Math.PI * 2;
    }
    s.moving = s.rest < 0;
    if (s.moving) {
      const [nx, ny] = stepMove(s.x, s.y, Math.cos(s.dir), Math.sin(s.dir), 30, 1 / 60);
      if (nx === s.x && ny === s.y) s.dir += Math.PI / 2;
      s.x = nx;
      s.y = ny;
    }
  }
  return {
    now: t,
    camera: { x: WORLD_W / 2 + Math.sin(t * 0.07) * 140, y: WORLD_H / 2 + Math.cos(t * 0.05) * 60 },
    myId: null,
    myTeam: null,
    players: strollers.map((s) => ({
      id: s.id, name: '', team: s.team, charId: s.charId, x: s.x, y: s.y, z: 0,
      aim: Math.cos(s.dir) >= 0 ? 0 : Math.PI, hp: 1, maxHp: 1, alive: true, isMe: false, isAlly: false,
      flags: 0, moving: s.moving, ammo: 0, maxAmmo: 0, superCharge: 0, ambient: true,
      inSpring: tileAtPos(s.x, s.y) === 'h',
    })),
    projectiles: [],
    zones: [],
    aim: null,
  };
}

function loop(now) {
  requestAnimationFrame(loop);
  try {
    if (game) game.frame(now);
    else renderer.render(attractState(now));
  } catch (err) {
    console.error(err);
  }
}
requestAnimationFrame(loop);

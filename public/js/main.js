// 進入點：把連線、畫面（ui.js）、繪圖（renderer.js）、音效和對戰邏輯串起來。
import {
  initUI, showJoin, setJoinError, showLobby, showToast, showGame, updateHUD, addKillFeed, setScoreboard,
  showResult, showDisconnected,
} from './ui.js';
import { audio } from './audio.js';
import { Renderer } from './renderer.js';
import { drawPortrait } from './sprites.js';
import { Net } from './net.js';
import { Input } from './input.js';
import { ClientGame } from './client-game.js';
import { CHARACTERS } from '/shared/characters.js';
import { WORLD_W, WORLD_H, tileAtPos } from '/shared/map.js';
import { stepMove } from '/shared/physics.js';

const canvas = document.getElementById('game');
const renderer = new Renderer(canvas);
const input = new Input(canvas);
const net = new Net();
const ui = { updateHUD, addKillFeed, setScoreboard };

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
  showToast(muted ? '已靜音（按 M 開啟聲音）' : '聲音已開啟');
};
const unlock = () => audio.unlock();
addEventListener('pointerdown', unlock);
addEventListener('keydown', unlock);

// ---------- 大廳 ----------

const lobbyHandlers = {
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

function enterLobby() {
  if (game) {
    game = null;
    input.setEnabled(false);
  }
  if (lobby) showLobby(lobby, myId, lobbyHandlers);
}

net.on('welcome', (m) => {
  myId = m.id;
  joined = true;
});

net.on('lobby', (m) => {
  lobby = m;
  // 對戰還沒結束（包含看結算畫面的時候）就先不切回大廳
  if (game && m.phase === 'match') return;
  enterLobby();
});

net.on('start', (m) => {
  game = new ClientGame({ info: m, myId, net, input, renderer, audio, ui });
  game.ping = ping;
  showGame(m, myId);
  input.setEnabled(!m.spectator);
});

net.on('s', (m) => {
  if (game) game.onSnapshot(m);
});

net.on('result', (m) => {
  if (!game) return;
  game.ended = true;
  input.setEnabled(false);
  showResult(m, myId);
  const me = m.players.find((p) => p.id === myId);
  if (me && m.winner !== 'draw') audio.play(me.team === m.winner ? 'win' : 'lose');
});

net.on('error', (m) => {
  if (!joined) setJoinError(m.msg);
  else showToast(m.msg);
});

net.on('pong', (m) => {
  ping = Math.round(performance.now() - m.c);
  if (game) game.ping = ping;
});

net.onclose = () => {
  game = null;
  input.setEnabled(false);
  showDisconnected(() => location.reload());
};

setInterval(() => net.send({ t: 'ping', c: performance.now() }), 2000);

// ---------- 開頭畫面 ----------

initUI({ drawPortrait });
showJoin({
  defaultName: storage('capybrawl.name') || '',
  async onJoin(name) {
    setJoinError('');
    audio.unlock();
    audio.play('click');
    storage('capybrawl.name', name);
    try {
      if (!net.ws || net.ws.readyState > 1) await net.connect();
    } catch {
      setJoinError('連不上伺服器，請確認房主的伺服器還開著，網址也打對了。');
      return;
    }
    net.send({ t: 'hello', name, charId: storage('capybrawl.char') || undefined });
  },
});

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

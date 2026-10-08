// 水豚大亂鬥：所有 HTML 介面（標題、大廳、HUD、計分板、結算、斷線、提示訊息）
import { CHARACTERS, CHAR_BY_ID } from '../shared/characters.js';
import { ROLE_NAMES, TEAM_SIZE, MAX_HUMANS, TILE } from '../shared/constants.js';
import { audio } from './audio.js';

const PORTRAIT_BASE = 16; // 頭像 canvas 預設邊長 = 16 × scale（drawPortrait 也可以自己改尺寸）
const TEAM_NAMES = { blue: '藍隊', red: '紅隊' };
const TEAMS = ['blue', 'red'];
const JOIN_LINEUP = ['pineapple', 'yuzu', 'carrot', 'pumpkin', 'banana'];
const KILLFEED_MAX = 5;
const KILLFEED_MS = 5000;
const TOAST_MS = 3000;

const HELP = [
  [['WASD'], '移動'],
  [['滑鼠'], '瞄準'],
  [['左鍵'], '攻擊（按住連發）'],
  [['右鍵', 'E', '空白鍵'], '放大招'],
  [['Tab'], '計分板'],
  [['M'], '靜音'],
];
const TOUCH_HELP = [
  [['左半邊'], '拖曳移動'],
  [['攻擊鈕'], '拖曳瞄準、放開發射，點一下自動瞄準'],
  [['大招鈕'], '集滿後一樣用法'],
];
const LEAVE_CONFIRM_MS = 3000;

// 角色能力值（長條以全部角色的最大值為 100%）
const dmgOf = (c) => c.attack.damage * (c.attack.count || 1);
const speedWord = (v) => (v >= 60 ? '很快' : v >= 55 ? '快' : v >= 48 ? '普通' : '慢');
const STATS = [
  { label: '血量', color: '#6ee36b', get: (c) => c.hp, fmt: (c) => String(c.hp) },
  { label: '速度', color: '#4fd6e8', get: (c) => c.speed, fmt: (c) => speedWord(c.speed) },
  {
    label: '射程',
    color: '#c084fc',
    get: (c) => c.attack.range,
    fmt: (c) => (c.attack.kind === 'melee' ? '近身' : `${+(c.attack.range / TILE).toFixed(1)} 格`),
  },
  {
    label: '傷害',
    color: '#ff9a3d',
    get: dmgOf,
    fmt: (c) => ((c.attack.count || 1) > 1 ? `${c.attack.damage}×${c.attack.count}` : String(c.attack.damage)),
  },
];
const STAT_MAX = STATS.map((s) => Math.max(...CHARACTERS.map(s.get)));

let drawPortraitFn = null;
let warnedPortrait = false;
let inited = false;
let E = {}; // 常用 DOM 節點
let screen = null; // 目前顯示的畫面 id

// 標題畫面
let joinCb = null;
let soloCb = null;
let lanAvailable = true;
// 大廳
let lobbyHandlers = {};
let lobbyMyId = null;
let lobbyMyTeam = null;
let gridBuilt = false;
const cards = new Map();
let detailId = undefined;
let urlsKey = null;
// 對戰
let game = null;
let hc = {}; // HUD 快取：值沒變就不碰 DOM
let centerTimer = 0;
let sbKey = null;
let hudHandlers = {};
let leaveArmed = 0;
// 斷線
let reconnectCb = null;
let reconnectTimer = 0;

const $ = (id) => document.getElementById(id);

function h(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// 畫一張角色頭像（失敗也不能讓介面壞掉）
function portrait(charId, scale = 3) {
  const c = document.createElement('canvas');
  c.className = 'portrait';
  c.width = c.height = PORTRAIT_BASE * scale;
  if (drawPortraitFn && charId) {
    try {
      drawPortraitFn(c, charId, scale);
    } catch (err) {
      if (!warnedPortrait) console.warn('drawPortrait 失敗：', err);
      warnedPortrait = true;
    }
  }
  return c;
}

function portraitBox(charId, scale, cls = '') {
  const box = h('div', `pf ${cls}`.trim());
  box.append(portrait(charId, scale));
  return box;
}

function roleBadge(role) {
  return h('span', `role role-${role}`, ROLE_NAMES[role] || role);
}

function charName(charId) {
  return CHAR_BY_ID[charId] ? CHAR_BY_ID[charId].name : '？？？';
}

function setScreen(id) {
  screen = id;
  for (const s of ['screen-join', 'screen-lobby', 'hud', 'screen-result', 'screen-disconnected']) {
    const node = $(s);
    if (node) node.hidden = s !== id;
  }
  document.body.dataset.screen = id;
}

function restartAnim(node, cls) {
  node.classList.remove(cls);
  void node.offsetWidth; // 重新觸發 CSS 動畫
  node.classList.add(cls);
}

function ensureInit() {
  if (!inited) initUI({});
}

// ---------- 初始化 ----------

export function initUI({ drawPortrait } = {}) {
  if (typeof drawPortrait === 'function') drawPortraitFn = drawPortrait;
  if (inited) return;
  inited = true;

  E = {
    ui: $('ui'),
    joinForm: $('join-form'),
    joinName: $('join-name'),
    joinBtn: $('join-btn'),
    joinError: $('join-error'),
    joinPortraits: $('join-portraits'),
    soloBtn: $('solo-btn'),
    joinHint: $('join-hint'),
    leave: $('btn-leave'),
    fullscreen: $('btn-fullscreen'),
    shareTitle: $('share-title'),
    banner: $('lobby-banner'),
    count: $('lobby-count'),
    grid: $('char-grid'),
    detail: $('char-detail'),
    btnBlue: $('btn-team-blue'),
    btnRed: $('btn-team-red'),
    botsCheck: $('bots-check'),
    botsLabel: $('bots-label'),
    start: $('btn-start'),
    waitHost: $('wait-host'),
    urls: $('share-urls'),
    help: $('controls-help'),
    scoreBlue: $('hud-score-blue'),
    scoreRed: $('hud-score-red'),
    mineBlue: $('hud-mine-blue'),
    mineRed: $('hud-mine-red'),
    teamBlue: $('hud-team-blue'),
    teamRed: $('hud-team-red'),
    clock: $('hud-clock'),
    goal: $('hud-goal'),
    spectator: $('hud-spectator'),
    ping: $('hud-ping'),
    pingText: $('hud-ping-text'),
    muted: $('hud-muted'),
    hudScore: $('hud-btn-score'),
    hudMute: $('hud-btn-mute'),
    hudLeave: $('hud-btn-leave'),
    touchUi: $('touch-ui'),
    killfeed: $('killfeed'),
    dead: $('hud-dead'),
    respawn: $('hud-respawn'),
    countdown: $('hud-countdown'),
    superBtn: $('hud-super'),
    superName: $('hud-super-name'),
    superPct: $('hud-super-pct'),
    scoreboard: $('scoreboard'),
    result: $('screen-result'),
    resultTitle: $('result-title'),
    resultSub: $('result-sub'),
    resultScore: $('result-score'),
    resultTables: $('result-tables'),
    reconnect: $('btn-reconnect'),
    toasts: $('toasts'),
  };
  if (!E.ui) {
    console.error('找不到 #ui，請確認 index.html 有介面元素');
    return;
  }

  // 標題畫面：按 Enter 或按鈕送出（按 Enter 時 submitter 是第一顆按鈕）
  E.joinForm.addEventListener('submit', (e) => {
    e.preventDefault();
    audio.unlock();
    if (E.joinBtn.disabled) return;
    E.joinBtn.disabled = E.soloBtn.disabled = true;
    setTimeout(() => (E.joinBtn.disabled = E.soloBtn.disabled = false), 700);
    const solo = !lanAvailable || e.submitter === E.soloBtn;
    const cb = solo ? soloCb : joinCb;
    if (cb) cb(E.joinName.value.trim());
  });
  // 打字時不要觸發遊戲快捷鍵（M 靜音、WASD…）；按鍵擋掉了，所以這裡自己解鎖音效
  E.joinName.addEventListener('keydown', (e) => {
    e.stopPropagation();
    audio.unlock();
  });
  E.joinName.addEventListener('keyup', (e) => e.stopPropagation());

  // 大廳按鈕
  E.leave.addEventListener('click', () => callLobby('onLeave'));
  E.fullscreen.addEventListener('click', () => callLobby('onFullscreen'));
  document.addEventListener('fullscreenchange', updateFullscreenBtn);
  E.btnBlue.addEventListener('click', () => callLobby('onTeam', 'blue'));
  E.btnRed.addEventListener('click', () => callLobby('onTeam', 'red'));
  E.botsCheck.addEventListener('change', () => {
    if (E.botsLabel.classList.contains('readonly')) return;
    callLobby('onBots', E.botsCheck.checked);
  });
  E.start.addEventListener('click', () => callLobby('onStart'));

  // 操作說明（電腦和手機各一份，CSS 依照現在用滑鼠還是手指決定顯示哪一份）
  for (const [list, cls] of [[HELP, 'mouse-only'], [TOUCH_HELP, 'touch-only']]) {
    const box = h('span', `help-set ${cls}`);
    for (let i = 0; i < list.length; i++) {
      const [keys, what] = list[i];
      if (i) box.append(h('span', 'sep', '·'));
      keys.forEach((k, j) => {
        if (j) box.append(h('span', 'slash', '/'));
        box.append(h('kbd', null, k));
      });
      box.append(h('span', null, what));
    }
    E.help.append(box);
  }

  // 對戰中的小按鈕（手機用）
  E.hudScore.addEventListener('click', () => callHud('onScoreboard'));
  E.hudMute.addEventListener('click', () => callHud('onMute'));
  E.hudLeave.addEventListener('click', () => {
    // 按兩次才離開，避免手指不小心碰到
    if (Date.now() - leaveArmed < LEAVE_CONFIRM_MS) {
      leaveArmed = 0;
      callHud('onLeave');
      return;
    }
    leaveArmed = Date.now();
    E.hudLeave.textContent = '再按一次離開';
    E.hudLeave.classList.add('armed');
    setTimeout(() => {
      if (Date.now() - leaveArmed < LEAVE_CONFIRM_MS) return;
      E.hudLeave.textContent = '離開';
      E.hudLeave.classList.remove('armed');
    }, LEAVE_CONFIRM_MS + 50);
  });

  E.reconnect.addEventListener('click', () => {
    if (!reconnectCb) return;
    E.reconnect.disabled = true;
    E.reconnect.textContent = '連線中…';
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      E.reconnect.disabled = false;
      E.reconnect.textContent = '重新連線';
    }, 4000);
    reconnectCb();
  });

  // 按鈕音效；滑鼠點完就取消焦點，避免之後按空白鍵又按到按鈕
  E.ui.addEventListener('click', (e) => {
    const btn = e.target.closest('button, .check');
    if (!btn) return;
    audio.play('click', { volume: 0.7 });
    if (e.detail > 0 && btn.blur) btn.blur();
  });
}

function callLobby(name, arg) {
  const fn = lobbyHandlers && lobbyHandlers[name];
  if (typeof fn === 'function') fn(arg);
}

function callHud(name) {
  const fn = hudHandlers && hudHandlers[name];
  if (typeof fn === 'function') fn();
}

// 對戰中按鈕的動作：{ onScoreboard, onMute, onLeave }
export function setHudHandlers(handlers) {
  hudHandlers = handlers || {};
}

// 手機瀏覽器（不是已安裝的 App）才需要「全螢幕」按鈕
function updateFullscreenBtn() {
  if (!E.fullscreen) return;
  const standalone = matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches;
  E.fullscreen.hidden = !document.fullscreenEnabled || standalone || !document.body.classList.contains('touch');
  E.fullscreen.textContent = document.fullscreenElement ? '離開全螢幕' : '全螢幕';
}

// 切換滑鼠 / 手指操作時，換一套按鈕和說明
export function setTouchMode(on) {
  document.body.classList.toggle('touch', !!on);
  updateFullscreenBtn();
}

// ---------- 標題畫面 ----------

export function showJoin({ defaultName = '', onJoin, onSolo, lan = true } = {}) {
  ensureInit();
  joinCb = onJoin || null;
  soloCb = onSolo || null;
  lanAvailable = !!lan;
  E.joinName.value = defaultName || '';
  E.joinBtn.disabled = E.soloBtn.disabled = false;
  // 沒有房主伺服器（例如放在 GitHub Pages）時只能單人玩
  E.joinBtn.hidden = !lanAvailable;
  E.soloBtn.textContent = lanAvailable ? '單人對戰' : '開始對戰（和電腦打）';
  E.soloBtn.classList.toggle('btn-gold', !lanAvailable);
  E.soloBtn.classList.toggle('btn-blue', lanAvailable);
  E.joinHint.textContent = lanAvailable
    ? '和同一個 Wi-Fi 的朋友一起 3 對 3 大亂鬥！也可以自己和電腦打。'
    : '和電腦水豚 3 對 3 大亂鬥！沒有網路也能玩。';
  setJoinError('');
  E.joinPortraits.replaceChildren();
  JOIN_LINEUP.forEach((id, i) => {
    const team = i < 2 ? 'blue' : i > 2 ? 'red' : '';
    const box = portraitBox(id, 6, `jp ${i === 2 ? 'big' : ''} ${team ? `team-${team}` : ''}`);
    box.style.animationDelay = `${(i % 2) * 0.45}s`;
    box.title = charName(id);
    E.joinPortraits.append(box);
  });
  setScreen('screen-join');
  // 手機上自動對焦會直接跳出鍵盤擋住畫面，所以只有電腦才自動對焦
  if (!document.body.classList.contains('touch')) {
    setTimeout(() => {
      E.joinName.focus();
      E.joinName.select();
    }, 0);
  }
}

export function setJoinError(msg) {
  ensureInit();
  E.joinError.textContent = msg || '';
  E.joinBtn.disabled = E.soloBtn.disabled = false;
  if (msg) restartAnim(E.joinError, 'shake');
}

// ---------- 大廳 ----------

function buildGrid() {
  gridBuilt = true;
  E.grid.replaceChildren();
  for (const c of CHARACTERS) {
    const card = h('button', `char-card role-${c.role}`);
    card.type = 'button';
    card.dataset.id = c.id;
    card.title = `${c.name}｜${ROLE_NAMES[c.role]}｜${c.weapon}`;
    const meta = h('div', 'cc-meta');
    meta.append(roleBadge(c.role), h('span', 'cc-weapon', c.weapon));
    card.append(h('div', 'cc-pips'), portraitBox(c.id, 4), h('div', 'cc-name', c.name), meta);
    card.addEventListener('click', () => {
      if (card.classList.contains('selected')) return;
      // 先在畫面上換好，伺服器確認後會再同步一次
      markPick(c.id);
      renderDetail(c.id);
      callLobby('onPick', c.id);
    });
    cards.set(c.id, card);
    E.grid.append(card);
  }
}

function markPick(charId) {
  for (const [id, card] of cards) card.classList.toggle('selected', id === charId);
}

function renderDetail(charId) {
  if (charId === detailId) return;
  const first = detailId === undefined;
  detailId = charId;
  const c = CHAR_BY_ID[charId];
  const box = E.detail;
  box.replaceChildren();
  if (!c) {
    box.className = 'panel char-detail';
    box.append(h('div', 'cd-desc', '從上面選一隻水豚吧！'));
    return;
  }
  box.className = `panel char-detail role-${c.role}`;
  if (!first) restartAnim(box, 'swap');

  const info = h('div', 'cd-info');
  const title = h('div', 'cd-title');
  title.append(h('span', 'cd-name', c.name), roleBadge(c.role));
  const stats = h('div', 'stats');
  STATS.forEach((s, i) => {
    const bar = h('div', 'stat-bar');
    const fill = h('div', 'stat-fill');
    fill.style.setProperty('--v', String(Math.max(0.04, s.get(c) / STAT_MAX[i])));
    fill.style.setProperty('--sc', s.color);
    bar.append(fill);
    stats.append(h('span', 'stat-label', s.label), bar, h('span', 'stat-val', s.fmt(c)));
  });
  info.append(title, h('div', 'cd-weapon', `武器：${c.weapon}`), h('p', 'cd-desc', c.desc), stats);

  const skills = h('div', 'cd-skills');
  skills.append(
    skillBox('普攻', c.weapon, c.attack.desc, 'atk'),
    skillBox('大招', c.super.name, c.super.desc, 'sup'),
  );
  box.append(portraitBox(c.id, 8, 'cd-portrait'), info, skills);
}

function skillBox(tag, name, desc, cls) {
  const box = h('div', `skill ${cls}`);
  const head = h('div', 'skill-head');
  head.append(h('span', 'skill-tag', tag), h('span', 'skill-name', name));
  box.append(head, h('p', 'skill-desc', desc));
  return box;
}

function playerSlot(p, state, myId) {
  const slot = h('div', 'slot');
  if (p.id === myId) slot.classList.add('me');
  slot.title = `${p.name}（${charName(p.charId)}）`;
  const info = h('div', 'slot-info');
  const row = h('div', 'slot-name-row');
  if (p.id === state.hostId) {
    const crown = h('span', 'slot-crown', '👑');
    crown.title = '房主';
    row.append(crown);
  }
  row.append(h('span', 'slot-name', p.name));
  if ([...String(p.name)].length > 6) row.classList.add('long');
  if (p.id === myId) row.append(h('span', 'slot-you', '（你）'));
  const ch = h('div', 'slot-char');
  const c = CHAR_BY_ID[p.charId];
  if (c) ch.append(roleBadge(c.role));
  ch.append(h('span', null, charName(p.charId)));
  info.append(row, ch);
  slot.append(portraitBox(p.charId, 4), info);
  return slot;
}

function emptySlot(bots) {
  const slot = h('div', bots ? 'slot empty bot' : 'slot empty');
  slot.append(h('div', 'pf', bots ? '?' : ''), h('span', null, bots ? '電腦補位' : '空位'));
  return slot;
}

function renderTeams(state, myId) {
  for (const team of TEAMS) {
    const list = state.players.filter((p) => p.team === team);
    const box = $(`team-${team}-slots`);
    const slots = [];
    for (let i = 0; i < Math.max(TEAM_SIZE, list.length); i++) {
      slots.push(list[i] ? playerSlot(list[i], state, myId) : emptySlot(state.bots));
    }
    box.replaceChildren(...slots);

    const col = box.closest('.team-col');
    col.classList.toggle('mine', lobbyMyTeam === team);
    const head = col.querySelector('.team-head');
    head.replaceChildren(document.createTextNode(TEAM_NAMES[team]), h('small', null, `${list.length}/${TEAM_SIZE}`));

    const btn = team === 'blue' ? E.btnBlue : E.btnRed;
    const full = list.length >= TEAM_SIZE;
    const mine = lobbyMyTeam === team;
    btn.disabled = mine || full || !lobbyMyTeam;
    btn.textContent = mine ? `你在${TEAM_NAMES[team]}` : full ? `${TEAM_NAMES[team]}已滿` : `加入${TEAM_NAMES[team]}`;
  }
}

function renderPips(players, myId) {
  for (const [id, card] of cards) {
    const others = players.filter((p) => p.charId === id && p.id !== myId);
    const key = others.map((p) => `${p.team}:${p.name}`).join('|');
    if (card.dataset.pips === key) continue;
    card.dataset.pips = key;
    const pips = card.querySelector('.cc-pips');
    pips.replaceChildren(
      ...others.map((p) => {
        const pip = h('span', `pip team-${p.team}`);
        pip.title = `${p.name} 也選了這隻`;
        return pip;
      }),
    );
  }
}

function renderUrls(urls, solo) {
  E.shareTitle.hidden = !!solo;
  if (solo) {
    urlsKey = null;
    E.urls.replaceChildren(h('span', 'share-solo', '單人模式：電腦水豚會幫你補滿兩隊，選好角色就開打！'));
    return;
  }
  const list = Array.isArray(urls) ? urls : [];
  const key = list.join(' ');
  if (key === urlsKey) return;
  urlsKey = key;
  if (!list.length) {
    E.urls.replaceChildren(h('span', 'share-none', '找不到區域網路位址，請確認開伺服器的電腦有連上 Wi-Fi'));
    return;
  }
  E.urls.replaceChildren(
    ...list.map((url) => {
      const chip = h('button', 'url-chip', url);
      chip.type = 'button';
      chip.title = '點一下複製網址';
      chip.addEventListener('click', async () => {
        const ok = await copyText(url);
        showToast(ok ? `已複製網址：${url}` : `沒辦法自動複製，請手動輸入：${url}`);
      });
      return chip;
    }),
  );
}

async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 改用舊方法
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

export function showLobby(state, myId, handlers) {
  ensureInit();
  if (!state) return;
  lobbyHandlers = handlers || {};
  lobbyMyId = myId;
  const players = Array.isArray(state.players) ? state.players : [];
  const s = { ...state, players };
  const me = players.find((p) => p.id === myId) || null;
  lobbyMyTeam = me ? me.team : null;
  const isHost = state.hostId === myId;
  const inMatch = state.phase === 'match';

  if (!gridBuilt) buildGrid();
  markPick(me ? me.charId : null);
  renderDetail(me ? me.charId : null);
  renderPips(players, myId);
  renderTeams(s, myId);
  renderUrls(state.urls, state.solo);

  E.count.innerHTML = '';
  if (!state.solo) E.count.append('玩家 ', h('b', null, String(players.length)), ` / ${MAX_HUMANS}`);
  E.banner.hidden = !inMatch;
  updateFullscreenBtn();

  // 房主控制（單人模式一定有電腦補位，不用勾）
  E.botsLabel.hidden = !!state.solo;
  E.botsCheck.checked = !!state.bots;
  E.botsCheck.disabled = !isHost;
  E.botsLabel.classList.toggle('readonly', !isHost);
  E.botsLabel.title = isHost ? '' : '只有房主可以改';
  const text = E.botsLabel.querySelector('.check-text');
  if (text) {
    const want = isHost ? '' : '（只有房主可以改）';
    let small = text.querySelector('small');
    if (want && !small) text.append((small = h('small')));
    if (small) {
      if (want) small.textContent = want;
      else small.remove();
    }
  }
  E.start.hidden = !isHost;
  E.start.disabled = inMatch;
  E.start.textContent = inMatch ? '對戰進行中…' : '開始對戰！';
  E.waitHost.hidden = isHost;

  // 自己正在對戰（或看結算）時，大廳只在背景更新，不搶畫面
  const inGameView = screen === 'hud' || screen === 'screen-result';
  if (!(inGameView && inMatch)) setScreen('screen-lobby');
}

// ---------- 提示訊息 ----------

export function showToast(msg) {
  ensureInit();
  if (!msg) return;
  const t = h('div', 'toast', String(msg));
  E.toasts.append(t);
  while (E.toasts.children.length > 4) E.toasts.firstElementChild.remove();
  setTimeout(() => {
    t.classList.add('out');
    setTimeout(() => t.remove(), 300);
  }, TOAST_MS);
}

// ---------- 對戰 HUD ----------

function fmtClock(sec) {
  const s = Math.max(0, Math.ceil(Number(sec) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function showGame(info, myId, { solo = false } = {}) {
  ensureInit();
  const players = (info && info.players) || [];
  game = {
    info: info || {},
    myId,
    me: players.find((p) => p.id === myId) || null,
    duration: (info && info.duration) || 150,
  };
  hc = {};
  sbKey = null;
  clearTimeout(centerTimer);

  for (const team of TEAMS) {
    const box = team === 'blue' ? E.teamBlue : E.teamRed;
    box.replaceChildren(
      ...players
        .filter((p) => p.team === team)
        .map((p) => {
          const pf = portraitBox(p.charId, 2, p.id === myId ? 'me' : '');
          pf.title = p.name;
          return pf;
        }),
    );
  }
  E.goal.textContent = `先拿到 ${(info && info.koTarget) || 10} 次擊倒獲勝`;
  E.killfeed.replaceChildren();
  E.scoreboard.hidden = true;
  E.countdown.hidden = true;
  E.dead.hidden = true;
  E.spectator.hidden = !(info && info.spectator);
  E.superBtn.hidden = !!(info && info.spectator);
  E.touchUi.hidden = !!(info && info.spectator);
  E.hudLeave.hidden = !solo;
  E.hudLeave.textContent = '離開';
  E.hudLeave.classList.remove('armed');
  leaveArmed = 0;
  game.solo = solo;
  setScreen('hud');
}

// 只在數值改變時才寫 DOM
function setText(node, key, val) {
  if (hc[key] === val) return;
  hc[key] = val;
  node.textContent = val;
}

function setHidden(node, key, hidden) {
  if (hc[key] === hidden) return;
  hc[key] = hidden;
  node.hidden = hidden;
}

function setClass(node, key, cls, on) {
  if (hc[key] === on) return;
  hc[key] = on;
  node.classList.toggle(cls, on);
}

// 畫面中央的大字（倒數 3/2/1、開打！）
function flashCenter(text, go) {
  clearTimeout(centerTimer);
  const n = E.countdown;
  n.textContent = text;
  n.classList.toggle('go', !!go);
  n.hidden = false;
  restartAnim(n, 'pop');
  if (go) centerTimer = setTimeout(() => (n.hidden = true), 1000);
}

function setScore(node, key, val) {
  if (hc[key] === val) return;
  const had = hc[key] !== undefined;
  hc[key] = val;
  node.textContent = val;
  if (had) restartAnim(node, 'bump');
}

export function updateHUD(st) {
  if (!inited || !st) return;
  const phase = st.phase;
  const score = st.score || [0, 0];
  setScore(E.scoreBlue, 'sb', String(score[0] ?? 0));
  setScore(E.scoreRed, 'sr', String(score[1] ?? 0));

  // 時鐘：倒數時先顯示整場時間
  setText(E.clock, 'clock', fmtClock(phase === 'countdown' ? (game && game.duration) || 150 : st.clock));
  setClass(E.clock, 'low', 'low', phase === 'playing' && st.clock <= 10);

  // 開場倒數 / 開打！
  if (phase !== hc.phase) {
    const prev = hc.phase;
    hc.phase = phase;
    if (phase !== 'countdown') hc.cd = null;
    if (prev === 'countdown' && phase === 'playing') flashCenter('開打！', true);
    else if (phase !== 'countdown') E.countdown.hidden = true;
  }
  if (phase === 'countdown') {
    const n = Math.max(1, Math.ceil(st.clock || 0));
    if (n !== hc.cd) {
      hc.cd = n;
      flashCenter(String(n), false);
    }
  }

  const spectator = !!st.spectator;
  setHidden(E.spectator, 'spec', !spectator);
  setHidden(E.mineBlue, 'mineB', st.myTeam !== 'blue');
  setHidden(E.mineRed, 'mineR', st.myTeam !== 'red');

  // 大招
  setHidden(E.superBtn, 'superHide', spectator || !st.myTeam);
  const q = Math.max(0, Math.min(100, Math.floor((Number(st.superCharge) || 0) * 100 + 1e-6)));
  if (hc.q !== q) {
    hc.q = q;
    E.superBtn.style.setProperty('--charge', String(q / 100));
    E.superPct.textContent = q >= 100 ? '大招好了！' : `${q}%`;
    E.superBtn.classList.toggle('full', q >= 100);
  }
  setText(E.superName, 'superName', st.superName || '大招');
  setClass(E.superBtn, 'superDead', 'dead', !st.alive && !spectator);

  // 被打倒
  const dead = !st.alive && !spectator && phase !== 'ended';
  setHidden(E.dead, 'dead', !dead);
  if (dead) setText(E.respawn, 'respawn', String(Math.max(1, Math.ceil(Number(st.respawnIn) || 0))));

  // 延遲 / 靜音（單人模式沒有網路延遲，只在靜音時顯示）
  setHidden(E.ping, 'pingHide', !!(game && game.solo) && !audio.muted);
  setText(E.hudMute, 'muteBtn', audio.muted ? '開聲音' : '靜音');
  const ping = st.ping == null || !Number.isFinite(st.ping) ? null : Math.round(st.ping);
  setText(E.pingText, 'ping', ping == null ? '-- ms' : `${ping} ms`);
  const lvl = ping == null ? 'none' : ping < 60 ? 'good' : ping < 150 ? 'ok' : 'bad';
  if (hc.lvl !== lvl) {
    hc.lvl = lvl;
    E.ping.dataset.lvl = lvl;
  }
  setHidden(E.muted, 'muted', !audio.muted);
}

function kfPlayer(p) {
  const span = h('span', `kf-p team-${p.team}`);
  span.append(portraitBox(p.charId, 2), h('span', 'kf-n', p.name));
  return span;
}

export function addKillFeed(killer, victim) {
  ensureInit();
  if (!victim) return;
  const li = h('li', 'kf');
  const me = game && game.me;
  const isMe = (p) => !!(p && me && p.name === me.name && p.team === me.team);
  if (killer) {
    li.append(kfPlayer(killer), h('span', 'kf-icon'), kfPlayer(victim));
    if (isMe(killer)) li.classList.add('mine');
  } else {
    li.append(kfPlayer(victim), h('span', 'kf-down', '倒下了'));
  }
  if (isMe(victim)) li.classList.add('died');
  E.killfeed.prepend(li);
  while (E.killfeed.children.length > KILLFEED_MAX) E.killfeed.lastElementChild.remove();
  setTimeout(() => {
    li.classList.add('fade');
    setTimeout(() => li.remove(), 450);
  }, KILLFEED_MS);
}

// ---------- Tab 計分板 ----------

export function setScoreboard(visible, rows) {
  if (!inited) return;
  const show = !!visible;
  if (E.scoreboard.hidden === show) E.scoreboard.hidden = !show;
  if (!show) return;
  const list = Array.isArray(rows) ? rows : [];
  const key = JSON.stringify(list);
  if (key === sbKey) return;
  sbKey = key;

  const title = h('div', 'sbd-title');
  title.append(
    h('span', null, '計分板'),
    h('small', 'mouse-only', '放開 Tab 關閉'),
    h('small', 'touch-only', '再按一次「計分板」關閉'),
  );
  const cols = h('div', 'sbd-cols');
  for (const team of TEAMS) {
    const box = h('div', `sbd-team team-${team}`);
    const head = h('div', 'sbd-head');
    head.append(h('span', 'team-name', TEAM_NAMES[team]), h('span', 'num', '擊倒'), h('span', 'num', '被擊倒'));
    box.append(head);
    const teamRows = list
      .filter((r) => r.team === team)
      .sort((a, b) => (b.kills || 0) - (a.kills || 0) || (a.deaths || 0) - (b.deaths || 0));
    for (const r of teamRows) {
      const row = h('div', r.isMe ? 'sbd-row me' : 'sbd-row');
      const name = h('span', 'cell-name', r.name);
      if (r.isMe) name.append(h('span', 'you', '（你）'));
      row.append(portraitBox(r.charId, 2), name, h('span', 'num k', String(r.kills || 0)), h('span', 'num', String(r.deaths || 0)));
      box.append(row);
    }
    cols.append(box);
  }
  E.scoreboard.replaceChildren(title, cols);
}

// ---------- 結算 ----------

export function showResult(result, myId) {
  ensureInit();
  if (!result) return;
  clearTimeout(centerTimer);
  const players = Array.isArray(result.players) ? result.players : [];
  const score = result.score || [0, 0];
  const winner = result.winner;
  const mine = players.find((p) => p.id === myId);

  E.result.dataset.winner = winner;
  E.resultTitle.className = `result-title ${winner}`;
  E.resultTitle.textContent = winner === 'blue' ? '藍隊勝利！' : winner === 'red' ? '紅隊勝利！' : '平手！';
  restartAnim(E.resultTitle, 'result-title');

  let sub = '精彩的一場對決！';
  let subCls = '';
  if (mine && winner === 'draw') sub = '勢均力敵！';
  else if (mine && mine.team === winner) {
    sub = '你們贏了！';
    subCls = 'win';
  } else if (mine) sub = '下次會更好';
  E.resultSub.className = `result-sub ${subCls}`.trim();
  E.resultSub.textContent = sub;

  E.resultScore.replaceChildren(
    h('span', 'b', String(score[0] ?? 0)),
    h('span', 'colon', ':'),
    h('span', 'r', String(score[1] ?? 0)),
  );

  // MVP：造成最多傷害的水豚
  let mvp = null;
  for (const p of players) if ((p.damage || 0) > 0 && (!mvp || p.damage > mvp.damage)) mvp = p;

  const tables = TEAMS.map((team, ti) => {
    const box = h('div', `rt team-${team}${winner === team ? ' winner' : ''}`);
    const head = h('div', 'rt-head');
    head.append(h('span', null, TEAM_NAMES[team]));
    if (winner === team) head.append(h('span', 'rt-win', '勝利'));
    head.append(h('span', 'rt-score', String(score[ti] ?? 0)));
    const cols = h('div', 'rt-cols');
    cols.append(h('span'), h('span', null, '水豚'), h('span', 'num', '擊倒'), h('span', 'num', '被擊倒'), h('span', 'num dmg', '傷害'));
    box.append(head, cols);
    players
      .filter((p) => p.team === team)
      .sort((a, b) => (b.kills || 0) - (a.kills || 0) || (b.damage || 0) - (a.damage || 0))
      .forEach((p, i) => {
        const row = h('div', p.id === myId ? 'rt-row me' : 'rt-row');
        row.style.setProperty('--i', String(i + ti * 3));
        const name = h('span', 'rt-name');
        name.title = `${p.name}（${charName(p.charId)}）`;
        // 伺服器給電腦的名字會帶「（電腦）」，這裡改用小標籤顯示
        name.append(h('span', 'nm', p.isBot ? String(p.name).replace(/（電腦）$/, '') : p.name));
        if (p.id === myId) name.append(h('span', 'slot-you', '（你）'));
        if (p.isBot) name.append(h('span', 'bot-tag', '電腦'));
        if (mvp && p.id === mvp.id) name.append(h('span', 'mvp', 'MVP'));
        row.append(
          portraitBox(p.charId, 3),
          name,
          h('span', 'num', String(p.kills || 0)),
          h('span', 'num', String(p.deaths || 0)),
          h('span', 'num dmg', Math.round(p.damage || 0).toLocaleString('zh-TW')),
        );
        box.append(row);
      });
    return box;
  });
  E.resultTables.replaceChildren(...tables);
  E.scoreboard.hidden = true;
  setScreen('screen-result');
}

// ---------- 斷線 ----------

export function showDisconnected(onReconnect) {
  ensureInit();
  reconnectCb = onReconnect || null;
  clearTimeout(reconnectTimer);
  E.reconnect.disabled = false;
  E.reconnect.textContent = '重新連線';
  E.reconnect.hidden = !reconnectCb;
  const icon = document.querySelector('#screen-disconnected .disc-icon');
  if (icon && !icon.firstChild) icon.append(portrait('onsen', 6));
  setScreen('screen-disconnected');
}

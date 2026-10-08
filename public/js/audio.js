// 音效和背景音樂：全部用 Web Audio API 即時合成（不需要任何音效檔，離線也能用）
const STORE_KEY = 'capybara-brawl-muted';
const MASTER_VOLUME = 0.6;
const THROTTLE_MS = 40; // 同一種音效最快 40ms 播一次

let ctx = null;
let master = null;
let noiseBuf = null;
let muted = loadMuted();
const lastPlayed = new Map();

function loadMuted() {
  try {
    return localStorage.getItem(STORE_KEY) === '1';
  } catch {
    return false;
  }
}

function saveMuted() {
  try {
    localStorage.setItem(STORE_KEY, muted ? '1' : '0');
  } catch {
    // 無痕模式等情況存不了，沒關係
  }
}

const clamp = (v, lo, hi, def) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def);

function ensureCtx() {
  if (ctx) return ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  ctx = new AC();
  // 主音量 → 柔化高頻 → 壓縮（很多聲音疊在一起也不會爆音）
  master = ctx.createGain();
  master.gain.value = muted ? 0 : MASTER_VOLUME;
  const soften = ctx.createBiquadFilter();
  soften.type = 'lowpass';
  soften.frequency.value = 7500;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -10;
  comp.knee.value = 12;
  comp.ratio.value = 4;
  comp.attack.value = 0.003;
  comp.release.value = 0.15;
  master.connect(soften);
  soften.connect(comp);
  comp.connect(ctx.destination);
  // 白噪音（爆炸、揮砍、水花用）
  noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return ctx;
}

// ---------- 合成小工具 ----------

// 一個音：振盪器 + 音量包絡（可滑音、可抖音）
function tone(out, t, { type = 'square', f = 440, f2 = 0, dur = 0.1, vol = 0.2, attack = 0.005, hold = 0, vib = 0, vibRate = 7 }) {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(f, t);
  if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + dur);
  if (vib) {
    const lfo = ctx.createOscillator();
    const lg = ctx.createGain();
    lfo.frequency.value = vibRate;
    lg.gain.value = vib;
    lfo.connect(lg);
    lg.connect(o.frequency);
    lfo.start(t);
    lfo.stop(t + dur + 0.05);
  }
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + attack);
  if (hold) g.gain.setValueAtTime(vol, t + attack + hold);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g);
  g.connect(out);
  o.start(t);
  o.stop(t + dur + 0.05);
}

// 一段噪音：濾波器 + 音量包絡
function noise(out, t, { dur = 0.2, vol = 0.3, type = 'bandpass', f = 1000, f2 = 0, q = 1, attack = 0.003 }) {
  const s = ctx.createBufferSource();
  s.buffer = noiseBuf;
  const flt = ctx.createBiquadFilter();
  flt.type = type;
  flt.frequency.setValueAtTime(f, t);
  if (f2) flt.frequency.exponentialRampToValueAtTime(f2, t + dur);
  flt.Q.value = q;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  s.connect(flt);
  flt.connect(g);
  g.connect(out);
  s.start(t, Math.random() * 0.5);
  s.stop(t + dur + 0.05);
}

// 一串音符：[頻率, 開始時間, 長度]
function notes(out, t, list, opts) {
  for (const [f, at, dur] of list) tone(out, t + at, { ...opts, f, dur });
}

// ---------- 每種音效（回傳大約長度，秒） ----------

const SOUNDS = {
  // 射擊：短短的「咻」
  shoot(o, t) {
    tone(o, t, { type: 'square', f: 1100, f2: 480, dur: 0.08, vol: 0.13 });
    noise(o, t, { type: 'highpass', f: 3000, dur: 0.035, vol: 0.06 });
    return 0.1;
  },
  // 投擲：往上飛的風聲
  throw(o, t) {
    noise(o, t, { f: 400, f2: 2400, q: 1.5, dur: 0.17, vol: 0.22, attack: 0.03 });
    tone(o, t, { type: 'triangle', f: 260, f2: 560, dur: 0.15, vol: 0.14 });
    return 0.2;
  },
  // 揮砍：俐落的「唰」
  slash(o, t) {
    noise(o, t, { f: 1600, f2: 6000, q: 2, dur: 0.13, vol: 0.3, attack: 0.01 });
    tone(o, t, { type: 'triangle', f: 900, f2: 320, dur: 0.1, vol: 0.08 });
    return 0.15;
  },
  // 出拳：悶悶的「碰」
  punch(o, t) {
    tone(o, t, { type: 'sine', f: 230, f2: 55, dur: 0.13, vol: 0.5 });
    noise(o, t, { type: 'lowpass', f: 1800, f2: 300, dur: 0.06, vol: 0.28 });
    return 0.15;
  },
  // 打中別人：清脆的「叮」
  hit(o, t) {
    tone(o, t, { type: 'triangle', f: 1400, f2: 1000, dur: 0.07, vol: 0.24 });
    tone(o, t, { type: 'square', f: 2100, dur: 0.03, vol: 0.05 });
    return 0.08;
  },
  // 自己被打：低低的「嗚」
  hurt(o, t) {
    tone(o, t, { type: 'square', f: 380, f2: 180, dur: 0.15, vol: 0.1 });
    tone(o, t, { type: 'triangle', f: 190, f2: 90, dur: 0.16, vol: 0.22 });
    return 0.18;
  },
  // 爆炸
  boom(o, t) {
    noise(o, t, { type: 'lowpass', f: 1600, f2: 80, q: 0.7, dur: 0.55, vol: 0.6 });
    tone(o, t, { type: 'sine', f: 140, f2: 35, dur: 0.42, vol: 0.5 });
    tone(o, t, { type: 'square', f: 90, f2: 40, dur: 0.2, vol: 0.06 });
    return 0.6;
  },
  // 擊倒：「噗」一聲 + 叮叮噹
  ko(o, t) {
    noise(o, t, { f: 1200, f2: 300, dur: 0.2, vol: 0.22 });
    notes(o, t, [[523, 0.05, 0.09], [784, 0.13, 0.09], [1047, 0.21, 0.24]], { type: 'square', vol: 0.09 });
    notes(o, t, [[523, 0.05, 0.09], [784, 0.13, 0.09], [1047, 0.21, 0.26]], { type: 'triangle', vol: 0.14 });
    return 0.5;
  },
  // 放大招：往上衝的能量
  super(o, t) {
    tone(o, t, { type: 'square', f: 220, f2: 880, dur: 0.3, vol: 0.09 });
    notes(o, t, [[523, 0.04, 0.1], [659, 0.09, 0.1], [784, 0.14, 0.1], [1047, 0.19, 0.18]], { type: 'triangle', vol: 0.18 });
    noise(o, t, { type: 'highpass', f: 3500, dur: 0.32, vol: 0.06, attack: 0.15 });
    return 0.4;
  },
  // 大招集滿：閃亮亮
  superReady(o, t) {
    notes(o, t, [[1319, 0, 0.16], [1568, 0.07, 0.16], [2093, 0.14, 0.22]], { type: 'triangle', vol: 0.15 });
    tone(o, t + 0.2, { type: 'sine', f: 2637, dur: 0.25, vol: 0.06 });
    return 0.45;
  },
  // 回血：溫柔的上行和弦
  heal(o, t) {
    notes(o, t, [[523, 0, 0.24], [659, 0.06, 0.24], [784, 0.12, 0.3]], { type: 'sine', vol: 0.14, vib: 6, vibRate: 9 });
    notes(o, t, [[1047, 0.06, 0.2], [1319, 0.12, 0.24]], { type: 'triangle', vol: 0.04 });
    return 0.45;
  },
  // 踩到香蕉皮：卡通滑哨
  slip(o, t) {
    tone(o, t, { type: 'triangle', f: 300, f2: 1400, dur: 0.18, vol: 0.2, attack: 0.01, vib: 25, vibRate: 14 });
    tone(o, t + 0.18, { type: 'triangle', f: 1400, f2: 200, dur: 0.24, vol: 0.18, attack: 0.005 });
    return 0.45;
  },
  // 復活 / 出場：「啵～」
  spawn(o, t) {
    tone(o, t, { type: 'sine', f: 260, f2: 780, dur: 0.18, vol: 0.24 });
    tone(o, t + 0.12, { type: 'triangle', f: 1047, dur: 0.16, vol: 0.09 });
    tone(o, t + 0.18, { type: 'triangle', f: 1568, dur: 0.18, vol: 0.06 });
    return 0.4;
  },
  // 倒數嗶聲
  countdown(o, t) {
    tone(o, t, { type: 'square', f: 659, dur: 0.16, vol: 0.1, hold: 0.07 });
    tone(o, t, { type: 'triangle', f: 659, dur: 0.16, vol: 0.12, hold: 0.07 });
    return 0.2;
  },
  // 開打！
  go(o, t) {
    tone(o, t, { type: 'square', f: 1319, dur: 0.42, vol: 0.1, hold: 0.18 });
    tone(o, t, { type: 'triangle', f: 659, dur: 0.42, vol: 0.14, hold: 0.18 });
    tone(o, t, { type: 'triangle', f: 988, dur: 0.42, vol: 0.08, hold: 0.18 });
    return 0.45;
  },
  // 勝利小號角
  win(o, t) {
    const mel = [[523, 0, 0.12], [659, 0.12, 0.12], [784, 0.24, 0.12], [1047, 0.36, 0.2], [784, 0.56, 0.1], [1047, 0.66, 0.6]];
    notes(o, t, mel, { type: 'square', vol: 0.08, hold: 0.04 });
    notes(o, t, mel, { type: 'triangle', vol: 0.12, hold: 0.04 });
    notes(o, t, [[262, 0, 0.34], [349, 0.36, 0.3], [392, 0.66, 0.6]], { type: 'triangle', vol: 0.14 });
    return 1.3;
  },
  // 輸了：「哇～哇～」
  lose(o, t) {
    const mel = [[392, 0, 0.26], [370, 0.26, 0.26], [349, 0.52, 0.26], [330, 0.78, 0.7]];
    notes(o, t, mel, { type: 'triangle', vol: 0.2, hold: 0.1, vib: 5, vibRate: 6 });
    notes(o, t, mel.map(([f, a, d]) => [f / 2, a, d]), { type: 'square', vol: 0.04, hold: 0.1 });
    return 1.5;
  },
  // 介面按鈕
  click(o, t) {
    tone(o, t, { type: 'triangle', f: 1800, f2: 1200, dur: 0.035, vol: 0.12 });
    return 0.05;
  },
  // 水花（溫泉、熱水）
  splash(o, t) {
    noise(o, t, { f: 2500, f2: 600, q: 0.8, dur: 0.35, vol: 0.3, attack: 0.01 });
    tone(o, t, { type: 'sine', f: 600, f2: 200, dur: 0.12, vol: 0.18 });
    tone(o, t + 0.1, { type: 'sine', f: 1400, f2: 1900, dur: 0.06, vol: 0.06 });
    tone(o, t + 0.18, { type: 'sine', f: 1200, f2: 1700, dur: 0.06, vol: 0.05 });
    return 0.4;
  },
  // 卡通「咚」
  bonk(o, t) {
    tone(o, t, { type: 'sine', f: 700, f2: 250, dur: 0.13, vol: 0.42 });
    tone(o, t, { type: 'triangle', f: 1400, f2: 500, dur: 0.05, vol: 0.14 });
    noise(o, t, { type: 'lowpass', f: 3000, dur: 0.03, vol: 0.12 });
    return 0.15;
  },
};

// 每種音效的音量微調（讓短促的音效和長的音效聽起來差不多大聲）
const GAIN = {
  shoot: 2.6, throw: 2.6, slash: 2.5, punch: 1.4, hit: 1.9, hurt: 1.8, boom: 1.4, ko: 1.15, super: 1.4,
  superReady: 1.35, heal: 1.05, slip: 1.1, spawn: 1.7, countdown: 1.1, go: 1, win: 0.95, lose: 1.1,
  click: 2.4, splash: 1.5, bonk: 1.4,
};


// ---------- 背景音樂：即時合成的小樂團（主旋律、貝斯、分解和弦、鼓） ----------
// 每首歌 = 和弦進行（一小節一個和弦）+ 主旋律（每格是一個八分音符）。
// 主旋律的寫法：音名（C5、Bb4、G#5）= 彈一個新音；「.」= 上一個音繼續；「-」= 休息。

const MUSIC_VOLUME = 0.6; // 背景音樂相對於音效的音量（比音效小聲一點）
const NOTE_INDEX = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const CHORD_TYPES = { '': [0, 4, 7], m: [0, 3, 7] };

function noteFreq(name) {
  const m = /^([A-G])([#b]?)(\d)$/.exec(name);
  if (!m) return 0;
  const semi = NOTE_INDEX[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + (Number(m[3]) + 1) * 12;
  return 440 * 2 ** ((semi - 69) / 12);
}

// 和弦名稱（F、Dm、Bb、G#m…）→ 根音的半音數和三個和弦音的半音距離
function chordOf(name) {
  const m = /^([A-G])([#b]?)(m?)$/.exec(name);
  const root = NOTE_INDEX[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
  return { root, tones: CHORD_TYPES[m[3]] };
}

const semiFreq = (semi) => 440 * 2 ** ((semi - 69) / 12);

function tokens(text) {
  return text.trim().split(/\s+/);
}

const SONGS = {
  // 標題和大廳：輕鬆、蹦蹦跳跳（F 大調）
  menu: {
    bpm: 104,
    style: 'calm',
    chords: ['F', 'Dm', 'Bb', 'C', 'F', 'Dm', 'Gm', 'C'],
    melody: tokens(`
      C5 . A4 C5 F5 . E5 .    D5 . . . A4 . - -
      Bb4 . D5 . C5 . Bb4 A4  G4 . . . - - C5 -
      C5 . A4 C5 F5 . G5 .    A5 . G5 F5 D5 . - -
      Bb4 . D5 . G5 . F5 E5   F5 . . . . . - -
    `),
  },
  // 對戰：節奏快、有衝勁（A 小調），前半段主題、後半段比較緊張
  battle: {
    bpm: 140,
    style: 'drive',
    chords: ['Am', 'F', 'C', 'G', 'Am', 'F', 'G', 'E', 'F', 'G', 'Am', 'Am', 'F', 'G', 'E', 'E'],
    melody: tokens(`
      A4 . C5 . E5 . A5 .     G5 . F5 E5 F5 . C5 .
      E5 . G5 . C6 . B5 A5    B5 . . . G5 . D5 .
      A5 . E5 . A5 . C6 .     B5 A5 G5 . F5 . A5 .
      G5 . F5 . E5 . D5 .     E5 . . . G#5 . B5 .
      C5 . . . F5 . . .       D5 . . . G5 . . .
      E5 . . . A5 . G5 .      E5 . . . - - - -
      F5 . E5 . D5 . C5 .     D5 . E5 . F5 . G5 .
      G#5 . . . B5 . . .      E5 . . . - - - -
    `),
  },
};

// 鼓的節奏（16 分音符一格）：k 大鼓、s 小鼓、h 鈸、- 空
const DRUMS = {
  calm: 'k - h - s - h - k - k h s - h -',
  drive: 'k - h h s - h k k - h h s h h h',
};

let musicBus = null;
let songGain = null;
let song = null; // 正在播的歌
let wantSong = null; // 想播的歌（聲音還沒解鎖時先記著）
let songName = null;
let musicTimer = 0;
let step = 0;
let nextStepAt = 0;
let tempoScale = 1;

function ensureMusicBus() {
  if (musicBus || !ctx) return;
  musicBus = ctx.createGain();
  musicBus.gain.value = MUSIC_VOLUME;
  musicBus.connect(master);
}

// 主旋律：方波 + 一點抖音，聽起來像紅白機
function playLead(out, t, f, dur) {
  tone(out, t, { type: 'square', f, dur: Math.max(0.08, dur), vol: 0.055, attack: 0.008, hold: Math.max(0, dur * 0.55), vib: dur > 0.3 ? f * 0.012 : 0, vibRate: 6 });
}

function playBass(out, t, f, dur) {
  tone(out, t, { type: 'triangle', f, dur, vol: 0.2, attack: 0.006, hold: dur * 0.5 });
}

function playArp(out, t, f, dur) {
  tone(out, t, { type: 'triangle', f, dur, vol: 0.05, attack: 0.004 });
}

function playDrum(out, t, kind) {
  if (kind === 'k') {
    tone(out, t, { type: 'sine', f: 150, f2: 45, dur: 0.14, vol: 0.4 });
    tone(out, t, { type: 'triangle', f: 420, f2: 110, dur: 0.035, vol: 0.12 }); // 手機喇叭也聽得到的「咚」
  }
  else if (kind === 's') {
    noise(out, t, { type: 'bandpass', f: 1900, q: 0.8, dur: 0.12, vol: 0.13 });
    tone(out, t, { type: 'triangle', f: 220, f2: 140, dur: 0.07, vol: 0.06 });
  } else if (kind === 'h') noise(out, t, { type: 'highpass', f: 7500, dur: 0.035, vol: 0.035 });
}

// 排一格（16 分音符）裡所有樂器的音
function scheduleStep(sg, i, t, stepDur) {
  const out = songGain;
  const bar = Math.floor(i / 16) % sg.chords.length;
  const pos = i % 16;
  const chord = chordOf(sg.chords[bar]);

  // 主旋律：偶數格才是八分音符的開頭
  if (pos % 2 === 0) {
    const k = (i / 2) % sg.melody.length;
    const tok = sg.melody[k];
    if (tok !== '.' && tok !== '-') {
      let len = 1;
      while (sg.melody[(k + len) % sg.melody.length] === '.' && len < 8) len++;
      playLead(out, t, noteFreq(tok), len * 2 * stepDur * 0.92);
    }
  }

  // 貝斯和分解和弦（貝斯放在第 3 個八度：手機喇叭放不出太低的音）
  const root2 = 48 + chord.root;
  if (sg.style === 'drive') {
    if (pos % 2 === 0) playBass(out, t, semiFreq(root2 + (pos % 4 === 2 ? 12 : 0)), stepDur * 1.8);
    playArp(out, t, semiFreq(60 + chord.root + chord.tones[pos % 3] + (pos >= 8 ? 12 : 0)), stepDur * 0.9);
  } else {
    if (pos % 4 === 0) playBass(out, t, semiFreq(root2 + [0, 7, 12, 7][pos / 4]), stepDur * 3.6);
    if (pos % 2 === 0) playArp(out, t, semiFreq(60 + chord.root + chord.tones[(pos / 2) % 3]), stepDur * 1.8);
  }

  // 鼓
  const drum = DRUMS[sg.style].split(' ')[pos];
  if (drum !== '-') playDrum(out, t, drum);
}

// 往前排 0.15 秒的音，計時器偶爾晚到也不會掉拍
function musicTick() {
  if (!song || !ctx || ctx.state !== 'running') return;
  const now = ctx.currentTime;
  if (nextStepAt < now - 0.2) nextStepAt = now + 0.05; // 剛從背景回來：從現在重新開始
  const total = song.chords.length * 16;
  while (nextStepAt < now + 0.15) {
    const stepDur = 60 / (song.bpm * tempoScale) / 4;
    if (!muted) scheduleStep(song, step, nextStepAt, stepDur);
    nextStepAt += stepDur;
    step = (step + 1) % total;
  }
}

function startSong(name) {
  if (songName === name) return;
  songName = name;
  // 舊的歌淡出
  if (songGain) {
    const old = songGain;
    try {
      old.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.15);
    } catch {
      // 忽略
    }
    setTimeout(() => old.disconnect(), 1200);
    songGain = null;
  }
  song = name ? SONGS[name] : null;
  clearInterval(musicTimer);
  if (!song) return;
  ensureMusicBus();
  songGain = ctx.createGain();
  songGain.gain.setValueAtTime(0.0001, ctx.currentTime);
  songGain.gain.setTargetAtTime(1, ctx.currentTime, 0.3);
  songGain.connect(musicBus);
  step = 0;
  tempoScale = 1;
  nextStepAt = ctx.currentTime + 0.1;
  musicTick();
  musicTimer = setInterval(musicTick, 50);
}

// 聲音解鎖後才真的開始播
function syncMusic() {
  if (ctx && ctx.state === 'running' && wantSong !== songName) startSong(wantSong);
}

// iPhone 靜音開關打開時，網頁的聲音預設會被關掉；遊戲比照音樂 App，開關打開也照樣有聲音
// （想安靜可以按遊戲裡的「靜音」）。iOS 16.4 以上用 audioSession，舊版用一段無聲的 <audio> 當媒體播放
let silentAudio = null;
function playThroughSilentSwitch() {
  try {
    if (navigator.audioSession) {
      navigator.audioSession.type = 'playback';
      return;
    }
    const iOS = /iP(hone|ad|od)/.test(navigator.platform) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (!iOS || silentAudio) return;
    // 0.5 秒的無聲 WAV（8kHz、8-bit）
    const n = 4000;
    const bytes = new Uint8Array(44 + n);
    const v = new DataView(bytes.buffer);
    const str = (o, text) => [...text].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    str(0, 'RIFF');
    v.setUint32(4, 36 + n, true);
    str(8, 'WAVEfmt ');
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, 1, true);
    v.setUint32(24, 8000, true);
    v.setUint32(28, 8000, true);
    v.setUint16(32, 1, true);
    v.setUint16(34, 8, true);
    str(36, 'data');
    v.setUint32(40, n, true);
    bytes.fill(128, 44);
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    silentAudio = new Audio(`data:audio/wav;base64,${btoa(bin)}`);
    silentAudio.loop = true;
    silentAudio.setAttribute('playsinline', '');
    const p = silentAudio.play();
    if (p && p.catch) p.catch(() => {});
  } catch {
    // 不支援就算了
  }
}

// 切到別的 App 或關螢幕時暫停聲音（省電），回來再繼續；iPhone 被來電、Siri 打斷後也在這裡恢復
document.addEventListener('visibilitychange', () => {
  if (!ctx) return;
  try {
    if (document.hidden) ctx.suspend().catch(() => {});
    else ctx.resume().then(syncMusic, () => {});
  } catch {
    // 忽略
  }
});

export const audio = {
  // 每次點擊或按鍵時呼叫：建立 / 喚醒 AudioContext（iPhone 被打斷後的 interrupted 狀態也要喚醒）
  unlock() {
    try {
      const c = ensureCtx();
      if (!c) return;
      playThroughSilentSwitch();
      if (c.state !== 'running') {
        const p = c.resume();
        if (p && p.then) p.then(syncMusic, () => {});
      } else {
        syncMusic();
      }
    } catch {
      // 不支援就安靜
    }
  },

  // 背景音樂：'menu'（標題、大廳）、'battle'（對戰）、null（停）。聲音還沒解鎖的話，解鎖後自動開始
  music(name) {
    wantSong = name && SONGS[name] ? name : null;
    try {
      syncMusic();
    } catch {
      // 音樂失敗不能影響遊戲
    }
  },

  // 最後 30 秒音樂加快
  musicTempo(scale) {
    tempoScale = scale > 0 ? scale : 1;
  },

  play(name, opts) {
    try {
      if (muted || !ctx || ctx.state !== 'running') return;
      const fn = Object.prototype.hasOwnProperty.call(SOUNDS, name) ? SOUNDS[name] : null;
      if (!fn) return;
      const { volume = 1, pan = 0 } = opts || {};
      const v = clamp(volume, 0, 1, 1);
      if (v <= 0.001) return;
      const now = performance.now();
      if (now - (lastPlayed.get(name) ?? -Infinity) < THROTTLE_MS) return;
      lastPlayed.set(name, now);

      const out = ctx.createGain();
      out.gain.value = v * (GAIN[name] || 1);
      let tail = out;
      const p = clamp(pan, -1, 1, 0);
      if (p && ctx.createStereoPanner) {
        const panner = ctx.createStereoPanner();
        panner.pan.value = p;
        out.connect(panner);
        tail = panner;
      }
      tail.connect(master);
      const len = fn(out, ctx.currentTime + 0.005) || 1;
      // 播完把節點拆掉
      setTimeout(() => {
        try {
          tail.disconnect();
          if (tail !== out) out.disconnect();
        } catch {
          // 已經拆過了
        }
      }, (len + 0.3) * 1000);
    } catch {
      // 音效失敗不能影響遊戲
    }
  },

  toggleMute() {
    muted = !muted;
    saveMuted();
    try {
      if (ctx && master) {
        const t = ctx.currentTime;
        master.gain.cancelScheduledValues(t);
        master.gain.setTargetAtTime(muted ? 0 : MASTER_VOLUME, t, 0.02);
      }
    } catch {
      // 忽略
    }
    return muted;
  },

  get muted() {
    return muted;
  },

  // 正在播的背景音樂（'menu'、'battle' 或 null）
  get song() {
    return songName;
  },
};

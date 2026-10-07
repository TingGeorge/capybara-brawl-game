// 大廳：管理連進來的玩家、隊伍、角色選擇，以及開始/結束對戰。
import { TEAM_SIZE, MAX_HUMANS, KO_TARGET, MATCH_SECONDS, RESULT_SECONDS, DT } from '../shared/constants.js';
import { CHARACTERS, CHAR_BY_ID } from '../shared/characters.js';
import { Match } from './match.js';

const BOT_NAMES = ['阿嚕', '咕嚕', '圓圓', '麻糬', '布丁', '豆花', '芋圓', '湯圓', '飯糰', '奶茶'];

function cleanName(raw) {
  const name = String(raw || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 10);
  return name;
}

export class Lobby {
  constructor({ lanUrls, koTarget = KO_TARGET, duration = MATCH_SECONDS }) {
    this.lanUrls = lanUrls;
    this.koTarget = koTarget;
    this.duration = duration;
    this.clients = new Set();
    this.nextId = 1;
    this.hostId = null;
    this.bots = true;
    this.match = null;
    this.matchInfo = null;
    this.resultTimer = 0;
  }

  get members() {
    return [...this.clients].filter((c) => c.id);
  }

  connect(ws) {
    const client = { ws, id: null, name: '', team: 'blue', charId: 'carrot' };
    this.clients.add(client);
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (msg && typeof msg === 'object') this.onMessage(client, msg);
    });
    ws.on('close', () => this.disconnect(client));
  }

  send(client, obj) {
    client.ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj));
  }

  broadcast(obj) {
    const text = typeof obj === 'string' ? obj : JSON.stringify(obj);
    for (const c of this.members) c.ws.send(text);
  }

  teamCount(team, except) {
    return this.members.filter((c) => c.team === team && c !== except).length;
  }

  onMessage(c, m) {
    if (m.t === 'ping') return this.send(c, { t: 'pong', c: m.c });

    if (m.t === 'hello') {
      if (c.id) return;
      if (this.members.length >= MAX_HUMANS) {
        this.send(c, { t: 'error', msg: '房間已經滿了（最多 6 個人）' });
        return c.ws.close();
      }
      c.id = `p${this.nextId++}`;
      c.name = cleanName(m.name) || `水豚${this.nextId - 1}號`;
      c.charId = CHAR_BY_ID[m.charId] ? m.charId : CHARACTERS[Math.floor(Math.random() * CHARACTERS.length)].id;
      c.team = this.teamCount('blue', c) <= this.teamCount('red', c) ? 'blue' : 'red';
      if (!this.hostId) this.hostId = c.id;
      this.send(c, { t: 'welcome', id: c.id, urls: this.lanUrls() });
      if (this.match) this.send(c, { t: 'start', ...this.matchInfo, spectator: true });
      return this.broadcastLobby();
    }
    if (!c.id) return;

    switch (m.t) {
      case 'pick':
        if (CHAR_BY_ID[m.charId] && !this.isPlaying(c)) {
          c.charId = m.charId;
          this.broadcastLobby();
        }
        break;
      case 'team':
        if ((m.team === 'blue' || m.team === 'red') && !this.isPlaying(c) && this.teamCount(m.team, c) < TEAM_SIZE) {
          c.team = m.team;
          this.broadcastLobby();
        }
        break;
      case 'bots':
        if (c.id === this.hostId) {
          this.bots = !!m.v;
          this.broadcastLobby();
        }
        break;
      case 'start':
        if (c.id === this.hostId && !this.match) this.startMatch(c);
        break;
      case 'in':
        if (this.match) this.match.queueInputs(c.id, m.l, m.a);
        break;
      case 'atk':
      case 'sup':
        if (this.match) this.match.queueAttack(c.id, m.a, m.d, m.t === 'sup');
        break;
    }
  }

  isPlaying(c) {
    return !!(this.match && this.match.players.has(c.id));
  }

  disconnect(c) {
    this.clients.delete(c);
    if (!c.id) return;
    if (this.match && this.match.players.has(c.id)) {
      if (this.members.some((m) => this.match.players.has(m.id))) this.match.makeBot(c.id);
      else this.endMatch();
    }
    if (this.hostId === c.id) this.hostId = this.members[0] ? this.members[0].id : null;
    this.broadcastLobby();
  }

  lobbyState() {
    return {
      t: 'lobby',
      phase: this.match ? 'match' : 'lobby',
      hostId: this.hostId,
      bots: this.bots,
      urls: this.lanUrls(),
      players: this.members.map((c) => ({ id: c.id, name: c.name, team: c.team, charId: c.charId })),
    };
  }

  broadcastLobby() {
    this.broadcast(this.lobbyState());
  }

  startMatch(host) {
    const humans = this.members;
    const roster = humans.map((c) => ({ id: c.id, name: c.name, team: c.team, charId: c.charId, isBot: false }));
    if (this.bots) {
      let n = 1;
      const names = [...BOT_NAMES].sort(() => Math.random() - 0.5);
      for (const team of ['blue', 'red']) {
        const used = new Set(roster.filter((r) => r.team === team).map((r) => r.charId));
        while (roster.filter((r) => r.team === team).length < TEAM_SIZE) {
          const pool = CHARACTERS.filter((ch) => !used.has(ch.id));
          const ch = pool[Math.floor(Math.random() * pool.length)];
          used.add(ch.id);
          roster.push({ id: `b${n}`, name: `${names[n - 1]}（電腦）`, team, charId: ch.id, isBot: true });
          n++;
        }
      }
    }
    const blue = roster.filter((r) => r.team === 'blue').length;
    const red = roster.filter((r) => r.team === 'red').length;
    if (!blue || !red) {
      return this.send(host, { t: 'error', msg: '兩隊都至少要有一隻水豚。可以打開「電腦補位」或請朋友換隊。' });
    }

    this.matchInfo = { players: roster, koTarget: this.koTarget, duration: this.duration };
    this.match = new Match({
      players: roster,
      koTarget: this.koTarget,
      duration: this.duration,
      send: (text) => this.broadcast(text),
    });
    this.resultTimer = 0;
    this.broadcast({ t: 'start', ...this.matchInfo });
    this.broadcastLobby();
  }

  endMatch() {
    this.match = null;
    this.matchInfo = null;
    this.broadcastLobby();
  }

  tick() {
    if (!this.match) return;
    this.match.tick();
    if (this.match.phase !== 'ended') return;
    if (this.resultTimer === 0) this.broadcast({ t: 'result', ...this.match.results() });
    this.resultTimer += DT;
    if (this.resultTimer >= RESULT_SECONDS) this.endMatch();
  }
}

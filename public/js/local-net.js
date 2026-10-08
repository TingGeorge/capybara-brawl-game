// 單人模式的「連線」：不需要伺服器，直接在瀏覽器裡跑大廳和對戰（和伺服器上是同一份程式），
// 所以手機沒有網路、或是網頁放在 GitHub Pages 上也能和電腦水豚打。
// 用法和 net.js 的 Net 一樣，main.js 不用管現在是哪一種。
import { Lobby } from '../shared/lobby.js';
import { DT } from '../shared/constants.js';

export class LocalNet {
  constructor() {
    this.handlers = new Map();
    this.onclose = null;
    this.peer = null;
    this.timer = 0;
  }

  get connected() {
    return !!this.peer;
  }

  connect() {
    if (this.peer) return Promise.resolve();
    const lobby = new Lobby({ solo: true });
    const listeners = { message: [], close: [] };
    // 大廳把這個物件當成一條 WebSocket 連線。兩個方向都延到 microtask 才送，
    // 避免大廳廣播到一半，瀏覽器端又同步送訊息回去。
    const peer = {
      send: (text) => queueMicrotask(() => this.receive(peer, text)),
      close: () => queueMicrotask(() => this.close()),
      on: (type, fn) => listeners[type] && listeners[type].push(fn),
      deliver: (text) => listeners.message.forEach((fn) => fn(text)),
      closed: () => listeners.close.forEach((fn) => fn()),
    };
    this.peer = peer;
    lobby.connect(peer);

    // 和伺服器一樣的固定 60 tick/秒 迴圈；分頁被藏起來時最多補 0.25 秒，等於自動暫停
    let last = performance.now();
    let acc = 0;
    this.timer = setInterval(() => {
      const now = performance.now();
      acc += Math.min(0.25, (now - last) / 1000);
      last = now;
      while (acc >= DT) {
        lobby.tick();
        acc -= DT;
      }
    }, 1000 / 120);
    return Promise.resolve();
  }

  receive(peer, text) {
    if (peer !== this.peer) return;
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    const handler = this.handlers.get(msg.t);
    if (handler) handler(msg);
  }

  on(type, fn) {
    this.handlers.set(type, fn);
  }

  send(obj) {
    const peer = this.peer;
    if (!peer) return;
    const text = JSON.stringify(obj);
    queueMicrotask(() => {
      if (peer === this.peer) peer.deliver(text);
    });
  }

  // 離開單人模式：停掉迴圈，讓大廳把對戰結束（不會觸發 onclose，那是給「意外斷線」用的）
  close() {
    const peer = this.peer;
    if (!peer) return;
    this.peer = null;
    clearInterval(this.timer);
    peer.closed();
  }
}

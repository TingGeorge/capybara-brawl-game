// 和伺服器的 WebSocket 連線（伺服器就是打開這個網頁的那台電腦）
export class Net {
  constructor() {
    this.ws = null;
    this.handlers = new Map();
    this.onclose = null;
  }

  get connected() {
    return !!this.ws && this.ws.readyState <= 1;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/ws`);
      let opened = false;
      this.ws = ws;
      ws.onopen = () => {
        opened = true;
        resolve();
      };
      ws.onerror = () => {
        if (!opened) reject(new Error('連不上伺服器'));
      };
      ws.onmessage = (ev) => {
        let msg;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        const handler = this.handlers.get(msg.t);
        if (handler) handler(msg);
      };
      ws.onclose = () => {
        if (opened && this.onclose) this.onclose();
      };
    });
  }

  on(type, fn) {
    this.handlers.set(type, fn);
  }

  send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  // 自己離開大廳：關掉連線，但不算「意外斷線」，所以不呼叫 onclose
  close() {
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    ws.onclose = null;
    ws.onmessage = null;
    ws.close();
  }
}

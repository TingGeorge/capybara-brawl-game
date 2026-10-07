// 極簡 WebSocket 伺服器（RFC 6455），只用 Node.js 內建模組，
// 這樣房主只要裝 Node.js 就能開伺服器，不用 npm install。
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 1 << 20;

export class WebSocketConnection extends EventEmitter {
  constructor(socket, head) {
    super();
    this.socket = socket;
    this.open = true;
    this.buffer = Buffer.alloc(0);
    this.fragments = null;
    socket.setNoDelay(true);
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('close', () => this.onClose());
    socket.on('error', () => this.onClose());
    if (head && head.length) this.onData(head);
  }

  onData(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    while (this.open) {
      const buf = this.buffer;
      if (buf.length < 2) return;
      const fin = (buf[0] & 0x80) !== 0;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let length = buf[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buf.length < 4) return;
        length = buf.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buf.length < 10) return;
        if (buf.readUInt32BE(2) !== 0) return this.close(1009);
        length = buf.readUInt32BE(6);
        offset = 10;
      }
      if (length > MAX_MESSAGE) return this.close(1009);
      const maskOffset = offset;
      if (masked) offset += 4;
      if (buf.length < offset + length) return;
      let payload = buf.subarray(offset, offset + length);
      if (masked) {
        const mask = buf.subarray(maskOffset, maskOffset + 4);
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      }
      this.buffer = buf.subarray(offset + length);
      this.onFrame(fin, opcode, payload);
    }
  }

  onFrame(fin, opcode, payload) {
    switch (opcode) {
      case 0x0: // 續傳的分段
        if (!this.fragments) return;
        this.fragments.push(payload);
        if (fin) {
          const data = Buffer.concat(this.fragments);
          this.fragments = null;
          this.emit('message', data.toString('utf8'));
        }
        return;
      case 0x1: // 文字
      case 0x2: // 二進位（也當文字處理）
        if (fin) this.emit('message', payload.toString('utf8'));
        else this.fragments = [payload];
        return;
      case 0x8: // 關閉
        this.writeFrame(0x8, payload.subarray(0, 2));
        this.socket.end();
        this.onClose();
        return;
      case 0x9: // ping
        this.writeFrame(0xa, payload);
        return;
      default: // pong 或未知
        return;
    }
  }

  writeFrame(opcode, payload) {
    if (this.socket.destroyed || !this.socket.writable) return;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.from([0x80 | opcode, len]);
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeUInt32BE(0, 2);
      header.writeUInt32BE(len, 6);
    }
    this.socket.write(Buffer.concat([header, payload]));
  }

  send(text) {
    if (!this.open) return;
    // 對方網路卡住時不要一直塞資料
    if (this.socket.writableLength > 4 * MAX_MESSAGE) return;
    this.writeFrame(0x1, Buffer.from(text, 'utf8'));
  }

  close(code = 1000) {
    if (!this.open) return;
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(code, 0);
    this.writeFrame(0x8, payload);
    this.socket.end();
    this.onClose();
  }

  onClose() {
    if (!this.open) return;
    this.open = false;
    this.socket.destroy();
    this.emit('close');
  }
}

export function acceptWebSocket(req, socket, head, onConnection) {
  const key = req.headers['sec-websocket-key'];
  if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return;
  }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  onConnection(new WebSocketConnection(socket, head));
}

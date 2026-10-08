// 水豚大亂鬥伺服器：提供網頁檔案 + WebSocket 連線 + 遊戲迴圈。
// 啟動：node server/index.js（或 npm start），預設埠號 3000，可用 PORT=xxxx 改。
// 想打短一點或長一點的比賽：MATCH_SECONDS=120 KO_TARGET=10 npm start
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acceptWebSocket } from './websocket.js';
import { Lobby } from '../shared/lobby.js';
import { DT } from '../shared/constants.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const SHARED_DIR = path.join(ROOT, 'shared');
const PORT = Number(process.env.PORT) || 3000;
const envNumber = (name) => (Number(process.env[name]) > 0 ? Number(process.env[name]) : undefined);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

export function lanAddresses() {
  const list = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal) list.push(a.address);
    }
  }
  // 家用 Wi-Fi 常見的 192.168.x.x 排前面
  return list.sort((a, b) => Number(b.startsWith('192.168.')) - Number(a.startsWith('192.168.')));
}

function serveStatic(req, res) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  let base = PUBLIC_DIR;
  if (pathname.startsWith('/shared/')) {
    base = SHARED_DIR;
    pathname = pathname.slice('/shared'.length);
  }
  if (pathname === '/') pathname = '/index.html';
  // 沒有寫 <link rel="icon"> 的頁面（例如開發頁），瀏覽器會自己來要 /favicon.ico
  if (pathname === '/favicon.ico') pathname = '/icons/favicon-32.png';
  const file = path.join(base, path.normalize(pathname));
  if (!file.startsWith(base + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('找不到這個檔案');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

export function startServer(port = PORT, { quiet = false, duration = envNumber('MATCH_SECONDS'), koTarget = envNumber('KO_TARGET') } = {}) {
  const lobby = new Lobby({ lanUrls: () => lanAddresses().map((ip) => `http://${ip}:${port}`), duration, koTarget });
  const server = http.createServer(serveStatic);

  server.on('upgrade', (req, socket, head) => {
    if (!req.url.startsWith('/ws')) {
      socket.destroy();
      return;
    }
    acceptWebSocket(req, socket, head, (ws) => lobby.connect(ws));
  });

  // 固定 60 tick/秒 的遊戲迴圈（計時器不準時也會補上落後的 tick）
  let last = performance.now();
  let acc = 0;
  const loop = setInterval(() => {
    const now = performance.now();
    acc += Math.min(0.25, (now - last) / 1000);
    last = now;
    while (acc >= DT) {
      lobby.tick();
      acc -= DT;
    }
  }, 4);

  const stop = () => {
    clearInterval(loop);
    for (const c of lobby.clients) c.ws.close(1001);
    server.close();
  };

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n埠號 ${port} 已經被別的程式用了。可以換一個埠號，例如：\n  PORT=3001 npm start   （Windows PowerShell：$env:PORT=3001; npm start）\n`);
      process.exit(1);
    }
    throw err;
  });

  server.listen(port, '0.0.0.0', () => {
    if (quiet) return;
    const urls = lanAddresses().map((ip) => `http://${ip}:${port}`);
    console.log('\n🐹 水豚大亂鬥伺服器開好了！\n');
    console.log(`  你自己玩：      http://localhost:${port}`);
    if (urls.length) {
      console.log('  朋友（同一個 Wi-Fi）打開：');
      for (const u of urls) console.log(`                  ${u}`);
    } else {
      console.log('  （找不到區域網路位址，請確認電腦有連上 Wi-Fi）');
    }
    console.log('\n  第一次執行時，如果防火牆跳出詢問，請按「允許」，朋友才連得進來。');
    console.log('  按 Ctrl + C 關閉伺服器。\n');
  });

  return { server, lobby, stop };
}

// 直接執行這個檔案時才開伺服器（測試 import 它時不會）。
// Windows 的磁碟代號大小寫、macOS 的 /tmp 捷徑都可能讓路徑字串不一樣，所以比對真實路徑、不分大小寫。
function isMainModule() {
  try {
    const real = (p) => fs.realpathSync(p).toLowerCase();
    return real(process.argv[1]) === real(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) startServer();

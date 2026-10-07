// 用真正的方式（node server/index.js）把伺服器開起來，確認網頁和共用程式碼都拿得到。
// CI 會在 Windows、macOS、Linux 上各跑一次。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 39000 + Math.floor(Math.random() * 500);

test('伺服器能開起來，網頁和遊戲檔案都拿得到', async () => {
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`伺服器 10 秒內沒開好：\n${output}`)), 10000);
      child.stdout.on('data', () => {
        if (output.includes('Ctrl + C')) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.on('exit', (code) => reject(new Error(`伺服器結束了（${code}）：\n${output}`)));
    });
    assert.match(output, new RegExp(`http://localhost:${PORT}`));

    const get = (p) => fetch(`http://127.0.0.1:${PORT}${p}`);
    const home = await get('/');
    assert.equal(home.status, 200);
    assert.match(await home.text(), /水豚大亂鬥/);

    for (const file of ['/js/main.js', '/js/renderer.js', '/shared/characters.js', '/style.css']) {
      const res = await get(file);
      assert.equal(res.status, 200, file);
    }
    assert.match((await get('/js/main.js')).headers.get('content-type'), /javascript/);

    // 不能用 ../ 讀到網頁資料夾以外的檔案
    const sneaky = await get('/%2e%2e/server/index.js');
    assert.notEqual(sneaky.status, 200);
  } finally {
    child.kill();
  }
});

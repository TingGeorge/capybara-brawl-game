// GitHub Pages 用的靜態網站：開發頁不上線、連線對戰關掉、離線需要的檔案都在。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildStatic } from '../scripts/build-static.mjs';

test('靜態網站：只有單人模式，沒有開發頁，離線要用的檔案都在', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'capybrawl-site-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const out = buildStatic(path.join(tmp, 'site'));

  assert.match(fs.readFileSync(path.join(out, 'js', 'config.js'), 'utf8'), /LAN_SERVER = false;/);
  assert.equal(fs.existsSync(path.join(out, 'dev')), false, 'dev/ 開發頁不要放上網站');
  assert.equal(fs.existsSync(path.join(out, '.nojekyll')), true);
  for (const file of ['index.html', 'manifest.webmanifest', 'sw.js', 'shared/match.js', 'js/local-net.js']) {
    assert.equal(fs.existsSync(path.join(out, file)), true, file);
  }

  // service worker 要預先快取的每個檔案，網站上都要有（少一個就整個安裝失敗）
  const sw = fs.readFileSync(path.join(out, 'sw.js'), 'utf8');
  const list = [...sw.match(/const PRECACHE = \[([\s\S]*?)\];/)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.ok(list.length > 10);
  for (const entry of list) {
    const file = entry === './' ? 'index.html' : entry;
    assert.equal(fs.existsSync(path.join(out, file)), true, `網站上缺少 ${entry}`);
  }

  // 原始碼不能被改到（本機的 npm start 還是要能連線對戰）
  assert.match(fs.readFileSync(new URL('../public/js/config.js', import.meta.url), 'utf8'), /LAN_SERVER = true;/);
});

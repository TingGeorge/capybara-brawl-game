// 把遊戲整理成「純靜態網站」：public/（不含 dev/ 開發頁）+ shared/，
// 而且關掉連線對戰（js/config.js 的 LAN_SERVER 改成 false），只留單人模式。
// GitHub Pages 的部署流程和瀏覽器測試都用這支程式，確保兩邊一模一樣。
// 用法：node scripts/build-static.mjs [輸出資料夾，預設 _site]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function buildStatic(outDir = path.join(ROOT, '_site')) {
  const out = path.resolve(outDir);
  fs.rmSync(out, { recursive: true, force: true });
  fs.cpSync(path.join(ROOT, 'public'), out, {
    recursive: true,
    filter: (src) => path.relative(path.join(ROOT, 'public'), src).split(path.sep)[0] !== 'dev',
  });
  fs.cpSync(path.join(ROOT, 'shared'), path.join(out, 'shared'), { recursive: true });

  const config = path.join(out, 'js', 'config.js');
  const before = fs.readFileSync(config, 'utf8');
  const after = before.replace('export const LAN_SERVER = true;', 'export const LAN_SERVER = false;');
  if (after === before) throw new Error('js/config.js 裡找不到 LAN_SERVER = true，沒辦法關掉連線對戰');
  fs.writeFileSync(config, after);

  // 告訴 GitHub Pages 不要用 Jekyll 處理檔案
  fs.writeFileSync(path.join(out, '.nojekyll'), '');
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = buildStatic(process.argv[2]);
  console.log(`靜態網站已輸出到 ${out}`);
}

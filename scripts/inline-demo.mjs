// デモ版のビルド結果を 1 枚の HTML にまとめる（照明なしで画面を試すためのページ）。
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// 引数 web のときはウェブ体験版（dist/web/miseru-web.html）を作る
const kind = process.argv[2] === 'web' ? 'web' : 'demo';
const dir = `dist/${kind}`;
let html = readFileSync(join(dir, 'index.html'), 'utf8');
html = html.replace(/<link rel="stylesheet"[^>]*href="\.?\/?([^"]+)"[^>]*>/g, (_, href) => `<style>${readFileSync(join(dir, href), 'utf8')}</style>`);
html = html.replace(/<script type="module"[^>]*src="\.?\/?([^"]+)"[^>]*><\/script>/g, (_, src) => {
  const code = readFileSync(join(dir, src), 'utf8').replace(/<\/script/gi, '<\\/script');
  return `<script type="module">${code}</script>`;
});
// 1 枚の HTML が外のファイル（ロゴの絵など）を読もうとしていたら止める。
// ロゴの SVG が埋まらず、1 枚の HTML でロゴが欠けないようにするため
const left = readdirSync(join(dir, 'assets')).filter((f) => !/\.(js|css)$/.test(f) && html.includes(f));
if (left.length) {
  console.error(`1 枚の HTML が外のファイルを読もうとしています: ${left.join(', ')}（vite.config.ts の assetsInlineLimit を確かめる）`);
  process.exit(1);
}
writeFileSync(join(dir, `miseru-${kind}.html`), html);
console.log(`${join(dir, `miseru-${kind}.html`)} (${Math.round(html.length / 1024)} KB)`);

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// 画面に出す版の番号: package.json の version と git のコミット（取れなければ空）
const version = (JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }).version;
let commit = '';
try {
  commit = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
} catch {
  // git の外でビルドしたときは版の番号だけ出す
}

export default defineConfig(({ mode }) => ({
  root: 'src/ui',
  define: {
    __APP_VERSION__: JSON.stringify(version),
    __APP_COMMIT__: JSON.stringify(commit),
  },
  plugins: [react()],
  // デモ版・ウェブ体験版は 1 枚の HTML にするので、ロゴなどの絵も中に埋める（外のファイルを読まない）
  build: { outDir: '../../dist/ui', emptyOutDir: true, ...(mode === 'demo' || mode === 'web' ? { assetsInlineLimit: 100_000_000 } : {}) },
  server: {
    proxy: {
      '/api': 'http://localhost:8080',
      '/ws': { target: 'ws://localhost:8080', ws: true },
    },
  },
}));

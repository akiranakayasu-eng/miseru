import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';
import './devCheck';

// 箱では使わない画面の CSS（箱のビルドは容量の上限が近いので、styles.css に足さず、ここで足す。箱のビルドではこの分が消える）
if (import.meta.env.MODE !== 'box') {
  const css = document.createElement('style');
  // スマホでは 3D の左上の段が 3 行になって照明を隠したので、Lens と Bright のつまみを隠して数字だけにし、2 行に収める。数字を押せば打ち込める
  css.textContent = "@container (max-width: 520px) { #root .v3d-bottom .v3d-lens input[type='range'] { display: none; } }";
  document.head.append(css);
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { applyFxAll, fxNow, hasFx } from '../../engine/effects.js';
import type { Patch, ShowState } from '../../engine/show.js';
import type { PatchedLight } from '../../engine/show.js';
import { sceneStore, useSceneStore } from '../sceneStore';
import { ScenePanel } from './ScenePanel';
import { camFor, createView, placeLights, sceneLightOf, setRoom, type CamView, type LightIn, type View3D } from '../studio3d';
import { displayRgb, FIXED_WHITE, isWhiteOnly } from './colors';

interface Props {
  patch: Patch;
  state: ShowState;
}

/**
 * スタジオを 3D で見る（2026-11-21 Akira さんの依頼。Blender ではなく miseru の中で）。
 * どの照明がどこを何色で照らすかが分かる程度で、写実ではない。ドラッグで回す、ホイールか 2 本指で寄る。
 */
// 視点とレンズは画面を移っても覚えておく（部品が消えて作り直されても続きから。2026-11-21 Akira さんの指摘）
const kept: { cam: { yaw: number; pitch: number; dist: number; tgt: number[] } | null; lens: number } = { cam: null, lens: 24 };
// 画面としての明るさ（照明の効果の見え方だけ。ディスプレイの明るさのように。2026-11-22 Akira さん）。ブラウザごとに覚える
const EXPO_KEY = 'miseru.v3dExposure';
const readExpo = () => {
  try {
    const v = Number(localStorage.getItem(EXPO_KEY));
    return v >= 0.5 && v <= 4 ? v : 1;
  } catch {
    return 1;
  }
};

const isFloor = (l: PatchedLight) => l.group === 'Floor PAR' || l.typeId === 'dimmer-1ch';

export function Studio3D({ patch, state }: Props) {
  // Solid: 照明の効果を切って形と置き場所を見ながら、スタジオを設定する（2026-11-22 Akira さん）
  const { scene, solid, setup } = useSceneStore();
  const [expo, setExpoState] = useState(readExpo);
  const setExpo = (v: number) => {
    try {
      localStorage.setItem(EXPO_KEY, String(v));
    } catch {
      // 覚えられなくても効く
    }
    setExpoState(v);
  };
  const expoRef = useRef(expo);
  expoRef.current = expo;
  const sceneRef = useRef(scene);
  sceneRef.current = scene;
  const solidRef = useRef(solid);
  solidRef.current = solid;
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewRef = useRef<View3D | null>(null);
  const [failed, setFailed] = useState(false);
  // レンズの焦点距離（フルサイズ換算 15〜80mm、2026-11-21 Akira さんの指示）。縦の画角は 24mm の高さで決める
  const [lens, setLensState] = useState(kept.lens);
  const setLens = (mm: number) => {
    kept.lens = mm;
    setLensState(mm);
  };
  // 照明番号の札の表示・非表示（2026-11-21 Akira さんの指示）。ブラウザごとに覚える
  const [showNums, setShowNums] = useState(() => {
    try {
      return localStorage.getItem('miseru.v3dNumbers') !== '0';
    } catch {
      return true;
    }
  });
  // 人の表示・非表示（2026-11-22 Akira さん）。ブラウザごとに覚える
  const [showPeople, setShowPeople] = useState(() => {
    try {
      return localStorage.getItem('miseru.v3dPeople') !== '0';
    } catch {
      return true;
    }
  });
  // 部屋の寸法（W・D・H）の表示・非表示（2026-11-22 Akira さん）。ブラウザごとに覚える
  const [showDims, setShowDims] = useState(() => {
    try {
      return localStorage.getItem('miseru.v3dDims') !== '0';
    } catch {
      return true;
    }
  });
  const showDimsRef = useRef(showDims);
  showDimsRef.current = showDims;
  const toggleDims = () => {
    try {
      localStorage.setItem('miseru.v3dDims', showDims ? '0' : '1');
    } catch {
      // 覚えられなくても切り替えは効く
    }
    setShowDims(!showDims);
  };
  // 表示の切り替えとカメラの向きは、Blender の Overlays のようにメニューへまとめる（2026-11-22 Akira さん）
  const [menu, setMenu] = useState<'view' | 'overlays' | null>(null);
  useEffect(() => {
    if (!menu) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !(e.target as Element).closest?.('.v3d-menu-wrap')) setMenu(null);
    };
    window.addEventListener('pointerdown', close, true);
    window.addEventListener('keydown', close, true);
    return () => {
      window.removeEventListener('pointerdown', close, true);
      window.removeEventListener('keydown', close, true);
    };
  }, [menu]);
  const showPeopleRef = useRef(showPeople);
  showPeopleRef.current = showPeople;
  const togglePeople = () => {
    try {
      localStorage.setItem('miseru.v3dPeople', showPeople ? '0' : '1');
    } catch {
      // 覚えられなくても切り替えは効く
    }
    setShowPeople(!showPeople);
  };
  const toggleNums = () => {
    setShowNums((on) => {
      try {
        localStorage.setItem('miseru.v3dNumbers', on ? '0' : '1');
      } catch {
        // 覚えられなくても切り替えは効く
      }
      return !on;
    });
  };
  useEffect(() => {
    const v = viewRef.current;
    if (!v) return;
    v.cam.fov = 2 * Math.atan(12 / lens);
    drawRef.current();
  }, [lens, failed, showNums, showPeople, showDims]);
  // 決まった向きへカメラを動かす（Home・Top・Front・Right・Left・Back、2026-11-22 Akira さん）
  const goView = (view: CamView) => {
    const v = viewRef.current, canvas = canvasRef.current;
    if (!v || !canvas) return;
    const r = canvas.getBoundingClientRect();
    const asp = r.width > 0 && r.height > 0 ? r.width / r.height : 1.6;
    const room = sceneRef.current.room;
    setRoom(room.w, room.d, room.h);
    Object.assign(v.cam, camFor(view, v.cam.fov, asp));
    drawRef.current();
  };
  const stateRef = useRef(state);
  stateRef.current = state;
  const lightsRef = useRef(patch.lights);
  lightsRef.current = patch.lights;

  // 今の状態で描く（番号の札も動かす）
  const drawRef = useRef(() => {});
  drawRef.current = () => {
    const v = viewRef.current;
    if (!v) return;
    const st = stateRef.current;
    const lights = lightsRef.current.filter((l) => l.position);
    const looks = hasFx(st.looks) ? applyFxAll(lights, st.looks, fxNow()) : st.looks;
    const sc = sceneRef.current;
    v.setScene(showPeopleRef.current ? sc : { ...sc, people: [] });
    v.setLights(
      placeLights(
        lights.map((l): LightIn => {
          const look = looks[l.id];
          const on = st.blackout || !look ? 0 : look.intensity * st.master;
          return {
            x: l.position!.x,
            y: l.position!.y,
            panel: l.shape?.kind === 'panel',
            floor: isFloor(l),
            rgb: isWhiteOnly(l.typeId) || !look ? FIXED_WHITE : displayRgb(look),
            k: on,
            set: sc.lights[l.id],
          };
        }),
      ),
    );
    v.draw({ solid: solidRef.current, exposure: expoRef.current });
    const wrap = wrapRef.current;
    if (!wrap) return;
    // 描く画素と画面の点の比（canvas は devicePixelRatio を 2 までに抑えているので、window の値は使わない。
    // 2026-11-22 チェックの指摘: iPhone（3x）で番号が照明からずれた）
    const cv = canvasRef.current;
    const dpr = cv && cv.clientWidth > 0 ? cv.width / cv.clientWidth : 1;
    // 左上のカメラのボタンに重なる札は、ボタンの下へ寄せる
    const vb = wrap.querySelector<HTMLElement>('.v3d-bottom');
    const vbR = vb ? vb.offsetLeft + vb.offsetWidth : 0, vbB = vb ? vb.offsetTop + vb.offsetHeight : 0;
    // 近い照明の札が重ならないよう、前に置いた札と 16px 以内なら上へずらす（2026-11-22 チェックの指摘）
    const placed: [number, number][] = [];
    v.lights().forEach((l, i) => {
      const tag = wrap.querySelector<HTMLElement>(`[data-v3d-n="${i}"]`);
      if (!tag) return;
      const q = v.project([l.pos[0], l.pos[1] + 0.32, l.pos[2]]);
      tag.style.display = q ? '' : 'none';
      // 枠の端で切れないよう、札は枠の内側に寄せる（灯体が枠の外なら隠す）
      if (!q) return;
      const W = wrap.clientWidth, H = wrap.clientHeight, x = q[0] / dpr, y = q[1] / dpr;
      const out = x < -20 || y < -20 || x > W + 20 || y > H + 20;
      tag.style.display = out ? 'none' : '';
      const tx = Math.min(W - 10, Math.max(10, x));
      let ty = Math.min(H - 10, Math.max(10, y));
      // カメラのボタンの下へ寄せ、ほかの札と重なれば下へずらす（上へずらすとボタンに隠れた。2026-11-22 チェックの指摘）
      for (let k = 0; k < 5; k++) {
        if (tx < vbR + 10 && ty < vbB + 10) ty = vbB + 10;
        if (!placed.some(([a, c]) => Math.abs(a - tx) < 16 && Math.abs(c - ty) < 16)) break;
        ty += 17;
      }
      placed.push([tx, ty]);
      tag.style.transform = `translate(${tx}px, ${ty}px) translate(-50%, -50%)`;
    });
    // 部屋の寸法: W は奥の壁の床の辺、D は右の床の辺、H は奥の左の角（2026-11-22 Akira さん）
    const { w: rw, d: rd, h: rh } = sc.room, rb = -0.4533 * rd;
    const dims: [string, [number, number, number], [number, number, number]][] = [
      ['w', [-rw / 2, 0, rb], [rw / 2, 0, rb]],
      ['d', [rw / 2, 0, rb], [rw / 2, 0, rb + rd]],
      ['h', [-rw / 2, 0, rb], [-rw / 2, rh, rb]],
    ];
    for (const [k, a, b] of dims) {
      const g = wrap.querySelector<SVGGElement>(`[data-v3d-dim="${k}"]`);
      if (!g) continue;
      const p = v.project(a), q = v.project(b);
      g.style.display = p && q ? '' : 'none';
      if (!p || !q) continue;
      const [x1, y1, x2, y2] = [p[0] / dpr, p[1] / dpr, q[0] / dpr, q[1] / dpr];
      const ln = g.querySelector('line')!, tx = g.querySelector('text')!;
      // 文字は、線のうち枠に入っている部分の真ん中に置く（手前の辺は枠の外へ伸びることがある）
      const W = wrap.clientWidth, H = wrap.clientHeight, ddx = x2 - x1, ddy = y2 - y1;
      let t0 = 0, t1 = 1;
      for (const [pp, qq] of [[-ddx, x1 - 8], [ddx, W - 8 - x1], [-ddy, y1 - 8], [ddy, H - 8 - y1]]) {
        if (pp === 0) {
          if (qq < 0) t1 = -1;
        } else if (pp < 0) t0 = Math.max(t0, qq / pp);
        else t1 = Math.min(t1, qq / pp);
      }
      g.style.display = t0 < t1 ? '' : 'none';
      const tm = (t0 + t1) / 2;
      ln.setAttribute('x1', String(x1));
      ln.setAttribute('y1', String(y1));
      ln.setAttribute('x2', String(x2));
      ln.setAttribute('y2', String(y2));
      tx.setAttribute('x', String(x1 + ddx * tm));
      tx.setAttribute('y', String(y1 + ddy * tm - 4));
    }
  };

  useEffect(() => {
    const canvas = canvasRef.current!;
    let v: View3D | null = null;
    try {
      v = createView(canvas);
    } catch {
      v = null;
    }
    if (!v) {
      setFailed(true);
      return;
    }
    viewRef.current = v;
    v.cam.fov = 2 * Math.atan(12 / lens);
    if (kept.cam) Object.assign(v.cam, { ...kept.cam, tgt: [...kept.cam.tgt] });
    else goView('home');
    const fit = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const r = canvas.getBoundingClientRect();
      const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      drawRef.current();
    };
    const ro = new ResizeObserver(fit);
    ro.observe(canvas);
    fit();

    // ドラッグで回す、ホイール・2 本指で寄る
    const pts = new Map<number, [number, number]>();
    let pinch = 0;
    let panning = false;
    const down = (e: PointerEvent) => {
      // ホイールを押してのドラッグは移動（ブラウザの自動スクロールを止める）
      if (e.button === 1) e.preventDefault();
      panning = e.button === 1 || e.shiftKey;
      canvas.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, [e.clientX, e.clientY]);
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        pinch = Math.hypot(a[0] - b[0], a[1] - b[1]);
      }
    };
    const move = (e: PointerEvent) => {
      const p = pts.get(e.pointerId);
      if (!p || !v) return;
      if (pts.size === 1) {
        if (panning || e.shiftKey) v.pan(e.clientX - p[0], e.clientY - p[1]);
        else {
          v.cam.yaw -= (e.clientX - p[0]) * 0.008;
          // ローアングル（下から見上げる）まで回せる
          v.cam.pitch = Math.min(1.45, Math.max(-0.45, v.cam.pitch + (e.clientY - p[1]) * 0.006));
        }
      }
      const before = pts.size === 2 ? [...pts.values()] : null;
      pts.set(e.pointerId, [e.clientX, e.clientY]);
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        // 2 本指: 開く・閉じるで寄る、そろって動かすと移動
        if (before) v.pan(((a[0] + b[0]) - (before[0][0] + before[1][0])) / 2, ((a[1] + b[1]) - (before[0][1] + before[1][1])) / 2);
        const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
        if (pinch > 0) v.cam.dist = Math.min(18, Math.max(2.5, v.cam.dist * (pinch / d)));
        pinch = d;
      }
      drawRef.current();
    };
    const up = (e: PointerEvent) => {
      pts.delete(e.pointerId);
      pinch = 0;
      panning = false;
    };
    // ホイールボタンの押し込みで出る自動スクロールを止める
    const aux = (e: MouseEvent) => {
      if (e.button === 1) e.preventDefault();
    };
    const wheel = (e: WheelEvent) => {
      if (!v) return;
      e.preventDefault();
      v.cam.dist = Math.min(18, Math.max(2.5, v.cam.dist * Math.exp(e.deltaY * 0.0015)));
      drawRef.current();
    };
    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('wheel', wheel, { passive: false });
    canvas.addEventListener('mousedown', aux);
    return () => {
      ro.disconnect();
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('pointercancel', up);
      canvas.removeEventListener('wheel', wheel);
      canvas.removeEventListener('mousedown', aux);
      if (v) kept.cam = { yaw: v.cam.yaw, pitch: v.cam.pitch, dist: v.cam.dist, tgt: [...v.cam.tgt] };
      v?.dispose();
      viewRef.current = null;
    };
  }, []);

  // 状態が変わったら描き直す。演出の間は 30 回/秒
  const fxActive = hasFx(state.looks);
  useEffect(() => {
    drawRef.current();
    if (!fxActive) return;
    let raf = 0;
    let last = 0;
    const tick = (ms: number) => {
      if (ms - last >= 33) {
        last = ms;
        drawRef.current();
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [state, patch, fxActive, scene, solid, expo]);

  const shown = patch.lights.filter((l) => l.position);
  return (
    <div className="v3d" ref={wrapRef}>
      <canvas ref={canvasRef} className="v3d-canvas" title="Drag: rotate · Shift-drag / wheel-drag: move · Wheel: zoom" />
      {showNums && shown.map((l, i) => (
        <span key={l.id} className="v3d-num" data-v3d-n={i}>
          {l.number ?? i + 1}
        </span>
      ))}
      {showDims && !failed && (
        <svg className="v3d-dims" aria-hidden="true">
          {(
            [
              ['w', `W ${scene.room.w} m`],
              ['d', `D ${scene.room.d} m`],
              ['h', `H ${scene.room.h} m`],
            ] as const
          ).map(([k, t]) => (
            <g key={k} data-v3d-dim={k}>
              <line />
              <text>{t}</text>
            </g>
          ))}
        </svg>
      )}
      {failed ? (
        <p className="v3d-msg">3D view is not available on this device.</p>
      ) : (
        <>
          {/* 3D の操作はすべて左上に 1 段でまとめる（2026-11-22 Akira さん）。class 名は前のまま v3d-bottom */}
          <div className="v3d-bottom">
          {/* カメラの決まった向き（2026-11-22 Akira さん）。View のメニューにまとめる */}
          <div className="v3d-menu-wrap">
            <button className={menu === 'view' ? 'v3d-solid on' : 'v3d-solid'} aria-expanded={menu === 'view'} aria-haspopup="menu" onClick={() => setMenu(menu === 'view' ? null : 'view')} title="Camera: Home, Top, Front, Right, Left, Back">
              View ▾
            </button>
            {menu === 'view' && (
              <div className="v3d-menu" role="menu" aria-label="Camera">
                {(
                  [
                    ['home', 'Home', 'From the front, at an angle'],
                    ['top', 'Top', 'From above'],
                    ['front', 'Front', 'From the front'],
                    ['right', 'Right', 'From the right side'],
                    ['left', 'Left', 'From the left side'],
                    ['back', 'Back', 'From behind'],
                  ] as [CamView, string, string][]
                ).map(([k, name, tip]) => (
                  <button
                    key={k}
                    role="menuitem"
                    className="v3d-menu-item"
                    onClick={() => {
                      goView(k);
                      setMenu(null);
                    }}
                  >
                    {name}
                    <span className="v3d-menu-sub">{tip}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          {/* 文字を押すと既定に戻し、数字を押すと打ち込める（2026-11-22 Akira さん） */}
          <div className="v3d-lens" style={{ '--fill': `${((lens - 15) / 65) * 100}%` } as CSSProperties}>
            <button className="v3d-lens-label" onClick={() => setLens(24)} title="Back to 24 mm">
              Lens
            </button>
            <input type="range" min={15} max={80} step={1} value={lens} aria-label="Lens focal length (mm)" onChange={(e) => setLens(Number(e.target.value))} />
            <NumVal v={lens} lo={15} hi={80} step={1} show={`${lens} mm`} label="Lens (mm)" set={setLens} />
          </div>
          {!solid && (
            <div className="v3d-lens v3d-bright" style={{ '--fill': `${((expo - 0.5) / 3.5) * 100}%` } as CSSProperties} title="Brightness of the light effects on screen (does not change the real lights)">
              <button className="v3d-lens-label" onClick={() => setExpo(1)} title="Back to ×1.0">
                Bright
              </button>
              <input type="range" min={0.5} max={4} step={0.1} value={expo} aria-label="Screen brightness of the light effects" onChange={(e) => setExpo(Number(e.target.value))} />
              <NumVal v={expo} lo={0.5} hi={4} step={0.1} show={`×${expo.toFixed(1)}`} label="Bright (×)" set={setExpo} />
            </div>
          )}
          {/* 画面に重ねて出すもの（番号・人・寸法）を Overlays にまとめる（Blender と同じ考え方、2026-11-22 Akira さん） */}
          <div className="v3d-menu-wrap">
            <button className={menu === 'overlays' ? 'v3d-solid on' : 'v3d-solid'} aria-expanded={menu === 'overlays'} aria-haspopup="menu" onClick={() => setMenu(menu === 'overlays' ? null : 'overlays')} title="Overlays: what to show on the 3D view">
              Overlays ▾
            </button>
            {menu === 'overlays' && (
              <div className="v3d-menu" role="menu" aria-label="Overlays">
                <label className="v3d-menu-check">
                  <input type="checkbox" role="menuitemcheckbox" checked={showNums} onChange={toggleNums} /> Fixture numbers
                </label>
                <label className="v3d-menu-check">
                  <input type="checkbox" role="menuitemcheckbox" checked={showPeople} onChange={togglePeople} /> People
                </label>
                <label className="v3d-menu-check">
                  <input type="checkbox" role="menuitemcheckbox" checked={showDims} onChange={toggleDims} /> Room size (W · D · H)
                </label>
                <p className="v3d-menu-note">Drag: rotate · Shift-drag / wheel-drag: move · Wheel: zoom</p>
              </div>
            )}
          </div>
          {/* Solid / Render の切り替え（2026-11-22 Akira さん）。Render が照明の効果の見え方、Solid が形と置き場所の設定 */}
          <div className="v3d-mode" role="group" aria-label="View">
            <button className={solid ? 'v3d-solid on' : 'v3d-solid'} aria-pressed={solid} onClick={() => sceneStore.setSolid(true)} title="Solid: see the shapes and places">
              Solid
            </button>
            <button className={solid ? 'v3d-solid' : 'v3d-solid on'} aria-pressed={!solid} onClick={() => sceneStore.setSolid(false)} title="Render: see the light">
              Render
            </button>
          </div>
          {/* Setup: 左の天井図とスタジオの設定を入れ替える（2026-11-22 Akira さん） */}
          <button className={setup ? 'v3d-solid v3d-setup on' : 'v3d-solid v3d-setup'} aria-pressed={setup} onClick={() => sceneStore.setSetup(!setup)} title="Setup: set up the room, lights and people (swaps with the ceiling view)">
            Setup
          </button>
          </div>
        </>
      )}
    </div>
  );
}

/** 設定の欄（天井図の場所か、狭い画面では 3D の下に出す） */
export function StudioSetup({ patch, onClose }: { patch: Patch; onClose?: () => void }) {
  const { scene, sel } = useSceneStore();
  const shown = patch.lights.filter((l) => l.position);
  // 各灯の今の置き方（設定が無ければ既定の置き方から作る）
  const rows = placeLights(shown.map((l) => ({ x: l.position!.x, y: l.position!.y, panel: l.shape?.kind === 'panel', floor: isFloor(l), rgb: [0, 0, 0], k: 0, set: scene.lights[l.id] }))).map((L, i) => ({
    id: shown[i].id,
    num: shown[i].number ?? i + 1,
    cur: scene.lights[shown[i].id] ?? sceneLightOf(L),
  }));
  return <ScenePanel scene={scene} lights={rows} sel={sel} onSel={sceneStore.setSel} onChange={sceneStore.setScene} onReset={sceneStore.reset} onClose={onClose} />;
}

/** 数字の表示。押すと欄になって打ち込める（Enter か離れたときに決める、Esc でやめる） */
function NumVal({ v, lo, hi, step, show, label, set }: { v: number; lo: number; hi: number; step: number; show: string; label: string; set: (v: number) => void }) {
  const [txt, setTxt] = useState<string | null>(null);
  if (txt === null)
    return (
      <button className="v3d-lens-value" onClick={() => setTxt(String(v))} title="Type a value">
        {show}
      </button>
    );
  const done = () => {
    const n = Number(txt);
    if (txt.trim() !== '' && Number.isFinite(n)) set(Number((Math.round(Math.min(hi, Math.max(lo, n)) / step) * step).toFixed(2)));
    setTxt(null);
  };
  return (
    <input
      className="v3d-lens-edit"
      type="number"
      inputMode="decimal"
      autoFocus
      onFocus={(e) => e.target.select()}
      min={lo}
      max={hi}
      step={step}
      value={txt}
      aria-label={label}
      onChange={(e) => setTxt(e.target.value)}
      onBlur={done}
      onKeyDown={(e) => {
        if (e.key === 'Enter') done();
        if (e.key === 'Escape') setTxt(null);
      }}
    />
  );
}

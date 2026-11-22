import { useEffect, useRef, useState, type CSSProperties, type RefObject, type PointerEvent as RPointerEvent } from 'react';
import { aimDir, aimTo, type AimAt, type Scene, type SceneLight, type ScenePerson } from '../studio3d';

/**
 * Solid 表示のときに出す、スタジオの設定。
 * 平面図で照明と人を動かし、部屋の広さ・照明の向け先と向き・ビーム角・ぼかし・人の種類と姿勢を決める。
 * 照明の向きは「向け先を選ぶ（人・床・壁 4 面）→ Pan と Tilt で細かく直す」の順。
 */
export interface SceneLightRow {
  id: string;
  num: number | string;
  cur: SceneLight; // 今の置き方（設定が無ければ既定の置き方から作ったもの）
}
interface Props {
  scene: Scene;
  lights: SceneLightRow[];
  sel: string | null; // 'L:<id>' か 'P:<番号>'
  onSel: (s: string | null) => void;
  onChange: (sc: Scene) => void;
  onReset: () => void;
  onClose?: () => void; // 2 画面で 3D の代わりに出しているとき、3D へ戻る
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const r2 = (v: number) => Math.round(v * 100) / 100;

export function ScenePanel({ scene, lights, sel, onSel, onChange, onReset, onClose }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<string | null>(null);
  const { w, d, h } = scene.room;
  const back = -0.4533 * d; // 奥の壁（studio3d の setRoom と同じ決め方）
  const pad = 0.42; // 外の寸法（W・D）の文字が切れない余白
  // 平面図はマウスホイールでズーム。箱の画面には入れない（容量のため）
  // 箱のビルドでは呼ばない（MODE はビルドで定数になるので、毎回同じ順で呼ばれる。中身ごとビルドから消える）
  const zoomBox = import.meta.env.MODE === 'box' ? null : usePlanZoom(svgRef, -w / 2 - pad, back - pad, w + pad * 2, d + pad * 2);

  const setLight = (id: string, v: SceneLight) => onChange({ ...scene, lights: { ...scene.lights, [id]: v } });
  const setPerson = (i: number, v: ScenePerson) => onChange({ ...scene, people: scene.people.map((p, k) => (k === i ? v : p)) });

  // 平面図の上の位置（m）
  const toPlan = (e: RPointerEvent) => {
    const svg = svgRef.current!;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const q = pt.matrixTransform(svg.getScreenCTM()!.inverse());
    return [clamp(q.x, -w / 2 + 0.1, w / 2 - 0.1), clamp(q.y, back + 0.1, back + d - 0.1)];
  };
  const start = (key: string) => (e: RPointerEvent) => {
    e.stopPropagation();
    onSel(key);
    drag.current = key;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };
  const move = (e: RPointerEvent) => {
    const k = drag.current;
    if (!k) return;
    const [x, z] = toPlan(e).map(r2);
    if (k.startsWith('L:')) {
      const row = lights.find((l) => l.id === k.slice(2));
      if (row) setLight(row.id, { ...row.cur, x, z });
    } else {
      const i = Number(k.slice(2));
      setPerson(i, { ...scene.people[i], x, z });
    }
  };
  const end = () => {
    drag.current = null;
  };

  const selLight = sel?.startsWith('L:') ? lights.find((l) => l.id === sel.slice(2)) : undefined;
  const selPi = sel?.startsWith('P:') ? Number(sel.slice(2)) : -1;
  const selPerson = selPi >= 0 ? scene.people[selPi] : undefined;

  // 部屋の広さを変えたら、外に出た照明と人を部屋の中へ戻す（照明の高さは天井まで）
  const room = (k: 'w' | 'd' | 'h', v: number, lo: number, hi: number) => {
    if (!Number.isFinite(v)) return;
    const rm = { ...scene.room, [k]: r2(clamp(v, lo, hi)) };
    const b2 = -0.4533 * rm.d;
    const inX = (x: number, m: number) => r2(clamp(x, -rm.w / 2 + m, rm.w / 2 - m));
    const inZ = (z: number, m: number) => r2(clamp(z, b2 + m, b2 + rm.d - m));
    const ls = { ...scene.lights };
    for (const l of lights) {
      const c = l.cur;
      const n = { ...c, x: inX(c.x, 0.1), z: inZ(c.z, 0.1), h: Math.min(c.h, rm.h) };
      if (scene.lights[l.id] || n.x !== c.x || n.z !== c.z || n.h !== c.h) ls[l.id] = n;
    }
    const people = scene.people.map((p) => ({ ...p, x: inX(p.x, 0.3), z: inZ(p.z, 0.3) }));
    onChange({ ...scene, room: rm, lights: ls, people });
  };
  const addPerson = () => {
    if (scene.people.length >= 6) return;
    const n = scene.people.length;
    // 新しい人は今の人と重ならない所に（被写体の左右、その前）
    const spots = [[-0.9, -0.35], [0.9, -0.35], [-0.5, 0.6], [0.5, 0.6], [0, 1.4], [-1.4, 0.6], [1.4, 0.6]];
    const free = spots.find(([x, z]) => scene.people.every((p) => Math.hypot(p.x - x, p.z - z) > 0.5)) ?? [0, 0.6];
    onChange({ ...scene, people: [...scene.people, { x: clamp(free[0], -w / 2 + 0.3, w / 2 - 0.3), z: clamp(free[1], back + 0.3, back + d - 0.3), pose: 'stand', kind: 'adult', wear: 'dark' }] });
    onSel(`P:${n}`);
  };
  const aim = (at: AimAt) => selLight && setLight(selLight.id, aimTo(selLight.cur, at, scene.people));

  const slider = (label: string, id: string, v: number, lo: number, hi: number, step: number, unit: string, set: (v: number) => void) => (
    <label className="sc-row" htmlFor={id}>
      <span>{label}</span>
      <input id={id} type="range" min={lo} max={hi} step={step} value={v} {...(import.meta.env.MODE !== 'box' && { style: { '--fill': `${((v - lo) / (hi - lo)) * 100}%` } as CSSProperties })} onChange={(e) => set(Number(e.target.value))} />
      <output>
        {v}
        {unit}
      </output>
    </label>
  );

  return (
    <div className="sc-panel" onPointerDown={(e) => e.stopPropagation()}>
      <div className="sc-head">
        <strong>Studio Setup</strong>
        <button className="sc-btn" onClick={onReset} title="Back to the default room, lights and person">
          Reset
        </button>
        {onClose && (
          <button className="sc-btn sc-close" onClick={onClose} title="Close the setup and show the 3D view again">
            Back to 3D
          </button>
        )}
      </div>

      <div className="sc-room">
        {(
          [
            ['w', 'W', 2, 20],
            ['d', 'D', 2, 20],
            ['h', 'H', 2, 8],
          ] as const
        ).map(([k, lab, lo, hi]) => (
          <label key={k} htmlFor={`sc-room-${k}`}>
            {lab}
            <RoomInput id={`sc-room-${k}`} lo={lo} hi={hi} value={scene.room[k]} onCommit={(v) => room(k, v, lo, hi)} />
            m
          </label>
        ))}
      </div>

      <div className="sc-body">
      <div className="sc-planbox">
      {/* 平面図で重なっても選べるよう、照明と人の番号を並べる */}
      <div className="sc-pick" role="group" aria-label="Select a light or person">
        {lights.map((l) => (
          <button key={l.id} className={sel === `L:${l.id}` ? 'sc-btn sc-pick-l on' : 'sc-btn sc-pick-l'} aria-pressed={sel === `L:${l.id}`} onClick={() => onSel(`L:${l.id}`)}>
            {l.num}
          </button>
        ))}
        {scene.people.map((_, i) => (
          <button key={`P${i}`} className={sel === `P:${i}` ? 'sc-btn sc-pick-p on' : 'sc-btn sc-pick-p'} aria-pressed={sel === `P:${i}`} onClick={() => onSel(`P:${i}`)}>
            P{i + 1}
          </button>
        ))}
      </div>
      {/* 平面図（上が奥の壁、下が手前）。照明は丸と向きの線、人は四角 */}
      <svg
        ref={svgRef}
        className="sc-plan"
        viewBox={zoomBox ?? `${-w / 2 - pad} ${back - pad} ${w + pad * 2} ${d + pad * 2}`}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
        onPointerDown={() => onSel(null)}
        role="img"
        aria-label="Floor plan"
      >
        <rect x={-w / 2} y={back} width={w} height={d} className="sc-roomrect" />
        <text x={0} y={back - 0.08} className="sc-wall">
          Back wall
        </text>
        {/* 部屋の寸法: W は手前の辺の外、D は右の辺の外、H は左上の角 */}
        <g className="sc-dim" aria-hidden="true">
          <line x1={-w / 2} y1={back + d + 0.1} x2={w / 2} y2={back + d + 0.1} />
          <text x={0} y={back + d + 0.27}>{`W ${w} m`}</text>
          <line x1={w / 2 + 0.1} y1={back} x2={w / 2 + 0.1} y2={back + d} />
          <text transform={`translate(${w / 2 + 0.24} ${back + d / 2}) rotate(90)`}>{`D ${d} m`}</text>
          <text x={-w / 2} y={back - 0.08} style={{ textAnchor: 'start' }}>{`H ${h} m`}</text>
        </g>
        {/* 押した照明・人を手前に描く。塗りは少し透かして、下に重なったものも見えるように */}
        {[
        ...scene.people.map((p, i) => {
          const k = `P:${i}`, s = p.kind === 'child' ? 0.22 : 0.3;
          return (
            <g key={k} className={sel === k ? 'sc-person on' : 'sc-person'} onPointerDown={start(k)}>
              <rect x={p.x - s} y={p.z - s} width={s * 2} height={s * 2} rx={0.05} />
              <text x={p.x} y={p.z + 0.08}>{`P${i + 1}`}</text>
            </g>
          );
        }),
        ...lights.map((l) => {
          const k = `L:${l.id}`, dir = aimDir(l.cur.pan, l.cur.tilt), len = 0.3 + 0.6 * Math.hypot(dir[0], dir[2]);
          const hl = Math.hypot(dir[0], dir[2]) || 1;
          return (
            <g key={k} className={sel === k ? 'sc-light on' : 'sc-light'} onPointerDown={start(k)}>
              <line x1={l.cur.x} y1={l.cur.z} x2={l.cur.x + (dir[0] / hl) * len} y2={l.cur.z + (dir[2] / hl) * len} />
              <circle cx={l.cur.x} cy={l.cur.z} r={0.24} />
              <text x={l.cur.x} y={l.cur.z + 0.08}>{l.num}</text>
            </g>
          );
        }),
        ].sort((a, b) => Number(a.key === sel) - Number(b.key === sel))}
      </svg>
      <p className="sc-note">Drag lights (circles) and people (squares) on the plan. Tap one, or its number above, to edit it.</p>
      </div>
      <div className="sc-side">

      {selLight && (
        <div className="sc-edit">
          <strong>Light {selLight.num}</strong>
          <div className="sc-aim" role="group" aria-label="Point the light at">
            <span>Point at</span>
            {scene.people.map((_, i) => (
              <button key={i} className="sc-btn" onClick={() => aim({ person: i })}>
                P{i + 1}
              </button>
            ))}
            <button className="sc-btn" onClick={() => aim('floor')}>
              Floor
            </button>
            {(['back', 'left', 'right', 'front'] as const).map((wl) => (
              <button key={wl} className="sc-btn" onClick={() => aim(wl)}>
                {wl[0].toUpperCase() + wl.slice(1)} wall
              </button>
            ))}
          </div>
          {slider('Pan', 'sc-pan', selLight.cur.pan, -180, 180, 1, '°', (v) => setLight(selLight.id, { ...selLight.cur, pan: v }))}
          {slider('Tilt', 'sc-tilt', selLight.cur.tilt, -30, 90, 1, '°', (v) => setLight(selLight.id, { ...selLight.cur, tilt: v }))}
          {slider('Beam', 'sc-beam', selLight.cur.beam, 5, 120, 1, '°', (v) => setLight(selLight.id, { ...selLight.cur, beam: v }))}
          {slider('Soft', 'sc-soft', Math.round(selLight.cur.soft * 100), 0, 100, 1, '%', (v) => setLight(selLight.id, { ...selLight.cur, soft: v / 100 }))}
          {slider('Height', 'sc-h', selLight.cur.h, 0.1, h, 0.05, ' m', (v) => setLight(selLight.id, { ...selLight.cur, h: v }))}
        </div>
      )}

      {selPerson && (
        <div className="sc-edit">
          <strong>Person P{selPi + 1}</strong>
          {(
            [
              ['pose', [['stand', 'Standing'], ['sit', 'Sitting'], ['musician', 'Musician'], ['dancer', 'Dancer']]],
              ['kind', [['adult', 'Adult'], ['child', 'Child']]],
              ['wear', [['light', 'Light clothes'], ['dark', 'Dark clothes'], ['color', 'Blue clothes']]],
            ] as const
          ).map(([key, opts]) => (
            <div key={key} className="sc-seg" role="group">
              {opts.map(([v, lab]) => (
                <button key={v} className={selPerson[key] === v ? 'sc-btn on' : 'sc-btn'} aria-pressed={selPerson[key] === v} onClick={() => setPerson(selPi, { ...selPerson, [key]: v })}>
                  {lab}
                </button>
              ))}
            </div>
          ))}
          {/* Musician は楽器、Dancer はポーズを選ぶ */}
          {selPerson.pose === 'musician' && (
            <div className="sc-seg" role="group" aria-label="Instrument">
              {([['guitar', 'Guitar'], ['violin', 'Violin'], ['keys', 'Keyboard'], ['drums', 'Drums']] as const).map(([v, lab]) => {
                const on = (selPerson.inst ?? 'guitar') === v;
                return (
                  <button key={v} className={on ? 'sc-btn on' : 'sc-btn'} aria-pressed={on} onClick={() => setPerson(selPi, { ...selPerson, inst: v })}>
                    {lab}
                  </button>
                );
              })}
            </div>
          )}
          {selPerson.pose === 'dancer' && (
            <div className="sc-seg" role="group" aria-label="Dance pose">
              {([['ballet', 'Ballet'], ['arabesque', 'Arabesque'], ['contemporary', 'Contemporary'], ['floor', 'Floor'], ['hiphop', 'Hip-hop']] as const).map(([v, lab]) => {
                const on = (selPerson.dance ?? 'ballet') === v;
                return (
                  <button key={v} className={on ? 'sc-btn on' : 'sc-btn'} aria-pressed={on} onClick={() => setPerson(selPi, { ...selPerson, dance: v })}>
                    {lab}
                  </button>
                );
              })}
            </div>
          )}
          <button
            className="sc-btn"
            onClick={() => {
              onChange({ ...scene, people: scene.people.filter((_, k) => k !== selPi) });
              onSel(null);
            }}
          >
            Remove P{selPi + 1}
          </button>
        </div>
      )}

      <button className="sc-btn sc-add" onClick={addPerson} disabled={scene.people.length >= 6}>
        + Add person ({scene.people.length}/6)
      </button>
      </div>
      </div>
    </div>
  );
}

/** 平面図のホイールでのズーム（ウェブ版・デモ版だけ）。拡大しているときの viewBox を返す */
function usePlanZoom(svgRef: RefObject<SVGSVGElement | null>, vx: number, vy: number, vw: number, vh: number) {
  const [zv, setZv] = useState<[number, number, number]>([1, vx + vw / 2, vy + vh / 2]); // 倍率、見ている中心
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    // ホイールを押し込んでドラッグすると動かす。照明や人のドラッグより先に受ける
    let pan: { id: number; x: number; y: number } | null = null;
    const onDown = (e: PointerEvent) => {
      if (e.button !== 1) return;
      e.preventDefault();
      e.stopPropagation();
      pan = { id: e.pointerId, x: e.clientX, y: e.clientY };
      svg.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      if (!pan || e.pointerId !== pan.id) return;
      e.stopPropagation();
      const m = svg.getScreenCTM();
      if (!m || !m.a) return;
      const dx = (e.clientX - pan.x) / m.a, dy = (e.clientY - pan.y) / m.d;
      pan.x = e.clientX;
      pan.y = e.clientY;
      // 部屋の中心が画面から外れきらない所まで
      setZv(([z, cx, cy]) => [z, clamp(cx - dx, vx, vx + vw), clamp(cy - dy, vy, vy + vh)]);
    };
    const onUp = (e: PointerEvent) => {
      if (!pan || e.pointerId !== pan.id) return;
      e.stopPropagation();
      pan = null;
    };
    // ホイールの押し込みで出るブラウザの自動スクロールを止める
    const onMouseDown = (e: MouseEvent) => {
      if (e.button === 1) e.preventDefault();
    };
    svg.addEventListener('pointerdown', onDown, { capture: true });
    svg.addEventListener('pointermove', onMove, { capture: true });
    svg.addEventListener('pointerup', onUp, { capture: true });
    svg.addEventListener('pointercancel', onUp, { capture: true });
    svg.addEventListener('mousedown', onMouseDown);
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const pt = svg.createSVGPoint();
      pt.x = e.clientX;
      pt.y = e.clientY;
      const q = pt.matrixTransform(svg.getScreenCTM()!.inverse());
      setZv(([z, cx, cy]) => {
        const z2 = clamp(z * (e.deltaY < 0 ? 1.2 : 1 / 1.2), 1, 6);
        const k = z / z2;
        // 動かした位置はそのままにして、カーソルの所を中心に寄る・引く
        return [z2, clamp(q.x - (q.x - cx) * k, vx, vx + vw), clamp(q.y - (q.y - cy) * k, vy, vy + vh)];
      });
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      svg.removeEventListener('wheel', onWheel);
      svg.removeEventListener('pointerdown', onDown, { capture: true });
      svg.removeEventListener('pointermove', onMove, { capture: true });
      svg.removeEventListener('pointerup', onUp, { capture: true });
      svg.removeEventListener('pointercancel', onUp, { capture: true });
      svg.removeEventListener('mousedown', onMouseDown);
    };
  }, [vx, vy, vw, vh]);
  // 部屋の広さが変わったら、いつもの見え方に戻す
  useEffect(() => setZv([1, vx + vw / 2, vy + vh / 2]), [vx, vy, vw, vh]);
  // 拡大も移動もしていないときは null（平面図はいつもの見え方）
  const home = zv[0] === 1 && Math.abs(zv[1] - (vx + vw / 2)) < 1e-6 && Math.abs(zv[2] - (vy + vh / 2)) < 1e-6;
  return home ? null : `${zv[1] - vw / 2 / zv[0]} ${zv[2] - vh / 2 / zv[0]} ${vw / zv[0]} ${vh / zv[0]}`;
}

/** 部屋の広さの欄。打っている間は決めず、Enter か欄を離れたときに決める（打つたびに範囲へ丸めると 12 や空欄が打てなかった） */
function RoomInput({ id, lo, hi, value, onCommit }: { id: string; lo: number; hi: number; value: number; onCommit: (v: number) => void }) {
  const [txt, setTxt] = useState(String(value));
  useEffect(() => setTxt(String(value)), [value]);
  const commit = () => {
    const v = Number(txt);
    if (txt.trim() === '' || !Number.isFinite(v)) setTxt(String(value));
    else if (v !== value) onCommit(v);
    else setTxt(String(value));
  };
  return (
    <input
      id={id}
      type="number"
      inputMode="decimal"
      min={lo}
      max={hi}
      step={0.1}
      value={txt}
      onChange={(e) => {
        setTxt(e.target.value);
        // 矢印ボタンや上下キーで変えたときはすぐ決める（打っているときは inputType がある）
        const it = (e.nativeEvent as InputEvent).inputType;
        const v = Number(e.target.value);
        if (!it && e.target.value !== '' && Number.isFinite(v) && v !== value) onCommit(v);
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
      }}
    />
  );
}

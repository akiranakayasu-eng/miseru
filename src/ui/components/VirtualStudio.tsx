import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { findFixtureType, fixtureTypes } from '../../engine/fixtures.js';
import { applyFxAll, fxNow, hasFx } from '../../engine/effects.js';
import { lightLabel, type Patch, type PatchedLight, type ShowState } from '../../engine/show.js';
import { cssColor, displayRgb, FIXED_WHITE, isWhiteOnly } from './colors';
import { exportPatch, importPatch, overlaps, type LightEdit, type PatchEdits } from '../patchEdits';

interface Props {
  patch: Patch;
  state: ShowState;
  selected: string[];
  onToggle: (id: string) => void;
  /** All とグループのボタン（[名前, ライトの id]） */
  groups: [string, string[]][];
  onSelect: (ids: string[]) => void;
  /** Timeline のトラックの名前を押したときに目立たせる照明 */
  highlight?: string[] | null;
  /** ch と機種を変えられるとき（デモ版、または Admin を開けたとき）。元のパッチと、変更を渡す先 */
  edit?: { defaults: Patch; onEdit: (id: string, edit: LightEdit | null) => void; onReplace: (edits: PatchEdits) => void } | null;
  /** 天井図の上にかぶせて出すもの（3D の Solid 表示の設定の欄。天井図の大きさはそのまま使う） */
  cover?: ReactNode;
}

/** 表示用: 全角のかっこを半角にそろえる */
const ascii = (s: string) => s.replace(/（/g, ' (').replace(/）/g, ')').replace(/(\d)ch\)/g, '$1 ch)');

/** 照明の面の LED の並び（丸は同心円、パネルは格子）。縁を残して内側に並べる。座標は見本の大きさ（丸 32、パネル 60×30）で決める */
const ROUND_DOTS: [number, number][] = (() => {
  const dots: [number, number][] = [[16, 16]];
  for (const [r, n] of [[4.6, 6], [9, 12]] as const) {
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 - Math.PI / 2;
      dots.push([16 + r * Math.cos(a), 16 + r * Math.sin(a)]);
    }
  }
  return dots;
})();
const PANEL_DOTS: [number, number][] = (() => {
  const dots: [number, number][] = [];
  for (let row = 0; row < 4; row++) for (let col = 0; col < 10; col++) dots.push([10.25 + col * 4.4, 8.4 + row * 4.4]);
  return dots;
})();

function LedFace({ panel }: { panel: boolean }) {
  const dots = panel ? PANEL_DOTS : ROUND_DOTS;
  return (
    <svg className="led-face" viewBox={panel ? '0 0 60 30' : '0 0 32 32'} preserveAspectRatio="none" aria-hidden="true">
      {panel
        ? <rect className="led-rim" x="1.5" y="1.5" width="57" height="27" rx="4" />
        : <circle className="led-rim" cx="16" cy="16" r="14.8" />}
      {dots.map(([x, y], i) => <circle key={i} className="led-dot" cx={x} cy={y} r={1.25} />)}
    </svg>
  );
}

/**
 * 部屋を上から見た図（天井図）で照明を選ぶ。もとの「照明の一覧（カード）」をここにまとめた。
 * 灯体は前の一覧と同じカード（番号・色・名前・明るさ）で、天井図の位置に置く。ch は i の中。
 * グループのボタンは図の中の上、i で灯体の種類とモードを出す。
 */
export function VirtualStudio({ patch, state, selected, onToggle, groups, onSelect, edit, highlight, cover }: Props) {
  const [info, setInfo] = useState<string | null>(null);
  // 演出があるあいだは、天井図のカードも今の時刻の見た目で描く（この部品の中だけで 30 回/秒描き直す）
  const fxActive = hasFx(state.looks);
  const [fxT, setFxT] = useState(0);
  useEffect(() => {
    if (!fxActive) return;
    let raf = 0;
    let last = 0;
    const tick = (ms: number) => {
      if (ms - last >= 33) {
        last = ms;
        setFxT(fxNow());
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [fxActive]);
  const shownLooks = fxActive ? applyFxAll(patch.lights, state.looks, fxT) : state.looks;
  // なぞって選ぶ: カードを押したまま指（マウス）を動かすと、通ったカードを最初のカードと同じ向き（選ぶ／外す）にそろえる
  const selRef = useRef(selected);
  selRef.current = selected;
  const fromPointer = useRef(false);
  const startPaint = (e: React.PointerEvent<HTMLButtonElement>, id: string) => {
    if (e.button !== 0) return;
    fromPointer.current = true;
    const on = !selRef.current.includes(id);
    const done = new Set<string>([id]);
    // 指で触るとき（スマホ・タブレット）は、i が小さくて押しにくいので、カードの長押し（0.5 秒）で i の枠を開く。
    // 長押しと区別するため、指のときは最初のカードの切り替えを「指を離したとき」か「別のカードへなぞったとき」まで待つ
    const touch = e.pointerType !== 'mouse';
    const x0 = e.clientX;
    const y0 = e.clientY;
    let first = !touch;
    let long = false;
    if (!touch) onToggle(id);
    const timer = touch
      ? window.setTimeout(() => {
          long = true;
          navigator.vibrate?.(10);
          setInfo(id);
        }, 500)
      : 0;
    const move = (ev: PointerEvent) => {
      if (long) return;
      if (Math.hypot(ev.clientX - x0, ev.clientY - y0) > 8) window.clearTimeout(timer);
      const el = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>('[data-light-id]');
      const lid = el?.dataset.lightId;
      if (!lid || done.has(lid)) return;
      window.clearTimeout(timer);
      if (!first) {
        first = true;
        onToggle(id);
      }
      done.add(lid);
      if (selRef.current.includes(lid) !== on) onToggle(lid);
    };
    const up = (ev: PointerEvent) => {
      window.clearTimeout(timer);
      // 長押しで i の枠を開いたあと、指を離したときのクリックが暗い層に当たって枠が閉じないよう、直後のクリックを 1 回捨てる
      if (long) {
        const eat = (ce: MouseEvent) => {
          ce.stopPropagation();
          ce.preventDefault();
        };
        window.addEventListener('click', eat, { capture: true, once: true });
        window.setTimeout(() => window.removeEventListener('click', eat, { capture: true }), 400);
      }
      if (!first && !long && ev.type === 'pointerup') onToggle(id);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };
  // 天井図の高さで並べ方を変える: 空き 20px で 3 行が入れば元の大きさ（full）、
  // 入らなければカードを 80%・空き 16px に（compact）、それも入らなければ 7〜1 を横 1 列に（row）
  const studioRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ w: number; h: number; cardW: number; cardH: number; padT: number; padB: number } | null>(null);
  useLayoutEffect(() => {
    const el = studioRef.current;
    if (!el) return;
    const read = () => {
      const cs = getComputedStyle(el);
      const px = (name: string, d: number) => parseFloat(cs.getPropertyValue(name)) || d;
      setBox({ w: el.clientWidth, h: el.clientHeight, cardW: px('--card-w', 96), cardH: px('--card-h', 95), padT: px('--pad-top', 38), padB: px('--pad-bottom', 10) });
    };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // i の枠は Esc でも閉じる
  useEffect(() => {
    if (!info) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setInfo(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [info]);
  const factor = state.blackout ? 0 : state.master;
  const aspect = patch.room?.aspect ?? 3;
  const all = patch.lights.map((l) => l.id);
  const same = (ids: string[]) => ids.length === selected.length && ids.every((id) => selected.includes(id));
  // Shift を押しながら Select のボタンを押すと、グループを足したり外したりできる（2026-11-21 Akira さんの指示）。
  // 点くのは、選択がちょうどグループの組み合わせのときだけ。全部そろったら All とすべてのグループが点く（Floor PAR があるかどうかで組み合わせは変わる）
  const isAll = all.length > 0 && same(all);
  const fullGroups = groups.filter(([, ids]) => ids.length > 0 && ids.every((id) => selected.includes(id)));
  const exactUnion = !isAll && selected.length > 0 && selected.every((id) => fullGroups.some(([, ids]) => ids.includes(id)));
  const groupOn = (ids: string[]) => (isAll || exactUnion) && ids.length > 0 && ids.every((id) => selected.includes(id));
  // Select のグループのボタンを押したまま横へなぞると、なぞったグループをまとめて選ぶ（2026-11-21 Akira さんの指示）。
  // なぞったときは、指を離したあとの click を受けない（1 つだけ選び直さないため）
  const chipDrag = useRef<{ names: Set<string>; moved: boolean } | null>(null);
  const skipChipClick = useRef(false);
  const startChipDrag = (e: React.PointerEvent<HTMLButtonElement>, name: string) => {
    if (e.button !== 0 || e.shiftKey) return;
    chipDrag.current = { names: new Set([name]), moved: false };
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    const move = (ev: PointerEvent) => {
      const d = chipDrag.current;
      if (!d) return;
      const el = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>('[data-sel-group]');
      const n = el?.dataset.selGroup;
      if (!n || d.names.has(n)) return;
      d.names.add(n);
      d.moved = true;
      const ids = groups.filter(([gn]) => d.names.has(gn)).flatMap(([, gi]) => gi);
      onSelect(all.filter((id) => ids.includes(id)));
    };
    const up = () => {
      // なぞり終わりの click だけを捨てる（click が来なかったときに印が残って次の本物のクリックを食べないよう、すぐ消す）
      if (chipDrag.current?.moved) {
        skipChipClick.current = true;
        window.setTimeout(() => (skipChipClick.current = false), 50);
      }
      chipDrag.current = null;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };
  const pickGroup = (ids: string[], shift: boolean) => {
    if (skipChipClick.current) {
      skipChipClick.current = false;
      return;
    }
    const full = ids.length > 0 && ids.every((id) => selected.includes(id));
    if (!shift) return onSelect(same(ids) ? [] : ids);
    if (full) return onSelect(selected.filter((id) => !ids.includes(id)));
    const next = [...selected, ...ids.filter((id) => !selected.includes(id))];
    onSelect(all.filter((id) => next.includes(id)));
  };
  // 縦は「横の列」にまとめる: 高さが近い灯体（部屋の高さの 8% 以内）は同じ列にそろえ、
  // 列は Select の行のすぐ下から枠のすぐ上まで等間隔に並べる
  // 行どうしの空きは --row-gap（20px）で固定し、まとまりを枠の上下の真ん中に置く。
  // 2 台以上がそろう列を「主な列」として等間隔に置き、1 台だけの灯体（例: 3）は上下の主な列の間に高さの割合どおりに置く
  const rowGroups: { y: number; n: number }[] = [];
  for (const y of patch.lights.map((l) => l.position?.y ?? 0.5).sort((a, b) => a - b)) {
    const last = rowGroups[rowGroups.length - 1];
    if (last && y - last.y <= 0.08) last.n += 1;
    else rowGroups.push({ y, n: 1 });
  }
  const rows = (rowGroups.filter((g) => g.n >= 2).length >= 2 ? rowGroups.filter((g) => g.n >= 2) : rowGroups).map((g) => g.y);
  const rowPos = (y: number) => {
    if (rows.length < 2) return 0.5;
    const at = (i: number) => i / (rows.length - 1);
    const near = rows.findIndex((r) => Math.abs(r - y) <= 0.08);
    if (near >= 0) return at(near);
    if (y < rows[0]) return 0;
    if (y > rows[rows.length - 1]) return 1;
    const i = rows.findIndex((r, k) => r < y && y < rows[k + 1]);
    return at(i) + ((y - rows[i]) / (rows[i + 1] - rows[i])) * (at(i + 1) - at(i));
  };
  // 横は列にそろえる: 部屋の x が近い照明（差 0.12 未満）を同じ列にし、列どうしは「カード幅 + 20px」の間隔で真ん中に寄せる
  const xs = [...new Set(patch.lights.map((l) => l.position?.x ?? 0.5))].sort((p, q) => p - q);
  const cols: number[][] = [];
  for (const x of xs) {
    const last = cols[cols.length - 1];
    if (last && x - last[last.length - 1] < 0.12) last.push(x);
    else cols.push([x]);
  }
  const colOf = (x: number) => Math.max(0, cols.findIndex((c) => c.includes(x)));
  const colOffset = (x: number) => colOf(x) - (cols.length - 1) / 2;
  const nRows = Math.max(1, rows.length);
  // 天井の並びは高さに加えて幅も足りるときだけ（床置き 4 灯で列が左右に 1 つずつ増えるため）
  const need = (k: number, gap: number) =>
    box ? (box.w >= 20 + cols.length * box.cardW * k + (cols.length - 1) * gap ? box.padT + box.padB + nRows * box.cardH * k + (nRows - 1) * gap : Infinity) : 0;
  const order = [...patch.lights].sort((a, b) => (b.number ?? 0) - (a.number ?? 0)).map((l) => l.id);
  const fitK = (perRow: number, g: number) => (box ? Math.max(0.4, Math.min(0.8, (box.w - 20 - (perRow - 1) * g) / (perRow * box.cardW))) : 0.8);
  const perRow2 = Math.ceil(order.length / 2);
  const needRows = (n: number, k: number, g: number) => (box ? box.padT + box.padB + n * box.cardH * k + (n - 1) * g : 0);
  // 高さに合わせて 4 段階: 最大（元の並び 100%）→ 元の並び 80% → 横 2 段 → 横 1 列
  // 元の並びは 100% → 90% → 80% の 3 段階（2026-11-20 Akira さんの指示）
  // スマホの縦向き（幅 520px 未満）: 天井の位置は崩して、番号順に 2 段（7 台なら 4 台と 3 台）で並べる（2026-11-20 Akira さん選択）
  const narrow = !!box && box.w < 520;
  // スマホ縦で照明が多いとき（床置き 4 灯を足して 11 灯など）は、2 段に詰めると文字が 7px まで縮むので、
  // 段を増やして天井図を縦に伸ばす（2026-11-21 ダブルチェックの指摘）。7 灯は今までどおり 4 台と 3 台の 2 段
  const perFit = box ? Math.max(1, Math.floor((box.w - 8 + 6) / (box.cardW * 0.85 + 6))) : 4;
  const rowsN = narrow ? Math.max(2, Math.ceil(order.length / perFit)) : 2;
  const perRowN = narrow ? Math.ceil(order.length / rowsN) : perRow2;
  const narrowK = narrow && box ? Math.max(0.5, Math.min(1, (box.w - 8 - (perRowN - 1) * 6) / (perRowN * box.cardW))) : 1;
  const narrowTall = narrow && rowsN > 2 && box ? Math.ceil(box.padT + box.padB + 14 + rowsN * box.cardH * narrowK + (rowsN - 1) * 6) : null;
  const layout: 'full' | 'mid' | 'compact' | 'two' | 'row' = !box
    ? 'full'
    : narrow
      ? 'two'
    // 枠の線（上下 1px ずつ）の分だけ clientHeight は CSS の高さより小さいので、数 px は許す
    : box.h >= need(1, 20) - 4
      ? 'full'
      : box.h >= need(0.9, 18) - 4
        ? 'mid'
        : box.h >= need(0.8, 16) - 4
          ? 'compact'
          : box.h >= needRows(2, fitK(perRow2, 12), 12) - 4
            ? 'two'
            : 'row';
  // 横 2 段・横 1 列も、幅と高さが足りれば 100% → 90% → 80% の段階を踏む。80% も入らなければ幅に合わせて縮める
  const stepK = (perRow: number, nr: number): [number, number] => {
    if (box) {
      for (const [sk, sg] of [[1, 20], [0.9, 18], [0.8, 16]] as const) {
        const wNeed = 20 + perRow * box.cardW * sk + (perRow - 1) * sg;
        if (box.w >= wNeed && box.h >= needRows(nr, sk, sg) - 4) return [sk, sg];
      }
    }
    return [fitK(perRow, 12), 12];
  };
  const [k, gap]: [number, number] =
    narrow && box
      ? narrowTall
        ? [narrowK, 6]
        : [Math.max(0.5, Math.min(1, (box.w - 8 - (perRow2 - 1) * 6) / (perRow2 * box.cardW), (box.h - 4 - box.padT - box.padB - 10) / (2 * box.cardH))), 6]
      : layout === 'full' ? [1, 20] : layout === 'mid' ? [0.9, 18] : layout === 'compact' ? [0.8, 16] : layout === 'two' ? stepK(perRow2, 2) : stepK(order.length, 1);
  const slotPos = (id: string, pos: { x: number; y: number }) => {
    const midY = 'calc(50% + (var(--pad-top) - var(--pad-bottom)) / 2';
    if (layout === 'row') {
      const i = order.indexOf(id) - (order.length - 1) / 2;
      return { left: `calc(50% + (var(--card-w) * var(--k) + var(--gap)) * ${i})`, top: `${midY})` };
    }
    if (layout === 'two' && narrowTall) {
      const idx = order.indexOf(id);
      const r = Math.floor(idx / perRowN);
      const inRow = r < rowsN - 1 ? perRowN : order.length - perRowN * (rowsN - 1);
      const i = idx - r * perRowN - (inRow - 1) / 2;
      return {
        left: `calc(50% + (var(--card-w) * var(--k) + var(--gap)) * ${i})`,
        top: `${midY} + (var(--card-h) * var(--k) + var(--gap)) * ${r - (rowsN - 1) / 2})`,
      };
    }
    if (layout === 'two') {
      const idx = order.indexOf(id);
      const r = idx < perRow2 ? 0 : 1;
      const inRow = r === 0 ? perRow2 : order.length - perRow2;
      const i = (r === 0 ? idx : idx - perRow2) - (inRow - 1) / 2;
      return {
        left: `calc(50% + (var(--card-w) * var(--k) + var(--gap)) * ${i})`,
        top: `${midY} + (var(--card-h) * var(--k) + var(--gap)) * ${r - 0.5})`,
      };
    }
    return {
      left: `calc(50% + (var(--card-w) * var(--k) + var(--gap)) * ${colOffset(pos.x)})`,
      top: `${midY} + (var(--card-h) * var(--k) + var(--gap)) * ${rowPos(pos.y) * (nRows - 1) - (nRows - 1) / 2})`,
    };
  };
  const infoLight = patch.lights.find((l) => l.id === info);
  const infoType = infoLight ? findFixtureType(infoLight.typeId) : undefined;
  const rangeOf = (address: number, typeId: string) => {
    const count = findFixtureType(typeId)?.channels.length ?? 1;
    return count > 1 ? `ch ${address}–${address + count - 1}` : `ch ${address}`;
  };

  return (
    <div className={cover ? 'studio-wrap studio-covered' : 'studio-wrap'}>
      {cover && <div className="studio-cover">{cover}</div>}
      <div ref={studioRef} className={`studio layout-${layout}${narrow ? ' studio-narrow' : ''}`} role="group" aria-label="Fixtures (ceiling, top view)"
        // 天井図の何もない所を押すと選択を外す（None と同じ。2026-11-21 Akira さんの指示）
        onPointerDown={(e) => {
          if (e.button !== 0 || info) return;
          if ((e.target as HTMLElement).closest('button, input, select, a, .studio-infobox, .studio-scrim, .studio-chips, [data-light-id]')) return;
          onSelect([]);
        }}
        style={{ aspectRatio: String(aspect), '--k': k, '--gap': `${gap}px`, ...(narrowTall ? { height: `${narrowTall}px` } : {}) } as CSSProperties}>
        {patch.lights.map((l) => {
          const look = shownLooks[l.id];
          const level = look.intensity * factor;
          // 明るさだけの照明（床置きの PAR100CW などの 1ch）は色を持たないので、いつも Cool White で見せる（2026-11-21 Akira さんの指示）
          const rgb = isWhiteOnly(l.typeId) ? FIXED_WHITE : displayRgb(look);
          const pos = l.position ?? { x: 0.5, y: 0.5 };
          const range = rangeOf(l.address, l.typeId);
          const isSel = selected.includes(l.id);
          const pct = Math.round(state.looks[l.id].intensity * factor * 100); // 数字は演出をかける前の明るさ（点滅で数字が動かないように）
          return (
            <div key={l.id} className="studio-slot" style={slotPos(l.id, pos)}>
              <button
                className={`${isSel ? 'card selected' : 'card'}${highlight?.includes(l.id) ? ' hl' : ''}`}
                data-light-id={l.id}
                onPointerDown={(e) => startPaint(e, l.id)}
                onContextMenu={(e) => e.preventDefault()}
                onClick={() => {
                  // 押したときに選び終えているので、クリックでは切り替えない（キーボードの Enter・Space のときだけ切り替える）
                  if (fromPointer.current) {
                    fromPointer.current = false;
                    return;
                  }
                  onToggle(l.id);
                }}
                aria-label={`${lightLabel(l)}, ${range}, ${pct === 0 ? 'off' : `${pct}%`}`}
                aria-pressed={isSel}
              >
                <span className={l.shape?.kind === 'panel' ? 'swatch panel' : 'swatch'} style={{ background: cssColor(rgb, level) }}>
                  <LedFace panel={l.shape?.kind === 'panel'} />
                </span>
                <span className="card-name">{l.name}</span>
                <span className="card-level">
                  {l.number !== undefined && <span className="card-num-inline">{l.number}:</span>}
                  {pct === 0 ? 'Off' : `${pct}%`}
                </span>
              </button>
              <button
                className={info === l.id ? 'studio-info on' : 'studio-info'}
                onClick={() => setInfo((v) => (v === l.id ? null : l.id))}
                aria-label={`Fixture info: ${lightLabel(l)}`}
                aria-expanded={info === l.id}
              >
                i
              </button>
            </div>
          );
        })}
        {infoLight && <div className="studio-scrim" onClick={() => setInfo(null)} aria-hidden="true" />}
        {infoLight && (
          <div className="studio-infobox" role="dialog" aria-label={`Fixture info: ${lightLabel(infoLight)}`}>
            <div className="studio-infobox-head">
              {/* 見出しは付けず、番号と名前も下の表に並べる（# / Fixture / Channels / Profile / Mode。2026-11-22 Akira さん） */}
              <strong>Fixture info</strong>
              <button className="studio-infobox-close" onClick={() => setInfo(null)} aria-label="Close">
                ×
              </button>
            </div>
            {edit ? (
              <LightEditor light={infoLight} patch={patch} defaults={edit.defaults} onEdit={edit.onEdit} onReplace={edit.onReplace} />
            ) : (
              <dl>
                <dt>#</dt>
                <dd>{infoLight.number ?? '—'}</dd>
                <dt>Fixture</dt>
                <dd>{ascii(infoLight.name)}</dd>
                <dt>Channels</dt>
                <dd>
                  {rangeOf(infoLight.address, infoLight.typeId)}
                  {infoType ? ` (${infoType.channels.length} ch)` : ''}
                </dd>
                <dt>Profile</dt>
                <dd>{infoType ? ascii(infoType.name) : infoLight.typeId}</dd>
                <dt>Mode</dt>
                <dd>{infoType?.mode ? ascii(infoType.mode) : '—'}</dd>
              </dl>
            )}
          </div>
        )}
        <div className="chips studio-chips">
          <span className="studio-chips-label">Select:</span>
          {/* 押してあるボタンをもう一度押すと外れて None になる（2026-11-21 Akira さんの指示） */}
          <button className={isAll ? 'chip on' : 'chip'} aria-pressed={isAll} onClick={() => onSelect(isAll ? [] : all)} title="Shift-click a group to add or remove it">
            All
          </button>
          {groups.map(([name, ids]) => (
            <button key={name} data-sel-group={name} className={groupOn(ids) ? 'chip on' : 'chip'} aria-pressed={groupOn(ids)} onPointerDown={(e) => startChipDrag(e, name)} onClick={(e) => pickGroup(ids, e.shiftKey)} title="Drag across groups or Shift-click to select several">
              {name}
            </button>
          ))}
          <button className={selected.length === 0 ? 'chip on' : 'chip'} aria-pressed={selected.length === 0} onClick={() => onSelect([])}>
            None
          </button>
        </div>
      </div>
    </div>
  );
}

/** i の枠の中で、開始 ch と機種・モードを変える。変えた値はこの端末に保存される */
function LightEditor({ light, patch, defaults, onEdit, onReplace }: { light: PatchedLight; patch: Patch; defaults: Patch; onEdit: (id: string, edit: LightEdit | null) => void; onReplace: (edits: PatchEdits) => void }) {
  const [fileMsg, setFileMsg] = useState<string | null>(null);
  const download = () => {
    const blob = new Blob([exportPatch(patch)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'miseru-patch.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const upload = (file: File | undefined) => {
    if (!file) return;
    file.text().then(
      (text) => {
        try {
          onReplace(importPatch(text, defaults));
          setFileMsg('Loaded.');
        } catch {
          setFileMsg('This file is not a miseru patch.');
        }
      },
      () => setFileMsg('Could not read the file.'),
    );
  };
  const type = findFixtureType(light.typeId);
  const count = type?.channels.length ?? 1;
  const [addr, setAddr] = useState(String(light.address));
  useEffect(() => setAddr(String(light.address)), [light.id, light.address]);
  const original = defaults.lights.find((l) => l.id === light.id);
  const changed = !!original && (original.address !== light.address || original.typeId !== light.typeId);
  const clash = overlaps(patch, light.id).map((id) => patch.lights.find((l) => l.id === id)).filter((l): l is PatchedLight => !!l);
  const commitAddr = () => {
    const n = Number(addr);
    if (Number.isInteger(n) && n >= 1 && n + count - 1 <= 512) onEdit(light.id, { address: n });
    else setAddr(String(light.address));
  };
  return (
    <div className="light-editor">
      <dl>
        <dt>Start ch</dt>
        <dd>
          <input
            className="ch-input"
            type="number"
            inputMode="numeric"
            min={1}
            max={512 - count + 1}
            value={addr}
            onChange={(e) => setAddr(e.target.value)}
            onBlur={commitAddr}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              if (e.key === 'Escape') setAddr(String(light.address));
            }}
            aria-label="Start channel"
          />
          <span className="muted">
            {' '}– {light.address + count - 1} ({count} ch)
          </span>
        </dd>
        <dt>Profile</dt>
        <dd>
          <select value={light.typeId} onChange={(e) => onEdit(light.id, { typeId: e.target.value })} aria-label="Profile (model and mode)">
            {fixtureTypes.map((t) => (
              <option key={t.id} value={t.id} disabled={light.address + t.channels.length - 1 > 512}>
                {ascii(t.name)}
                {t.mode ? ` — ${ascii(t.mode)}` : ''}
              </option>
            ))}
          </select>
        </dd>
      </dl>
      {type && !type.verified && <p className="light-editor-note">Channel layout not yet verified against the manual.</p>}
      {clash.length > 0 && <p className="light-editor-warn">Overlaps {clash.map((l) => lightLabel(l)).join(', ')}.</p>}
      <div className="light-editor-files">
        <span className="muted">All fixtures:</span>
        <button className="link" onClick={download}>
          Export
        </button>
        <label className="link file-link">
          Import
          <input type="file" accept="application/json,.json" onChange={(e) => { upload(e.target.files?.[0]); e.target.value = ''; }} hidden />
        </label>
        {fileMsg && <span className="muted">{fileMsg}</span>}
      </div>
      <div className="light-editor-foot">
        <span className="muted">Saved on this device only.</span>
        {changed && (
          <button className="link" onClick={() => onEdit(light.id, null)}>
            Reset to default
          </button>
        )}
      </div>
    </div>
  );
}

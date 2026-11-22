import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { EffectsPanel } from './EffectsPanel';
import { hueToRgb, lookToDisplayRgb, type Look } from '../../engine/color.js';
import { ColorWheel } from './ColorWheel';
import { cssColor, displayRgb } from './colors';

// スライダーの溝の色
/** 色温度: Swatches の白と同じ見え方で 2800 K → 6500 K */
const CCT_STOPS = [2800, 3200, 3700, 4300, 5000, 5600, 6500];
const cctTrack = `linear-gradient(to right, ${CCT_STOPS.map((k) => `${cssColor(displayRgb({ sat: 0, hue: 0, cct: k }))} ${(((k - 2800) / 3700) * 100).toFixed(1)}%`).join(', ')})`;
/** 彩度: 今の Hue（と色温度）で 0% → 100% */
/** Tint: 今の色温度の白で、グリーン（-100）→ 補正なし → マゼンタ（+100） */
const tintTrack = (cct: number) =>
  `linear-gradient(to right, ${[-1, -0.5, 0, 0.5, 1].map((t) => `${cssColor(displayRgb({ sat: 0, hue: 0, cct, tint: t }))} ${(t + 1) * 50}%`).join(', ')})`;
const satTrack = (hue: number, cct: number) =>
  `linear-gradient(to right, ${[0, 0.25, 0.5, 0.75, 1].map((s) => `${cssColor(displayRgb({ sat: s, hue, cct }))} ${s * 100}%`).join(', ')})`;

const whites = [
  { label: 'Candle', cct: 2800 },
  { label: 'Tungsten', cct: 3200 },
  { label: 'Neutral', cct: 4300 },
  { label: 'Daylight', cct: 5600 },
  { label: 'Cool', cct: 6500 },
];

const hues = [
  { label: 'Red', hue: 0 },
  { label: 'Orange', hue: 30 },
  { label: 'Yellow', hue: 55 },
  { label: 'Lime', hue: 90 },
  { label: 'Green', hue: 130 },
  { label: 'Cyan', hue: 185 },
  { label: 'Blue', hue: 230 },
  { label: 'Violet', hue: 275 },
  { label: 'Magenta', hue: 320 },
];

/** 自分で作った色の見本（この端末のブラウザに保存する。照明の箱には書かない） */
interface CustomSwatch {
  id: string;
  sat: number;
  hue: number;
  cct: number;
}
const CUSTOM_KEY = 'miseru.customSwatches';
const CUSTOM_MAX = 12;
function loadCustom(): CustomSwatch[] {
  try {
    const v = JSON.parse(localStorage.getItem(CUSTOM_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x?.sat === 'number' && typeof x?.hue === 'number' && typeof x?.cct === 'number').slice(0, CUSTOM_MAX) : [];
  } catch {
    return [];
  }
}
function saveCustom(list: CustomSwatch[]) {
  try {
    localStorage.setItem(CUSTOM_KEY, JSON.stringify(list));
  } catch {
    /* 保存できなくても画面はそのまま使う */
  }
}
/** 見本の下に出す短い説明（白なら色温度、色なら色相と彩度） */
const customLabel = (c: CustomSwatch) => (c.sat === 0 ? `${c.cct}K` : `${Math.round(c.hue)}° ${Math.round(c.sat * 100)}%`);
/** 見本の名前の下に小さく出す値（白は色温度、色は送る R:G:B）。ほかのタイルと同じ書き方 */
const customDetail = (c: CustomSwatch) =>
  c.sat === 0 ? `${c.cct}K` : lookToDisplayRgb({ sat: c.sat, hue: c.hue, cct: c.cct }).map((v) => Math.round(v * 255)).join(':');
const sameLook = (c: CustomSwatch, l: Pick<Look, 'sat' | 'hue' | 'cct'>) =>
  Math.abs(c.sat - l.sat) < 0.01 && (c.sat === 0 || Math.abs(c.hue - l.hue) < 1) && Math.abs(c.cct - l.cct) < 25;

interface Props {
  look: Look;
  onChange: (look: Partial<Look>) => void;
  /** Live で画面が広いときは見本とホイールを左右に並べて同時に出す。狭い画面と Timeline のときはタブで切り替える */
  split?: boolean;
  /** 選択に明るさだけの照明が入っているか: all（全部色が変わる）・mixed（混ざる）・none（明るさだけ） */
  colorScope?: 'all' | 'mixed' | 'none';
  /** 明るさだけの照明の名前（注意の文に使う） */
  whiteOnlyName?: string;
}

/** 色パネルの幅が見本とホイールを並べられる広さか（ウィンドウ幅 700px 以上） */
const WIDE_QUERY = '(min-width: 700px)';
function useWide(): boolean {
  const [wide, setWide] = useState(() => typeof window === 'undefined' || window.matchMedia(WIDE_QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia(WIDE_QUERY);
    const on = () => setWide(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return wide;
}

/** 見本の枠とホイールの枠のあいだの仕切りで決めた、見本の枠の幅（この端末に覚える） */
const SWATCH_W_KEY = 'miseru.swatchW';
/** ホイールの枠がこれより狭いと、ホイールとバーを縦 2 段にする（ホイール 170＋空き 29＋バー 140＋内側の余白 33） */
const WHEEL_SIDE_BY_SIDE = 372;
/** ホイールの枠の最小幅（縦 2 段でホイール 170＋左右の余白） */
const WHEEL_MIN = 214;
const SWATCH_MIN = 200;

/** 数字をクリック（タップ）すると、その場で数値を打ち込める。Enter か欄の外で決定、Esc で取り消し */
function NumField({ value, unit, min, max, wrap, onCommit, label }: { value: number; unit: string; min: number; max: number; wrap?: boolean; onCommit: (v: number) => void; label: string }) {
  const [edit, setEdit] = useState<string | null>(null);
  const done = useRef(false);
  const commit = () => {
    if (done.current || edit === null) return;
    done.current = true;
    const n = Number(edit);
    if (edit.trim() !== '' && Number.isFinite(n)) {
      const span = max - min + 1;
      onCommit(wrap ? ((((Math.round(n) - min) % span) + span) % span) + min : Math.min(max, Math.max(min, n)));
    }
    setEdit(null);
  };
  if (edit !== null)
    return (
      <input
        className="num-edit"
        type="number"
        inputMode="numeric"
        value={edit}
        min={min}
        max={max}
        aria-label={label}
        autoFocus
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setEdit(e.target.value)}
        onBlur={commit}
        onClick={(e) => e.preventDefault()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') {
            done.current = true;
            setEdit(null);
          }
        }}
      />
    );
  return (
    <output
      className="num-out"
      title="Click to type a value"
      onClick={(e) => {
        e.preventDefault();
        done.current = false;
        setEdit(String(Math.round(value)));
      }}
    >
      {Math.round(value)}
      {unit}
    </output>
  );
}

export function ColorPanel({ look, onChange, split = false, colorScope = 'all', whiteOnlyName = '' }: Props) {
  const [wheel, setWheel] = useState(false);
  // Effects のタブ
  const [fxTab, setFxTab] = useState(false);
  const fxMark = look.fx ? <span className="fx-dot" aria-label="effect on" /> : null;
  const fxPanel = <EffectsPanel look={look} onChange={onChange} colorless={colorScope === 'none'} />;
  const wide = useWide();
  const splitRef = useRef<HTMLDivElement>(null);
  const [swatchW, setSwatchW] = useState<number | null>(() => {
    try {
      const v = Number(localStorage.getItem(SWATCH_W_KEY));
      return v > 0 ? v : null;
    } catch {
      return null;
    }
  });
  const saveSwatchW = (w: number | null) => {
    setSwatchW(w);
    try {
      if (w) localStorage.setItem(SWATCH_W_KEY, String(w));
      else localStorage.removeItem(SWATCH_W_KEY);
    } catch {
      /* 覚えられなくても動く */
    }
  };
  // ホイールの枠の幅を見て、狭ければホイールとバーを縦 2 段に
  const [wheelW, setWheelW] = useState(0);
  useEffect(() => {
    const el = splitRef.current?.querySelector('.wheel-side');
    if (!el) return;
    const ro = new ResizeObserver(() => setWheelW((el as HTMLElement).offsetWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [split, wide]);
  // Manual と Timeline の切り替えなどで枠の幅が変わったとき、ResizeObserver（描いたあと）を待つと 1 フレーム古い大きさで出るので、
  // 描く前にも幅を読む。同じ値なら描き直さない
  useLayoutEffect(() => {
    const el = splitRef.current?.querySelector('.wheel-side') as HTMLElement | null;
    if (!el) return;
    const w = el.offsetWidth;
    setWheelW((v) => (v === w ? v : w));
  });
  // ホイールの大きさは枠の幅に合わせて少し変える（横並びは枠の約半分、縦 2 段は枠いっぱい。150〜220px）
  const stackedWheel = wheelW > 0 && wheelW < WHEEL_SIDE_BY_SIDE;
  const drag = useRef<{ x: number; w: number } | null>(null);
  const clampSwatch = (w: number) => {
    const total = splitRef.current?.clientWidth ?? 800;
    return Math.round(Math.max(SWATCH_MIN, Math.min(w, total - 12 - WHEEL_MIN)));
  };
  const swatchNow = () => (splitRef.current?.querySelector('.swatch-side') as HTMLElement | null)?.offsetWidth ?? 400;
  const [custom, setCustom] = useState<CustomSwatch[]>(loadCustom);
  const update = (list: CustomSwatch[]) => {
    setCustom(list);
    saveCustom(list);
  };
  const saved = custom.some((c) => sameLook(c, look));
  const addCustom = () => {
    if (saved || custom.length >= CUSTOM_MAX) return;
    update([...custom, { id: `${Date.now()}`, sat: look.sat, hue: look.hue, cct: look.cct }]);
  };
  const addButton = (
    <button className="tile tile-add" onClick={addCustom} disabled={saved || custom.length >= CUSTOM_MAX} title={saved ? 'This color is already saved' : 'Save the current color as a swatch'}>
      <span className="tile-color tile-add-mark" style={{ background: cssColor(displayRgb(look)) }}>+</span>
      <span className="tile-name">Add</span>
    </button>
  );
  const isWhite = look.sat === 0;

  // 色温度・彩度・色相の細かい調整。ホイールの下に常に出す
  const details = (
    <div className="detail">
      <div className="detail-row">
        <span>
          Color Temperature
          <button className={look.cct === 5600 ? 'cct-reset on' : 'cct-reset'} onClick={() => onChange({ cct: 5600 })} title="Set to the standard 5600 K">
            5600 K
          </button>
        </span>
        <input type="range" min={2800} max={6500} step={50} value={look.cct} aria-label="Color Temperature" onChange={(e) => onChange({ cct: Number(e.target.value) })} style={{ '--track': cctTrack, '--thumb': cssColor(displayRgb({ sat: 0, hue: 0, cct: look.cct })) } as CSSProperties} />
        <NumField value={look.cct} unit=" K" min={2800} max={6500} label="Color Temperature (K)" onCommit={(v) => onChange({ cct: Math.round(v / 50) * 50 })} />
      </div>
      {/* 白のグリーン／マゼンタ補正。-100 = グリーン、0 = なし、+100 = マゼンタ。0 のボタンで戻す */}
      <div className="detail-row">
        <span>
          Tint
          <button className={Math.round((look.tint ?? 0) * 100) === 0 ? 'cct-reset on' : 'cct-reset'} onClick={() => onChange({ tint: 0 })} title="No green/magenta correction">
            0
          </button>
        </span>
        <input type="range" min={-100} max={100} value={Math.round((look.tint ?? 0) * 100)} aria-label="Tint (green − / magenta +)" onChange={(e) => onChange({ tint: Number(e.target.value) / 100 })} style={{ '--track': tintTrack(look.cct), '--thumb': cssColor(displayRgb({ sat: 0, hue: 0, cct: look.cct, tint: look.tint ?? 0 })) } as CSSProperties} />
        <NumField value={(look.tint ?? 0) * 100} unit="" min={-100} max={100} label="Tint (green − / magenta +)" onCommit={(v) => onChange({ tint: Math.round(v) / 100 })} />
      </div>
      <label>
        <span>Saturation</span>
        <input type="range" min={0} max={100} value={Math.round(look.sat * 100)} onChange={(e) => onChange({ sat: Number(e.target.value) / 100 })} style={{ '--track': satTrack(look.hue, look.cct), '--thumb': cssColor(displayRgb({ sat: look.sat, hue: look.hue, cct: look.cct })) } as CSSProperties} />
        <NumField value={look.sat * 100} unit="%" min={0} max={100} label="Saturation (%)" onCommit={(v) => onChange({ sat: v / 100 })} />
      </label>
      <label>
        <span>Hue</span>
        <input className="hue" type="range" min={0} max={359} value={Math.round(look.hue)} onChange={(e) => onChange({ hue: Number(e.target.value) })} style={{ '--thumb': cssColor(hueToRgb(look.hue)) } as CSSProperties} />
        <NumField value={look.hue} unit="°" min={0} max={359} wrap label="Hue (°)" onCommit={(v) => onChange({ hue: v })} />
      </label>
    </div>
  );

  // 見本（White・Color・Custom）
  const swatchList = (
    <>
      <p className="section-label">White</p>
      <div className="tiles">
        {whites.map((w) => (
          <button
            key={w.cct}
            className={isWhite && Math.abs(look.cct - w.cct) < 50 ? 'tile on' : 'tile'}
            onClick={() => onChange({ sat: 0, cct: w.cct, tint: 0, intensity: look.intensity || 1 })}
          >
            <span className="tile-color" style={{ background: cssColor(displayRgb({ sat: 0, hue: 0, cct: w.cct })) }} />
            <span className="tile-name">{w.label}</span>
            <span className="tile-cct">{w.cct}K</span>
          </button>
        ))}
      </div>

      <p className="section-label">Color</p>
      <div className="tiles">
        {hues.map((h) => (
          <button
            key={h.hue}
            className={!isWhite && look.sat > 0.95 && Math.abs(look.hue - h.hue) < 3 ? 'tile on' : 'tile'}
            onClick={() => onChange({ sat: 1, hue: h.hue, intensity: look.intensity || 1 })}
          >
            <span className="tile-color" style={{ background: cssColor(displayRgb({ sat: 1, hue: h.hue, cct: 5600 })) }} />
            <span className="tile-name">{h.label}</span>
            <span className="tile-cct">{hueToRgb(h.hue).map((c) => Math.round(c * 255)).join(':')}</span>
          </button>
        ))}
      </div>

      <p className="section-label">Custom</p>
      <div className="tiles">
        {custom.map((c) => (
          <div key={c.id} className="tile-wrap">
            <button
              className={sameLook(c, look) ? 'tile on' : 'tile'}
              onClick={() => onChange({ sat: c.sat, hue: c.hue, cct: c.cct, intensity: look.intensity || 1 })}
            >
              <span className="tile-color" style={{ background: cssColor(displayRgb(c)) }} />
              <span className="tile-name">{c.sat === 0 ? 'White' : 'Color'}</span>
              <span className="tile-cct">{customDetail(c)}</span>
            </button>
            <button className="tile-remove" onClick={() => update(custom.filter((x) => x.id !== c.id))} aria-label={`Remove swatch ${customLabel(c)}`} title="Remove">
              ×
            </button>
          </div>
        ))}
        {addButton}
      </div>
    </>
  );

  return (
    <div className={colorScope === 'none' ? 'panel color-none' : 'panel'}>
      <label className="big-slider">
        <span>Intensity</span>
        <input
          type="range"
          min={0}
          max={100}
          value={Math.round(look.intensity * 100)}
          onChange={(e) => onChange({ intensity: Number(e.target.value) / 100 })}
          aria-label="Intensity"
          style={{ '--track': 'linear-gradient(to right, #000, #fff)', '--thumb': `hsl(0 0% ${Math.round(look.intensity * 100)}%)` } as CSSProperties}
        />
        <NumField value={look.intensity * 100} unit="%" min={0} max={100} label="Intensity (%)" onCommit={(v) => onChange({ intensity: v / 100 })} />
        <span className="int-presets" role="group" aria-label="Intensity presets">
          {[0, 50, 100].map((p) => (
            <button key={p} type="button" className={Math.round(look.intensity * 100) === p ? 'int-preset on' : 'int-preset'} onClick={(e) => { e.preventDefault(); onChange({ intensity: p / 100 }); }}>
              {p}%
            </button>
          ))}
        </span>
      </label>
      {colorScope !== 'all' && (
        <p className="color-scope-note" role="note">
          {colorScope === 'none' ? `${whiteOnlyName}: intensity only (cool white).` : `${whiteOnlyName}: intensity only. Color changes apply to the other fixtures.`}
        </p>
      )}

      {split && wide && (
        <div className="segmented mode-tabs fx-switch" role="group" aria-label="Color or effects">
          <button className={fxTab ? 'color-tab' : 'color-tab on'} onClick={() => setFxTab(false)} aria-pressed={!fxTab}>
            Color
          </button>
          <button className={fxTab ? 'on' : ''} onClick={() => setFxTab(true)} aria-pressed={fxTab}>
            Effects{fxMark}
          </button>
        </div>
      )}
      {split && wide && fxTab ? (
        fxPanel
      ) : split && wide ? (
        <div
          ref={splitRef}
          className={stackedWheel ? 'color-split wheel-stacked' : 'color-split'}
          style={swatchW ? { gridTemplateColumns: `${clampSwatch(swatchW)}px 12px minmax(${WHEEL_MIN}px, 1fr)` } : undefined}
        >
          <div className="swatch-side">
            <p className="split-title">Swatches</p>
            {swatchList}
          </div>
          <div
            className="col-splitter"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize swatches"
            tabIndex={0}
            title="Drag to resize · double-click to reset"
            onPointerDown={(e) => {
              drag.current = { x: e.clientX, w: swatchNow() };
              e.currentTarget.setPointerCapture(e.pointerId);
            }}
            onPointerMove={(e) => {
              if (drag.current) saveSwatchW(clampSwatch(drag.current.w + e.clientX - drag.current.x));
            }}
            onPointerUp={() => (drag.current = null)}
            onPointerCancel={() => (drag.current = null)}
            onDoubleClick={() => saveSwatchW(null)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                e.preventDefault();
                saveSwatchW(clampSwatch(swatchNow() + (e.key === 'ArrowLeft' ? -20 : 20)));
              }
            }}
          >
            <span className="col-splitter-grip" />
          </div>
          <div className="wheel-side">
            <p className="split-title">Color Wheel</p>
            <div className="wheel-bars">
              <ColorWheel look={look} onChange={onChange} />
              <div className="bar-side">{details}</div>
            </div>
          </div>
        </div>
      ) : (
        <>
          <div className="segmented mode-tabs" role="group" aria-label="Color input">
            <button className={!wheel && !fxTab ? 'color-tab on' : 'color-tab'} onClick={() => { setWheel(false); setFxTab(false); }} aria-pressed={!wheel && !fxTab}>
              Swatches
            </button>
            <button className={wheel && !fxTab ? 'color-tab on' : 'color-tab'} onClick={() => { setWheel(true); setFxTab(false); }} aria-pressed={wheel && !fxTab}>
              Wheel
            </button>
            <button className={fxTab ? 'on' : ''} onClick={() => setFxTab(true)} aria-pressed={fxTab}>
              Effects{fxMark}
            </button>
          </div>
          {fxTab ? (
            fxPanel
          ) : wheel ? (
            <>
              <div className="wheel-row">
                {details}
                <ColorWheel look={look} onChange={onChange} />
              </div>
              <button className="small save-swatch" onClick={addCustom} disabled={saved || custom.length >= CUSTOM_MAX}>
                {saved ? 'Saved in Custom' : '+ Save as Swatch'}
              </button>
            </>
          ) : (
            swatchList
          )}
        </>
      )}
    </div>
  );
}

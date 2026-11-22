import type { CSSProperties } from 'react';
import { defaultFx, FX_SPEED_MAX, FX_SPEED_MIN, fxKinds, fxOrders, type Fx, type FxKind, type FxOrder, type Look } from '../../engine/index.js';

/** 演出のタブ（Swatches・Wheel の横。2026-11-21 Akira さんが C 案を選択）。選んだ照明に効き、Insert Keyframe でそのままキーに入る */

const LABELS: Record<FxKind, [string, string]> = {
  strobe: ['Strobe', 'Fast flashes'],
  chase: ['Chase', 'One after another'],
  pulse: ['Pulse', 'Slow fade in and out'],
  flicker: ['Flicker', 'Fire or TV glow'],
  rainbow: ['Rainbow', 'Colors cycle'],
  wave: ['Wave', 'Brightness wave'],
};
const ORDER_LABELS: Record<FxOrder, string> = { forward: 'Forward', reverse: 'Reverse', bounce: 'Bounce', random: 'Random' };

// 速さのバーは対数（0.05〜10 Hz）。0..1000 の値で持つ
const SPEED_STEPS = 1000;
const toSlider = (hz: number) => Math.round((Math.log(hz / FX_SPEED_MIN) / Math.log(FX_SPEED_MAX / FX_SPEED_MIN)) * SPEED_STEPS);
const fromSlider = (v: number) => {
  const hz = FX_SPEED_MIN * Math.pow(FX_SPEED_MAX / FX_SPEED_MIN, v / SPEED_STEPS);
  return hz < 1 ? Math.round(hz * 100) / 100 : Math.round(hz * 10) / 10;
};
const hzText = (hz: number) => (hz < 1 ? hz.toFixed(2) : hz.toFixed(1));

export function EffectsPanel({ look, onChange, colorless = false }: { look: Look; onChange: (look: Partial<Look>) => void; colorless?: boolean }) {
  const fx = look.fx ?? null;
  const set = (next: Partial<Fx>) => fx && onChange({ fx: { ...fx, ...next } });
  const pick = (kind: FxKind) => {
    if (fx?.kind === kind) return onChange({ fx: null });
    // 種類を変えても、速さ以外（強さ・順番）は前のものを引き継ぐ。明るさ 0 なら点けてから
    onChange({ fx: { ...defaultFx(kind), depth: fx?.depth ?? 1, order: fx?.order ?? 'forward' }, ...(look.intensity === 0 ? { intensity: 1 } : {}) });
  };
  return (
    <div className="fx-panel">
      <div className="fx-tiles">
        {fxKinds.map((k) => (
          <button
            key={k}
            className={fx?.kind === k ? 'fx-tile on' : 'fx-tile'}
            aria-pressed={fx?.kind === k}
            disabled={k === 'rainbow' && colorless}
            onClick={() => pick(k)}
            title={fx?.kind === k ? 'Press again to stop' : LABELS[k][1]}
          >
            <span className="fx-tile-name">{LABELS[k][0]}</span>
            <span className="fx-tile-sub">{LABELS[k][1]}</span>
          </button>
        ))}
      </div>
      {fx ? (
        <div className="fx-controls">
          <label className="fx-row">
            <span>Speed</span>
            <input
              type="range"
              min={0}
              max={SPEED_STEPS}
              value={toSlider(fx.speed)}
              onChange={(e) => set({ speed: fromSlider(Number(e.target.value)) })}
              aria-label="Effect speed"
              style={{ '--track': 'linear-gradient(to right, #555, #fff)', '--thumb': '#ddd' } as CSSProperties}
            />
            <output className="fx-val">{hzText(fx.speed)} Hz</output>
          </label>
          <label className="fx-row">
            <span>Depth</span>
            <input
              type="range"
              min={0}
              max={100}
              value={Math.round(fx.depth * 100)}
              onChange={(e) => set({ depth: Number(e.target.value) / 100 })}
              aria-label="Effect depth"
              style={{ '--track': 'linear-gradient(to right, #555, #fff)', '--thumb': '#ddd' } as CSSProperties}
            />
            <output className="fx-val">{Math.round(fx.depth * 100)}%</output>
          </label>
          {(fx.kind === 'chase' || fx.kind === 'wave' || fx.kind === 'rainbow') && (
            <div className="fx-row fx-order-row">
              <span>Order</span>
              <span className="fx-orders" role="group" aria-label="Effect order">
                {fxOrders
                  .filter((o) => fx.kind === 'chase' || o === 'forward' || o === 'reverse')
                  .map((o) => (
                    <button key={o} className={(fx.order ?? 'forward') === o ? 'fx-order on' : 'fx-order'} aria-pressed={(fx.order ?? 'forward') === o} onClick={() => set({ order: o })}>
                      {ORDER_LABELS[o]}
                    </button>
                  ))}
              </span>
            </div>
          )}
          <button className="fx-stop" onClick={() => onChange({ fx: null })}>
            Stop Effect
          </button>
        </div>
      ) : (
        <p className="fx-hint">Choose an effect for the selected fixtures. In Timeline, Insert Keyframe records it; it runs until the next key.</p>
      )}
    </div>
  );
}

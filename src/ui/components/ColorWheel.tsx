import { useRef } from 'react';
import type { Look } from '../../engine/color.js';
import { cssColor, displayRgb } from './colors';

interface Props {
  look: Look;
  onChange: (look: Partial<Look>) => void;
}

/** 円をなぞると色あい、中心からの距離で色の濃さ。中心は「しろ」。 */
export function ColorWheel({ look, onChange }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const frame = useRef(0);
  const pending = useRef<Partial<Look> | null>(null);

  const pick = (clientX: number, clientY: number) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const dx = clientX - (r.left + r.width / 2);
    const dy = clientY - (r.top + r.height / 2);
    // 上を 0° として時計回り（CSS の conic-gradient と同じ向き）
    const hue = ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;
    const sat = Math.min(1, Math.hypot(dx, dy) / (r.width / 2));
    pending.current = { hue: Math.round(hue), sat: Math.round(sat * 100) / 100, intensity: look.intensity || 1 };
    // 指の動きは速いので、送るのは 1 フレームに 1 回まで
    if (!frame.current) {
      frame.current = requestAnimationFrame(() => {
        frame.current = 0;
        if (pending.current) onChange(pending.current);
      });
    }
  };

  const center = cssColor(displayRgb({ sat: 0, hue: 0, cct: look.cct }));
  const rad = (look.hue * Math.PI) / 180;
  // 取っ手（直径 34px）がホイールの外にはみ出さないよう、半径から取っ手の半分（17px）を引いた円の上に置く
  const knob = { left: `calc(50% + (50% - 17px) * ${look.sat * Math.sin(rad)})`, top: `calc(50% - (50% - 17px) * ${look.sat * Math.cos(rad)})` };

  return (
    <div
      ref={ref}
      className="wheel"
      style={{ ['--wheel-center' as string]: center }}
      role="slider"
      aria-label="Color wheel"
      aria-valuetext={`Hue ${Math.round(look.hue)}°, Saturation ${Math.round(look.sat * 100)}%`}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        pick(e.clientX, e.clientY);
      }}
      onPointerMove={(e) => {
        if (e.buttons) pick(e.clientX, e.clientY);
      }}
    >
      <span className="wheel-knob" style={{ ...knob, background: cssColor(displayRgb(look)) }} />
    </div>
  );
}

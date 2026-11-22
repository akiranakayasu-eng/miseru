import { useRef } from 'react';

interface Props {
  /** いまの天井図の高さ（px）を測る */
  measure: () => number;
  onResize: (height: number) => void;
  onReset: () => void;
  /** 読み上げの名前（既定は天井図） */
  label?: string;
  /** いちばん小さい高さ（px） */
  min?: number;
}

/** 天井図と下の段のあいだの仕切り。上下にドラッグすると天井図の大きさが変わる。ダブルクリックで元に戻す。 */
export function Splitter({ measure, onResize, onReset, label = 'Resize ceiling plan', min = 130 }: Props) {
  const drag = useRef<{ y: number; h: number } | null>(null);
  const clamp = (h: number) => Math.round(Math.max(min, Math.min(h, window.innerHeight * 0.85)));
  return (
    <div
      className="splitter"
      role="separator"
      aria-orientation="horizontal"
      aria-label={label}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      onPointerDown={(e) => {
        drag.current = { y: e.clientY, h: measure() };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (drag.current) onResize(clamp(drag.current.h + e.clientY - drag.current.y));
      }}
      onPointerUp={() => (drag.current = null)}
      onPointerCancel={() => (drag.current = null)}
      onDoubleClick={onReset}
      onKeyDown={(e) => {
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault();
          onResize(clamp(measure() + (e.key === 'ArrowUp' ? -20 : 20)));
        }
      }}
    >
      <span className="splitter-grip" />
    </div>
  );
}

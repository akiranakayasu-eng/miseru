// 「明るさ・色・白のあたたかさ」から各チャンネルの値を作る。

import type { FixtureType } from './fixtures.js';
import type { Fx } from './effects.js';

/** 1 台のライトの見た目。子どもが操作するのはこの 4 つだけ。 */
export interface Look {
  /** 明るさ 0..1 */
  intensity: number;
  /** 色の濃さ 0..1。0 = 白（cct のあたたかさ）、1 = 色だけ */
  sat: number;
  /** 色相 0..360 */
  hue: number;
  /** 白のあたたかさ（ケルビン） */
  cct: number;
  /** 白のグリーン／マゼンタ補正 -1..1（-1 = グリーン、0 = 補正なし、+1 = マゼンタ）。無ければ 0 */
  tint?: number;
  /** 演出（ストロボ・チェイスなど）。無ければ演出なし */
  fx?: Fx | null;
}

export const defaultLook: Look = { intensity: 0, sat: 0, hue: 0, cct: 5600, tint: 0 };

export type RGB = [number, number, number];

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const to8 = (v: number) => Math.round(clamp01(v) * 255);

/** 色相（彩度・明度 1）を RGB 0..1 に */
export function hueToRgb(hue: number): RGB {
  const h = (((hue % 360) + 360) % 360) / 60;
  const x = 1 - Math.abs((h % 2) - 1);
  const table: RGB[] = [
    [1, x, 0],
    [x, 1, 0],
    [0, 1, x],
    [0, x, 1],
    [x, 0, 1],
    [1, 0, x],
  ];
  return table[Math.floor(h) % 6];
}

/** 色温度の白を RGB 0..1 に（Tanner Helland の近似。いちばん強い色を 1 にそろえる） */
export function cctToRgb(kelvin: number): RGB {
  const t = Math.min(40000, Math.max(1000, kelvin)) / 100;
  let r: number;
  let g: number;
  let b: number;
  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
    b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
    b = 255;
  }
  const rgb: RGB = [clamp01(r / 255), clamp01(g / 255), clamp01(b / 255)];
  const max = Math.max(...rgb);
  return rgb.map((c) => c / max) as RGB;
}

/** 白にグリーン／マゼンタの補正をかける（マゼンタは緑を減らし、グリーンは赤と青を減らす。いちばん強い色を 1 にそろえる） */
export function tintWhite(w: RGB, tint: number): RGB {
  const t = Math.max(-1, Math.min(1, tint));
  if (t === 0) return w;
  const k = 0.35 * Math.abs(t);
  const rgb: RGB = t > 0 ? [w[0], w[1] * (1 - k), w[2]] : [w[0] * (1 - k), w[1], w[2] * (1 - k)];
  const max = Math.max(...rgb);
  return rgb.map((c) => c / max) as RGB;
}

/** 画面に表示する色（明るさを含まない） */
export function lookToDisplayRgb(look: Pick<Look, 'sat' | 'hue' | 'cct' | 'tint'>): RGB {
  const w = tintWhite(cctToRgb(look.cct), look.tint ?? 0);
  const c = hueToRgb(look.hue);
  const s = clamp01(look.sat);
  return [0, 1, 2].map((i) => w[i] * (1 - s) + c[i] * s) as RGB;
}

/** 1 台分のチャンネル値（0..255）を、定義のチャンネル順に並べて返す */
export function renderFixture(type: FixtureType, look: Look): number[] {
  const roles = type.channels.map((c) => c.kind);
  const hasDimmer = roles.includes('dimmer');
  const hasXfade = roles.includes('xfade');
  const hasWhite = roles.includes('white');
  const intensity = clamp01(look.intensity);

  let rgb: RGB;
  let white = 0;
  if (hasXfade) {
    // 白は CCT 側が担当するので、RGB 側は純粋な色だけを送る
    rgb = hueToRgb(look.hue);
  } else {
    rgb = lookToDisplayRgb(look);
    if (hasWhite) {
      // 3 色に共通する分を白 LED に回す（白っぽい色ほど W を多く使う）
      white = Math.min(...rgb);
      rgb = rgb.map((c) => c - white) as RGB;
      const max = Math.max(white, ...rgb);
      if (max > 0) {
        white /= max;
        rgb = rgb.map((c) => c / max) as RGB;
      }
    }
  }

  // 明るさチャンネルがなければ色の値そのものを暗くする
  const scale = hasDimmer ? 1 : intensity;

  return type.channels.map((ch) => {
    switch (ch.kind) {
      case 'dimmer':
        return to8(intensity);
      case 'red':
        return to8(rgb[0] * scale);
      case 'green':
        return to8(rgb[1] * scale);
      case 'blue':
        return to8(rgb[2] * scale);
      case 'white':
        return to8(white * scale);
      case 'cct':
        return to8((look.cct - ch.minK) / (ch.maxK - ch.minK));
      case 'tint': {
        // 補正なしは機材の中立の値。-1 → 0、+1 → 255 として直線で割り当てる（向きは実機で要確認）
        const t = Math.max(-1, Math.min(1, look.tint ?? 0));
        return Math.round(t >= 0 ? ch.neutral + (255 - ch.neutral) * t : ch.neutral * (1 + t));
      }
      case 'xfade':
        return to8(look.sat);
      case 'fixed':
        return ch.value;
    }
  });
}

import { findFixtureType } from '../../engine/fixtures.js';
import { cctToRgb, hueToRgb, tintWhite, type Look, type RGB } from '../../engine/color.js';

/** 画面用の色。暗いほど黒に近づけるが、真っ黒にはせず形が見えるようにする。 */
export function cssColor(rgb: RGB, intensity = 1): string {
  const k = 0.12 + 0.88 * intensity;
  const [r, g, b] = rgb.map((c) => Math.round(c * k * 255));
  return `rgb(${r} ${g} ${b})`;
}

/**
 * 画面に出す白の色（照明に送る値は変えない）。
 * 人の目は昼の光（5600K）に慣れると、それを白と感じる。そこで 5600K を白とみなして色を割り戻し（色順応、von Kries の考え方）、
 * 暖かい白は橙寄り、6500K（Cool）は薄い青に見えるようにする。
 */
const ADAPT = cctToRgb(5600);
const lerp = (a: RGB, b: RGB, t: number) => a.map((c, i) => c + (b[i] - c) * t) as RGB;
function displayWhite(cct: number): RGB {
  const v = cctToRgb(cct).map((c, i) => c / ADAPT[i]);
  const max = Math.max(...v);
  const rgb = v.map((c) => c / max) as RGB;
  // 5600K より青い白は、画面では少しだけ青に寄せる（6500K で約 rgb(214, 234, 255)）
  const k = Math.min(1, Math.max(0, (cct - 5600) / 900));
  return k > 0 ? lerp(rgb, [0.72, 0.84, 1], 0.35 * k) : rgb;
}

export function displayRgb(look: Pick<Look, 'sat' | 'hue' | 'cct' | 'tint'>): RGB {
  const w = tintWhite(displayWhite(look.cct), look.tint ?? 0);
  const c = hueToRgb(look.hue);
  const s = Math.min(1, Math.max(0, look.sat));
  return lerp(w, c, s);
}

const COLOR_ROLES = new Set(['red', 'green', 'blue', 'cct', 'tint']);
/** 色を変えるチャンネルが無い（明るさだけの）機種か */
export function isWhiteOnly(typeId: string): boolean {
  const t = findFixtureType(typeId);
  return !!t && !t.channels.some((c) => COLOR_ROLES.has(c.kind));
}
/** 明るさだけの照明の見え方（Cool White。PAR100CW の色温度は資料でまだ確かめていないので 6500K とした） */
export const FIXED_WHITE = displayRgb({ sat: 0, hue: 0, cct: 6500, tint: 0 });


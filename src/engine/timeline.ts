// 時間演出（タイムライン）。キー（その時間の見た目）と、キーとキーの間の変化のカーブから、
// いつの時点でも各ライトの Look を決める。画面にも DMX にも依存しない。

import type { Look } from './color.js';
import { sanitizeFx } from './effects.js';

/** 次のキーまでの変化のしかた。名前つきのカーブか、cubic-bezier の制御点 [x1, y1, x2, y2]。 */
export type Curve = 'linear' | 'hold' | 'ease-in' | 'ease-out' | 'ease-in-out' | [number, number, number, number];

export const curveNames = ['linear', 'ease-in', 'ease-out', 'ease-in-out', 'hold'] as const;

export interface Keyframe {
  /** 秒 */
  t: number;
  look: Look;
  /** このキーから次のキーまでのカーブ */
  curve: Curve;
}

export interface Track {
  id: string;
  name: string;
  /** このトラックが動かすライト */
  lightIds: string[];
  /** t の昇順 */
  keys: Keyframe[];
}

export interface Timeline {
  name: string;
  /** 全体の長さ（秒） */
  duration: number;
  loop: boolean;
  tracks: Track[];
}

export function emptyTimeline(duration = 30): Timeline {
  return { name: 'Show 1', duration, loop: false, tracks: [] };
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

const bezierPresets: Record<Exclude<Curve, 'hold' | [number, number, number, number]>, [number, number, number, number]> = {
  linear: [0, 0, 1, 1],
  'ease-in': [0.42, 0, 1, 1],
  'ease-out': [0, 0, 0.58, 1],
  'ease-in-out': [0.42, 0, 0.58, 1],
};

/** 時間の進み具合 x(0..1) を、カーブを通した変化の進み具合(0..1)にする。 */
export function applyCurve(curve: Curve, x: number): number {
  x = clamp01(x);
  if (curve === 'hold') return x >= 1 ? 1 : 0;
  const [x1, y1, x2, y2] = Array.isArray(curve) ? curve : (bezierPresets[curve] ?? bezierPresets.linear);
  if (x1 === y1 && x2 === y2) return x; // 直線
  const bx = (s: number) => 3 * (1 - s) ** 2 * s * x1 + 3 * (1 - s) * s * s * x2 + s ** 3;
  const by = (s: number) => 3 * (1 - s) ** 2 * s * y1 + 3 * (1 - s) * s * s * y2 + s ** 3;
  // bezier の s を二分法で探す（x は s について単調）
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (bx(mid) < x) lo = mid;
    else hi = mid;
  }
  return clamp01(by((lo + hi) / 2));
}

/** 色相は近い回りかたで混ぜる（350° → 10° は 20° 進むだけ） */
function mixHue(a: number, b: number, u: number): number {
  const diff = ((((b - a) % 360) + 540) % 360) - 180;
  return (((a + diff * u) % 360) + 360) % 360;
}

export function mixLook(a: Look, b: Look, u: number): Look {
  // 消えている（明るさ 0）キーの色は見えないので、相手の色をそのまま使い、明るさだけを変える。
  // 白（彩度 0）のキーの色相も見えないので、相手の色相を使う。
  // こうしないと、黒→青で黒のキーに残った色相から回って紫を通る（2026-11-21 Akira さんの指摘）
  if (a.intensity === 0 && b.intensity > 0) a = { ...b, intensity: 0, fx: a.fx };
  else if (b.intensity === 0 && a.intensity > 0) b = { ...a, intensity: 0, fx: b.fx };
  if (a.sat === 0 && b.sat > 0) a = { ...a, hue: b.hue };
  else if (b.sat === 0 && a.sat > 0) b = { ...b, hue: a.hue };
  return {
    intensity: a.intensity + (b.intensity - a.intensity) * u,
    sat: a.sat + (b.sat - a.sat) * u,
    hue: mixHue(a.hue, b.hue, u),
    cct: a.cct + (b.cct - a.cct) * u,
    tint: (a.tint ?? 0) + ((b.tint ?? 0) - (a.tint ?? 0)) * u,
    // 演出はキーから次のキーまで前のキーのものを続ける。同じ種類なら強さはなめらかにつなぐ。
    // 速さは次のキーで切り替える（演出の位置は「時刻 × 速さ」なので、速さを途中で変えると点滅が急に速くなりすぎた。Pro で確認）
    ...(a.fx
      ? {
          fx: b.fx && b.fx.kind === a.fx.kind ? { ...a.fx, depth: a.fx.depth + (b.fx.depth - a.fx.depth) * u } : a.fx,
        }
      : {}),
  };
}

/** 1 本のトラックの、時間 t での Look。キーがなければ null。 */
export function evaluateTrack(track: Track, t: number): Look | null {
  const keys = track.keys;
  if (keys.length === 0) return null;
  if (t <= keys[0].t) return { ...keys[0].look };
  const last = keys[keys.length - 1];
  if (t >= last.t) return { ...last.look };
  let i = 0;
  while (keys[i + 1].t <= t) i++;
  const a = keys[i];
  const b = keys[i + 1];
  const u = applyCurve(a.curve, (t - a.t) / (b.t - a.t));
  return mixLook(a.look, b.look, u);
}

/** 時間 t でのライトごとの Look。あとのトラックが前のトラックを上書きする。 */
export function evaluateTimeline(tl: Timeline, t: number): Record<string, Look> {
  const out: Record<string, Look> = {};
  for (const track of tl.tracks) {
    const look = evaluateTrack(track, t);
    if (!look) continue;
    for (const id of track.lightIds) out[id] = { ...look };
  }
  return out;
}

// ---- 編集 ---------------------------------------------------------------

const SAME_TIME = 0.02;

const sortKeys = (keys: Keyframe[]) => [...keys].sort((a, b) => a.t - b.t);

/** キーを足す。ほぼ同じ時間にキーがあれば置き換える。 */
export function addKey(track: Track, key: Keyframe): Track {
  const keys = track.keys.filter((k) => Math.abs(k.t - key.t) > SAME_TIME);
  return { ...track, keys: sortKeys([...keys, key]) };
}

export function removeKey(track: Track, index: number): Track {
  return { ...track, keys: track.keys.filter((_, i) => i !== index) };
}

/** キーを動かす。ほかのキーを飛び越えず、重ならない範囲に止める。 */
export function moveKey(track: Track, index: number, t: number, duration: number): Track {
  const prev = track.keys[index - 1];
  const next = track.keys[index + 1];
  const lo = prev ? prev.t + SAME_TIME * 2 : 0;
  const hi = next ? next.t - SAME_TIME * 2 : duration;
  const clamped = Math.min(hi, Math.max(lo, t));
  return { ...track, keys: track.keys.map((k, i) => (i === index ? { ...k, t: clamped } : k)) };
}

export function updateKey(track: Track, index: number, patch: Partial<Pick<Keyframe, 'look' | 'curve'>>): Track {
  return { ...track, keys: track.keys.map((k, i) => (i === index ? { ...k, ...patch } : k)) };
}

/** 外から読み込んだデータを安全な形にそろえる。読めなければ null。 */
export function parseTimeline(data: unknown): Timeline | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;
  const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
  const duration = Math.min(3600, Math.max(1, num(d.duration, 30)));
  if (!Array.isArray(d.tracks)) return null;
  const tracks: Track[] = [];
  for (const raw of d.tracks.slice(0, 64)) {
    if (typeof raw !== 'object' || raw === null) continue;
    const r = raw as Record<string, unknown>;
    if (!Array.isArray(r.lightIds) || !Array.isArray(r.keys)) continue;
    const keys: Keyframe[] = [];
    for (const k of r.keys.slice(0, 2000)) {
      if (typeof k !== 'object' || k === null) continue;
      const kk = k as Record<string, unknown>;
      const l = (kk.look ?? {}) as Record<string, unknown>;
      let curve: Curve = 'linear';
      if (typeof kk.curve === 'string' && (curveNames as readonly string[]).includes(kk.curve)) curve = kk.curve as Curve;
      else if (Array.isArray(kk.curve) && kk.curve.length === 4 && kk.curve.every((v) => typeof v === 'number' && Number.isFinite(v)))
        curve = [clamp01(kk.curve[0]), kk.curve[1], clamp01(kk.curve[2]), kk.curve[3]];
      keys.push({
        t: Math.min(duration, Math.max(0, num(kk.t, 0))),
        look: {
          intensity: clamp01(num(l.intensity, 0)),
          sat: clamp01(num(l.sat, 0)),
          hue: num(l.hue, 0),
          cct: num(l.cct, 5600),
          tint: Math.max(-1, Math.min(1, num(l.tint, 0))),
          ...(sanitizeFx(l.fx) ? { fx: sanitizeFx(l.fx) } : {}),
        },
        curve,
      });
    }
    tracks.push({
      id: typeof r.id === 'string' ? r.id : `t${tracks.length}`,
      name: typeof r.name === 'string' ? r.name.slice(0, 40) : 'Track',
      lightIds: r.lightIds.filter((x): x is string => typeof x === 'string'),
      keys: sortKeys(keys),
    });
  }
  return {
    name: typeof d.name === 'string' ? d.name.slice(0, 60) : 'Show',
    duration,
    loop: d.loop === true,
    tracks,
  };
}

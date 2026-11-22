// 演出（ストロボ・チェイスなど）。照明そのものの効果の ch は使わず、miseru の中で明るさと色を時間で動かして作る
// （全部の照明を同じ速さでそろえられ、明るさだけの照明にも効く。2026-11-21 Akira さんの了承）。
// 画面にも DMX にも依存しない。時間 t（秒）を渡すと、その瞬間の Look を返す。

import type { Look } from './color.js';

export const fxKinds = ['strobe', 'chase', 'pulse', 'flicker', 'rainbow', 'wave'] as const;
export type FxKind = (typeof fxKinds)[number];
export const fxOrders = ['forward', 'reverse', 'bounce', 'random'] as const;
export type FxOrder = (typeof fxOrders)[number];

export interface Fx {
  kind: FxKind;
  /** 1 秒あたりの回数（Hz） */
  speed: number;
  /** 効きの強さ 0..1（1 = 消えるところまで落とす） */
  depth: number;
  /** Chase・Wave の順番 */
  order?: FxOrder;
}

/** 速さの範囲。ストロボは光過敏の人に配慮して 10 Hz までにする */
export const FX_SPEED_MIN = 0.05;
export const FX_SPEED_MAX = 10;

export const defaultFx = (kind: FxKind): Fx => ({
  kind,
  speed: kind === 'strobe' ? 4 : kind === 'chase' ? 2 : kind === 'flicker' ? 1 : kind === 'rainbow' ? 0.1 : 0.5,
  depth: 1,
  order: 'forward',
});

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** 外から届いた値を安全な Fx にする。無効なら null */
export function sanitizeFx(v: unknown): Fx | null {
  if (typeof v !== 'object' || v === null) return null;
  const r = v as Record<string, unknown>;
  if (typeof r.kind !== 'string' || !(fxKinds as readonly string[]).includes(r.kind)) return null;
  const num = (x: unknown, f: number) => (typeof x === 'number' && Number.isFinite(x) ? x : f);
  const d = defaultFx(r.kind as FxKind);
  const order = typeof r.order === 'string' && (fxOrders as readonly string[]).includes(r.order) ? (r.order as FxOrder) : 'forward';
  return {
    kind: r.kind as FxKind,
    speed: Math.min(FX_SPEED_MAX, Math.max(FX_SPEED_MIN, num(r.speed, d.speed))),
    depth: clamp01(num(r.depth, d.depth)),
    order,
  };
}

export const sameFx = (a: Fx | null | undefined, b: Fx | null | undefined) =>
  (!a && !b) || (!!a && !!b && a.kind === b.kind && a.speed === b.speed && a.depth === b.depth && (a.order ?? 'forward') === (b.order ?? 'forward'));

const frac = (x: number) => x - Math.floor(x);
/** 0..1 のなめらかなゆらぎ（照明ごとに seed を変える） */
function noise(t: number, seed: number): number {
  const v = Math.sin(t * 7.13 + seed * 1.7) * 0.5 + Math.sin(t * 3.71 + seed * 4.1) * 0.3 + Math.sin(t * 13.9 + seed * 2.3) * 0.2;
  return clamp01(v * 0.5 + 0.5);
}
/** 決まった並びの乱数（Chase の Random 用） */
function hash(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/** 何番目の照明が今の段で点くか（Chase）。index は 0 始まり、count は同じ演出の照明の数 */
function chaseOn(step: number, index: number, count: number, order: FxOrder): boolean {
  if (count <= 1) return step % 2 === 0;
  let pos: number;
  if (order === 'reverse') pos = count - 1 - (step % count);
  else if (order === 'bounce') {
    const period = 2 * (count - 1);
    const s = step % period;
    pos = s < count ? s : period - s;
  } else if (order === 'random') pos = Math.floor(hash(step) * count);
  else pos = step % count;
  return pos === index;
}

/**
 * 時間 t での演出を look にかける。index・count は、同じ演出の照明の中での順番と数（番号の順）。
 * 明るさは look.intensity を上限に、depth の分だけ下げる。Rainbow は色相を回す。
 */
export function applyFx(look: Look, t: number, index = 0, count = 1): Look {
  const fx = look.fx;
  if (!fx) return look;
  const p = t * fx.speed;
  const depth = clamp01(fx.depth);
  const order = fx.order ?? 'forward';
  const pos = count > 1 ? (order === 'reverse' ? count - 1 - index : index) / count : 0;
  let m = 1;
  switch (fx.kind) {
    case 'strobe':
      m = frac(p) < 0.3 ? 1 : 1 - depth;
      break;
    case 'pulse':
      m = 1 - depth * (0.5 - 0.5 * Math.cos(2 * Math.PI * p));
      break;
    case 'chase':
      m = chaseOn(Math.floor(p), index, count, order) ? 1 : 1 - depth;
      break;
    case 'wave':
      m = 1 - depth * (0.5 - 0.5 * Math.cos(2 * Math.PI * (p - pos)));
      break;
    case 'flicker':
      m = 1 - depth * noise(p * 6, index + 1);
      break;
    case 'rainbow':
      return { ...look, hue: (((look.hue + 360 * (p + pos)) % 360) + 360) % 360, sat: Math.max(look.sat, depth) };
  }
  return { ...look, intensity: look.intensity * m };
}

/** 全部の照明に演出をかける。順番は番号（無ければ並び）の順で、同じ種類の演出ごとに数える */
export function applyFxAll(lights: { id: string; number?: number }[], looks: Record<string, Look>, t: number): Record<string, Look> {
  const groups = new Map<string, string[]>();
  const sorted = [...lights].sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
  for (const l of sorted) {
    const fx = looks[l.id]?.fx;
    if (!fx) continue;
    const key = fx.kind;
    groups.set(key, [...(groups.get(key) ?? []), l.id]);
  }
  if (groups.size === 0) return looks;
  const out = { ...looks };
  for (const ids of groups.values()) ids.forEach((id, i) => (out[id] = applyFx(looks[id], t, i, ids.length)));
  return out;
}

export const hasFx = (looks: Record<string, Look>) => Object.values(looks).some((l) => !!l.fx);

/** 演出の時計（秒）。画面・箱・USB で同じ時刻を使って、点滅をそろえる */
export const fxNow = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;

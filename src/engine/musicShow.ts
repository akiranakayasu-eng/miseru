// Music タブ: 曲の分析と灯体の情報から Claude に演出の「キュー」を考えさせ、
// それを Timeline のトラックとキーに広げる。Claude とのやりとりそのものは ui/claudeShow.ts。

import type { Look } from './color.js';
import { findFixtureType } from './fixtures.js';
import { lightLabel, type PatchedLight } from './show.js';
import { evaluateTrack, type Curve, type Keyframe, type Timeline, type Track } from './timeline.js';
import type { AudioAnalysis } from './audioAnalysis.js';

export const cuePatterns = ['static', 'fade', 'pulse', 'chase', 'alternate', 'random'] as const;
export const cueOrders = ['number', 'left-to-right', 'right-to-left', 'back-to-front', 'front-to-back', 'center-out', 'random'] as const;
export const cueCurves = ['hold', 'linear', 'ease-in', 'ease-out', 'ease-in-out'] as const;

export interface CueColor {
  intensity: number;
  sat: number;
  hue: number;
  cct: number;
}

export interface Cue {
  start: number;
  end: number;
  label: string;
  lights: string[];
  pattern: (typeof cuePatterns)[number];
  stepBeats: number;
  colors: CueColor[];
  low: number;
  curve: (typeof cueCurves)[number];
  order: (typeof cueOrders)[number];
  density: number;
  fadeIn: number;
}

export interface ShowPlan {
  concept: string;
  cues: Cue[];
}

// ---- Claude に渡すもの ------------------------------------------------------

/** 灯体の説明（Claude 向け、英語） */
export function lightsToText(lights: PatchedLight[]): string {
  const lines = ['id | number | name | group | position x,y (0-1) | shape | color capability'];
  for (const l of lights) {
    const type = findFixtureType(l.typeId);
    const cct = type?.channels.find((c) => c.kind === 'cct') as { minK: number; maxK: number } | undefined;
    const color = type?.channels.some((c) => c.kind === 'red') ? 'full color (hue/sat)' : 'no color';
    const white = cct ? `tunable white ${cct.minK}-${cct.maxK} K` : 'fixed white';
    const pos = l.position ? `${l.position.x.toFixed(2)},${l.position.y.toFixed(2)}` : 'unknown';
    lines.push(`${l.id} | ${l.number ?? '-'} | ${l.name} | ${l.group ?? '-'} | ${pos} | ${l.shape?.kind ?? '-'} | ${color}, ${white}`);
  }
  return lines.join('\n');
}

const colorSchema = {
  type: 'object',
  properties: {
    intensity: { type: 'number', description: '0-1' },
    sat: { type: 'number', description: '0 = white at cct, 1 = pure color at hue' },
    hue: { type: 'number', description: '0-360 degrees (0 red, 120 green, 240 blue)' },
    cct: { type: 'number', description: 'white color temperature in kelvin, 2800-10000' },
  },
  required: ['intensity', 'sat', 'hue', 'cct'],
  additionalProperties: false,
};

/** Claude の返事の形（structured outputs の JSON Schema） */
export const showPlanSchema = {
  type: 'object',
  properties: {
    concept: { type: 'string', description: 'A short explanation of the overall lighting idea, in the language of the director’s request.' },
    cues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          start: { type: 'number', description: 'seconds' },
          end: { type: 'number', description: 'seconds' },
          label: { type: 'string', description: 'short name, e.g. "Intro build-up", in the language of the request' },
          lights: { type: 'array', items: { type: 'string' }, description: 'fixture ids' },
          pattern: { type: 'string', enum: [...cuePatterns] },
          stepBeats: { type: 'number', description: 'beats per step for pulse/chase/alternate/random (e.g. 0.5, 1, 2, 4)' },
          colors: { type: 'array', items: colorSchema, description: 'palette; at least one' },
          low: { type: 'number', description: '0-1, intensity multiplier for the "off" state of pulse/chase/alternate/random' },
          curve: { type: 'string', enum: [...cueCurves] },
          order: { type: 'string', enum: [...cueOrders] },
          density: { type: 'number', description: '0-1, share of lights lit per step for random' },
          fadeIn: { type: 'number', description: 'seconds of crossfade from the previous look at the start of the cue; 0 = cut' },
        },
        required: ['start', 'end', 'label', 'lights', 'pattern', 'stepBeats', 'colors', 'low', 'curve', 'order', 'density', 'fadeIn'],
        additionalProperties: false,
      },
    },
  },
  required: ['concept', 'cues'],
  additionalProperties: false,
} as const;

export const SHOW_SYSTEM_PROMPT = `You are a lighting designer programming a short light show for a music track in a small photo studio.
The controller is miseru. Each fixture has a look: intensity (0-1), sat (0 = white at cct, 1 = pure color), hue (0-360), cct (kelvin).
You do not write individual keyframes. You write cues; the app expands each cue into keyframes on a beat grid derived from the analysis.

Patterns:
- static: every listed light takes colors[0] at start and holds it.
- fade: the listed lights move through the colors evenly from start to end (first color at start, last at end), using curve.
- pulse: on every step all listed lights flash to the next palette color, then decay (curve) to low x intensity by 60% of the step.
- chase: one light at a time (in order) is at full, the others at low x intensity; each step moves to the next light. curve "hold" = hard chase, "ease-in-out" = soft wave.
- alternate: lights in order are split into two alternating groups (1st, 3rd, ... and 2nd, 4th, ...) that swap every step.
- random: on every step each light is lit with probability density (else low), with a random palette color.
Steps are stepBeats beats long and aligned to the bar grid. The shortest possible step is 0.15 s.
Orders: number (fixture number), left-to-right / right-to-left (x), back-to-front / front-to-back (y; y = 0 is the backdrop side, y = 1 the camera side), center-out, random.
fadeIn crossfades from whatever the lights were doing before into this cue.
A light keeps its last look until a later cue includes it. Later cues override earlier ones for the same light and time.

How to design:
- Read the whole song first. Use the sections, levels and trends to shape an arc: anticipation before the big moments (dim, sparse, rising), the peaks themselves (full, beat-synced, more lights, faster steps, stronger color), and afterglow after peaks and at the end (slow fades, warm or cool white, fewer lights).
- Mix steady pattern-based changes with some random variation so it stays alive, but change the pattern family at section boundaries, not randomly.
- Think about how many fixtures there are and where they are. With few fixtures, prefer clear contrasts over busy chases. Use positions for left/right and front/back movement.
- Put cue boundaries on bar starts (the start_s values in the table) or on the strongest hits.
- Cover the whole song from 0 s to the duration, and include every fixture in a cue that starts at 0 s. End the song with a deliberate final look (for example a fade to 0).
- This is a photo studio: avoid rapid full-intensity flashing of all fixtures for more than a few bars at a time.
- Follow the director's request below when it conflicts with this guidance.
- Write concept and labels in the language of the director's request.`;

/** Claude への 1 通目 */
export function buildUserMessage(analysisText: string, lights: PatchedLight[], direction: string): string {
  return [
    '<fixtures>',
    lightsToText(lights),
    '</fixtures>',
    '',
    '<music_analysis>',
    analysisText,
    '</music_analysis>',
    '',
    '<direction>',
    direction.trim() || '(no special request: design a show that follows the music)',
    '</direction>',
  ].join('\n');
}

// ---- 返事を Timeline に広げる ------------------------------------------------

const clamp = (v: number, lo: number, hi: number) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo);
const MIN_STEP = 0.15;
const MAX_KEYS = 30000;

function toLook(c: CueColor | undefined): Look {
  if (!c) return { intensity: 0, sat: 0, hue: 0, cct: 5600 };
  return {
    intensity: clamp(c.intensity, 0, 1),
    sat: clamp(c.sat, 0, 1),
    hue: (((Number.isFinite(c.hue) ? c.hue : 0) % 360) + 360) % 360,
    cct: clamp(c.cct, 2000, 10000),
  };
}

/** 小さな決まった乱数（同じ返事なら同じ結果になるように） */
function rng(seed: number) {
  let s = (Math.floor(seed * 1000) ^ 0x9e3779b9) >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function orderLights(ids: string[], lights: PatchedLight[], order: Cue['order'], rand: () => number): string[] {
  const info = ids.map((id) => lights.find((l) => l.id === id)!);
  const pos = (l: PatchedLight) => l.position ?? { x: 0.5, y: 0.5 };
  const by = (f: (l: PatchedLight) => number) => [...info].sort((a, b) => f(a) - f(b)).map((l) => l.id);
  switch (order) {
    case 'left-to-right':
      return by((l) => pos(l).x);
    case 'right-to-left':
      return by((l) => -pos(l).x);
    case 'back-to-front':
      return by((l) => pos(l).y);
    case 'front-to-back':
      return by((l) => -pos(l).y);
    case 'center-out':
      return by((l) => Math.hypot(pos(l).x - 0.5, pos(l).y - 0.5));
    case 'random': {
      const a = [...ids];
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    }
    default:
      return by((l) => l.number ?? 0);
  }
}

/** 拍の格子に合わせた、区間の中のステップの時刻 */
function stepTimes(start: number, end: number, step: number, grid0: number): number[] {
  const out: number[] = [];
  const k0 = Math.ceil((start - grid0) / step - 1e-6);
  let first = grid0 + k0 * step;
  if (first - start > 0.02) out.push(start);
  for (let t = first; t < end - 0.02; t += step) out.push(Math.round(t * 1000) / 1000);
  return out;
}

export interface ExpandResult {
  timeline: Timeline;
  keyCount: number;
  warnings: string[];
}

/** Claude のキューを、灯体ごとのトラックとキーにする */
export function expandPlan(plan: ShowPlan, lights: PatchedLight[], analysis: Pick<AudioAnalysis, 'duration' | 'beatPeriod' | 'firstDownbeat'>, name: string): ExpandResult {
  const duration = Math.max(1, analysis.duration);
  const known = new Set(lights.map((l) => l.id));
  const warnings: string[] = [];
  const perLight = new Map<string, Keyframe[]>(lights.map((l) => [l.id, []]));
  let total = 0;
  const cues = [...plan.cues].filter((c) => Number.isFinite(c.start) && Number.isFinite(c.end)).sort((a, b) => a.start - b.start);

  for (const cue of cues) {
    const start = clamp(cue.start, 0, duration);
    const end = clamp(cue.end, start, duration);
    if (end - start < 0.05) continue;
    const ids = cue.lights.filter((id) => known.has(id));
    const unknown = cue.lights.filter((id) => !known.has(id));
    if (unknown.length) warnings.push(`${cue.label}: unknown fixture ${unknown.join(', ')}`);
    if (ids.length === 0) continue;
    const palette = (cue.colors.length ? cue.colors : [undefined]).map(toLook);
    const low = clamp(cue.low, 0, 1);
    const dim = (l: Look): Look => ({ ...l, intensity: l.intensity * low });
    const rand = rng(start + cue.label.length);
    const ordered = orderLights(ids, lights, cue.order, rand);
    const step = Math.max(MIN_STEP, clamp(cue.stepBeats, 0.125, 64) * analysis.beatPeriod);
    const curve: Curve = cue.curve ?? 'linear';
    const cueKeys = new Map<string, Keyframe[]>(ids.map((id) => [id, []]));
    const push = (id: string, t: number, look: Look, c: Curve) => {
      const list = cueKeys.get(id)!;
      const prev = list[list.length - 1];
      if (prev && Math.abs(prev.t - t) < 0.02) list[list.length - 1] = { t, look, curve: c };
      else list.push({ t: Math.round(t * 1000) / 1000, look, curve: c });
    };
    const same = (a: Look, b: Look) => a.intensity === b.intensity && a.sat === b.sat && a.hue === b.hue && a.cct === b.cct;

    switch (cue.pattern) {
      case 'fade': {
        const n = palette.length;
        for (const id of ids) {
          if (n === 1) push(id, start, palette[0], 'hold');
          else palette.forEach((look, i) => push(id, start + ((end - start) * i) / (n - 1), look, i === n - 1 ? 'hold' : curve));
        }
        break;
      }
      case 'pulse': {
        stepTimes(start, end, step, analysis.firstDownbeat).forEach((t, i) => {
          const look = palette[i % palette.length];
          for (const id of ids) {
            push(id, t, look, curve);
            push(id, Math.min(end - 0.01, t + step * 0.6), dim(look), 'hold');
          }
        });
        break;
      }
      case 'chase':
      case 'alternate':
      case 'random': {
        const last = new Map<string, Look>();
        const density = clamp(cue.density, 0, 1);
        stepTimes(start, end, step, analysis.firstDownbeat).forEach((t, i) => {
          ordered.forEach((id, j) => {
            let on: boolean;
            let look: Look;
            if (cue.pattern === 'chase') {
              on = i % ordered.length === j;
              look = palette[Math.floor(i / ordered.length) % palette.length];
            } else if (cue.pattern === 'alternate') {
              on = j % 2 === i % 2;
              look = palette[i % palette.length];
            } else {
              on = rand() < density;
              look = palette[Math.floor(rand() * palette.length)];
            }
            const v = on ? look : dim(look);
            const prev = last.get(id);
            if (!prev || !same(prev, v)) {
              push(id, t, v, curve);
              last.set(id, v);
            }
          });
        });
        break;
      }
      default:
        for (const id of ids) push(id, start, palette[0], 'hold');
    }

    // 灯体ごとに、この区間の前のキーを残して入れ替える（あとのキューが勝つ）
    const fadeIn = clamp(cue.fadeIn, 0, end - start);
    for (const id of ids) {
      let ks = cueKeys.get(id)!;
      if (ks.length === 0) continue;
      const before = perLight.get(id)!.filter((k) => k.t < start - 0.02);
      const after = perLight.get(id)!.filter((k) => k.t >= end - 0.02);
      if (fadeIn > 0.05) {
        const cueTrack: Track = { id, name: id, lightIds: [id], keys: ks };
        const target = evaluateTrack(cueTrack, start + fadeIn)!;
        const old = perLight.get(id)!;
        const prevLook = old.length ? evaluateTrack({ id, name: id, lightIds: [id], keys: old }, start) : { ...target, intensity: 0 };
        const at = ks.filter((k) => k.t <= start + fadeIn + 0.02);
        const curveAt = at.length ? at[at.length - 1].curve : 'hold';
        ks = [
          { t: start, look: prevLook ?? target, curve: 'ease-in-out' },
          { t: Math.round((start + fadeIn) * 1000) / 1000, look: target, curve: curveAt },
          ...ks.filter((k) => k.t > start + fadeIn + 0.02),
        ];
      }
      perLight.set(id, [...before, ...ks, ...after]);
    }
    total = [...perLight.values()].reduce((s, k) => s + k.length, 0);
    if (total > MAX_KEYS) {
      warnings.push(`Stopped at "${cue.label}": more than ${MAX_KEYS} keys.`);
      break;
    }
  }

  const tracks: Track[] = lights
    .filter((l) => (perLight.get(l.id)?.length ?? 0) > 0)
    .map((l) => ({ id: `music-${l.id}`, name: lightLabel(l), lightIds: [l.id], keys: perLight.get(l.id)! }));
  const unused = lights.filter((l) => !perLight.get(l.id)?.length).map((l) => lightLabel(l));
  if (unused.length) warnings.push(`Not used: ${unused.join(', ')}`);
  return {
    timeline: { name, duration: Math.min(3600, Math.ceil(duration)), loop: false, tracks },
    keyCount: tracks.reduce((s, t) => s + t.keys.length, 0),
    warnings,
  };
}

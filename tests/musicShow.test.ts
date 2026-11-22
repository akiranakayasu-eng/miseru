import { describe, expect, it } from 'vitest';
import { analyzeAudio, analysisToText, estimateKey } from '../src/engine/audioAnalysis.js';
import { expandPlan, type Cue } from '../src/engine/musicShow.js';
import { tmuPhotoStudio } from '../src/engine/patches.js';
import { evaluateTimeline } from '../src/engine/timeline.js';

/** 124 BPM の打撃。15〜40 秒は大きく、ほかは小さい */
function clickTrack(sr = 22050, dur = 60, bpm = 124, offset = 0.3): Float32Array {
  const s = new Float32Array(sr * dur);
  const beat = 60 / bpm;
  let seed = 1;
  const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5);
  for (let i = 0; i < s.length; i++) {
    const t = i / sr;
    const amp = t < 15 ? 0.2 : t < 40 ? 1 : 0.3;
    const ph = (t - offset) % beat;
    const k = Math.floor((t - offset) / beat);
    let v = 0.02 * r() * amp;
    if (t >= offset && ph < 0.08) v += amp * (k % 4 === 0 ? 1 : 0.6) * Math.sin(2 * Math.PI * 60 * ph) * Math.exp(-ph * 40);
    s[i] = v;
  }
  return s;
}

const all = tmuPhotoStudio.lights.map((l) => l.id);
const cue = (c: Partial<Cue>): Cue => ({
  start: 0,
  end: 10,
  label: 'c',
  lights: all,
  pattern: 'static',
  stepBeats: 1,
  colors: [{ intensity: 1, sat: 0, hue: 0, cct: 5600 }],
  low: 0,
  curve: 'hold',
  order: 'number',
  density: 0.5,
  fadeIn: 0,
  ...c,
});

describe('analyzeAudio', () => {
  it('打撃の列からテンポと区切りを取る', async () => {
    const a = await analyzeAudio(clickTrack(), 22050);
    expect(a.bpm).not.toBeNull();
    expect(Math.abs(a.bpm! - 124)).toBeLessThan(0.3);
    expect(a.rows[0].t).toBe(0);
    expect(a.sections.length).toBeGreaterThanOrEqual(3);
    const peak = a.sections.find((s) => s.hint === 'peak')!;
    expect(peak.start).toBeGreaterThan(12);
    expect(peak.end).toBeLessThan(43);
    expect(analysisToText(a)).toContain('BPM');
  });
  it('キック・スネア・8 分のハイハットの曲でも 124 BPM を取り、調は出さない', async () => {
    const sr = 22050;
    const s = new Float32Array(sr * 40);
    const beat = 60 / 124;
    let seed = 7;
    const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5);
    for (let i = 0; i < s.length; i++) {
      const t = i / sr;
      const b = t % beat;
      const bi = Math.floor(t / beat) % 4;
      let v = 0.25 * r() * Math.exp(-(t % (beat / 2)) * 120);
      if (bi === 0 || bi === 2) v += Math.sin(2 * Math.PI * 55 * b) * Math.exp(-b * 25);
      else v += 0.6 * r() * Math.exp(-b * 30);
      s[i] = v;
    }
    const a = await analyzeAudio(s, sr);
    expect(Math.abs(a.bpm! - 124)).toBeLessThan(0.3);
    expect(a.key).toBe(null);
    const half = await analyzeAudio(s, sr, undefined, { bpm: 62 });
    expect(half.bpm).toBe(62);
  });
  it('ラの和音から A を調に選ぶ', () => {
    const chroma = new Array(12).fill(0.1);
    chroma[9] = 1; // A
    chroma[0] = 0.8; // C
    chroma[4] = 0.8; // E
    expect(estimateKey(chroma).key).toBe('A minor');
  });
});

describe('expandPlan', () => {
  const grid = { duration: 20, beatPeriod: 0.5, firstDownbeat: 0 };

  it('灯体ごとのトラックを作り、知らない灯体は知らせる', () => {
    const r = expandPlan({ concept: '', cues: [cue({ lights: ['arri1', 'nope'] })] }, tmuPhotoStudio.lights, grid, 'x');
    expect(r.timeline.tracks.map((t) => t.lightIds)).toEqual([['arri1']]);
    expect(r.warnings.join(' ')).toContain('nope');
    expect(r.timeline.duration).toBe(20);
  });

  it('chase は 1 台ずつ点き、ほかは low', () => {
    const lights = ['arri1', 'arri2', 'arri3'];
    const r = expandPlan({ concept: '', cues: [cue({ lights, pattern: 'chase', stepBeats: 1, low: 0.1 })] }, tmuPhotoStudio.lights, grid, 'x');
    const at = (t: number) => evaluateTimeline(r.timeline, t);
    const on = (t: number) => lights.filter((id) => at(t)[id].intensity === 1);
    expect(on(0.1)).toHaveLength(1);
    expect(on(0.6)).toHaveLength(1);
    expect(on(0.1)[0]).not.toBe(on(0.6)[0]);
    expect(at(0.1)[lights.find((id) => id !== on(0.1)[0])!].intensity).toBeCloseTo(0.1);
  });

  it('あとのキューが同じ時間を上書きし、fadeIn は前の見た目からつなぐ', () => {
    const r = expandPlan(
      {
        concept: '',
        cues: [cue({ lights: ['arri1'], end: 20 }), cue({ lights: ['arri1'], start: 10, end: 20, colors: [{ intensity: 0, sat: 0, hue: 0, cct: 5600 }], fadeIn: 2 })],
      },
      tmuPhotoStudio.lights,
      grid,
      'x',
    );
    const v = (t: number) => evaluateTimeline(r.timeline, t).arri1.intensity;
    expect(v(5)).toBe(1);
    expect(v(10)).toBeCloseTo(1);
    expect(v(11)).toBeGreaterThan(0);
    expect(v(11)).toBeLessThan(1);
    expect(v(12.5)).toBe(0);
  });

  it('ステップは 0.15 秒より短くしない', () => {
    const r = expandPlan({ concept: '', cues: [cue({ lights: ['arri1'], pattern: 'pulse', stepBeats: 0.125, end: 3 })] }, tmuPhotoStudio.lights, grid, 'x');
    const ts = r.timeline.tracks[0].keys.map((k) => k.t);
    for (let i = 2; i < ts.length; i += 2) expect(ts[i] - ts[i - 2]).toBeGreaterThanOrEqual(0.149);
  });
});

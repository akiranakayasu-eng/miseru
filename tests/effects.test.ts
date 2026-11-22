import { describe, expect, it } from 'vitest';
import { applyFx, applyFxAll, defaultFx, sanitizeFx, type Fx } from '../src/engine/effects.js';
import { applyCommand, initialState, renderUniverse } from '../src/engine/show.js';
import { tmuPhotoStudio } from '../src/engine/patches.js';
import { evaluateTrack, parseTimeline } from '../src/engine/timeline.js';
import type { Look } from '../src/engine/color.js';

const base: Look = { intensity: 0.8, sat: 0, hue: 0, cct: 5600, tint: 0 };
const withFx = (fx: Partial<Fx> & { kind: Fx['kind'] }): Look => ({ ...base, fx: { ...defaultFx(fx.kind), ...fx } });

describe('applyFx', () => {
  it('演出が無ければそのまま', () => {
    expect(applyFx(base, 1.23)).toBe(base);
  });
  it('Strobe: 1 周の最初の 30% だけ点き、残りは depth の分だけ落ちる', () => {
    const l = withFx({ kind: 'strobe', speed: 2, depth: 1 });
    expect(applyFx(l, 0).intensity).toBeCloseTo(0.8);
    expect(applyFx(l, 0.25).intensity).toBeCloseTo(0);
    expect(applyFx({ ...l, fx: { ...l.fx!, depth: 0.5 } }, 0.25).intensity).toBeCloseTo(0.4);
  });
  it('Pulse: 半周で一番暗く、1 周で戻る', () => {
    const l = withFx({ kind: 'pulse', speed: 1, depth: 1 });
    expect(applyFx(l, 0).intensity).toBeCloseTo(0.8);
    expect(applyFx(l, 0.5).intensity).toBeCloseTo(0);
    expect(applyFx(l, 1).intensity).toBeCloseTo(0.8);
  });
  it('Chase: 1 段ごとに 1 台ずつ点く（順・逆・往復）', () => {
    const l = withFx({ kind: 'chase', speed: 1, depth: 1 });
    const lit = (t: number, order: Fx['order']) => [0, 1, 2].map((i) => applyFx({ ...l, fx: { ...l.fx!, order } }, t, i, 3).intensity > 0.5);
    expect(lit(0, 'forward')).toEqual([true, false, false]);
    expect(lit(1, 'forward')).toEqual([false, true, false]);
    expect(lit(0, 'reverse')).toEqual([false, false, true]);
    expect([0, 1, 2, 3, 4].map((s) => lit(s, 'bounce').indexOf(true))).toEqual([0, 1, 2, 1, 0]);
  });
  it('Rainbow: 色相が回り、彩度が上がる', () => {
    const l = withFx({ kind: 'rainbow', speed: 0.25, depth: 1 });
    const r = applyFx(l, 1);
    expect(r.hue).toBeCloseTo(90);
    expect(r.sat).toBe(1);
    expect(r.intensity).toBe(0.8);
  });
  it('Flicker: 明るさは 0 から元の明るさの間', () => {
    const l = withFx({ kind: 'flicker' });
    for (let t = 0; t < 5; t += 0.37) {
      const v = applyFx(l, t).intensity;
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(0.8);
    }
  });
});

describe('sanitizeFx', () => {
  it('知らない種類は null、速さは 10 Hz まで', () => {
    expect(sanitizeFx({ kind: 'laser' })).toBeNull();
    expect(sanitizeFx({ kind: 'strobe', speed: 99, depth: 3 })).toEqual({ kind: 'strobe', speed: 10, depth: 1, order: 'forward' });
  });
});

describe('show と演出', () => {
  const ids = tmuPhotoStudio.lights.map((l) => l.id);
  it('set で付けて null で外す。Work Light で外れる', () => {
    let s = initialState(tmuPhotoStudio);
    s = applyCommand(tmuPhotoStudio, s, { type: 'set', ids: ['arri1'], look: { intensity: 1, fx: defaultFx('strobe') } });
    expect(s.looks.arri1.fx?.kind).toBe('strobe');
    expect(s.looks.arri2.fx).toBeUndefined();
    s = applyCommand(tmuPhotoStudio, s, { type: 'set', ids: ['arri1'], look: { fx: null } });
    expect(s.looks.arri1.fx).toBeNull();
    s = applyCommand(tmuPhotoStudio, s, { type: 'set', ids, look: { fx: defaultFx('chase') } });
    s = applyCommand(tmuPhotoStudio, s, { type: 'allOn' });
    expect(Object.values(s.looks).every((l) => !l.fx)).toBe(true);
  });
  it('renderUniverse は時間を渡したときだけ演出をかける', () => {
    let s = initialState(tmuPhotoStudio);
    s = applyCommand(tmuPhotoStudio, s, { type: 'set', ids: ['arri1'], look: { intensity: 1, fx: { kind: 'strobe', speed: 2, depth: 1 } } });
    expect(renderUniverse(tmuPhotoStudio, s)[0]).toBe(255);
    expect(renderUniverse(tmuPhotoStudio, s, 0)[0]).toBe(255);
    expect(renderUniverse(tmuPhotoStudio, s, 0.25)[0]).toBe(0);
  });
  it('Chase の順番は番号の順', () => {
    const looks = Object.fromEntries(ids.map((id) => [id, withFx({ kind: 'chase', speed: 1 })]));
    const out = applyFxAll(tmuPhotoStudio.lights, looks, 0);
    const first = tmuPhotoStudio.lights.find((l) => l.number === 1)!.id;
    expect(Object.entries(out).filter(([, l]) => l.intensity > 0.5).map(([id]) => id)).toEqual([first]);
  });
});

describe('タイムラインと演出', () => {
  it('キーの演出は次のキーまで続き、速さは次のキーで切り替わる。読み込みでも残る', () => {
    const tl = parseTimeline({
      duration: 10,
      tracks: [
        {
          id: 'a',
          name: 'A',
          lightIds: ['arri1'],
          keys: [
            { t: 0, look: { intensity: 1, fx: { kind: 'pulse', speed: 1, depth: 1 } }, curve: 'linear' },
            { t: 4, look: { intensity: 1, fx: { kind: 'pulse', speed: 3, depth: 1 } }, curve: 'linear' },
            { t: 8, look: { intensity: 1 }, curve: 'linear' },
          ],
        },
      ],
    })!;
    const tr = tl.tracks[0];
    expect(evaluateTrack(tr, 2)!.fx).toMatchObject({ kind: 'pulse', speed: 1 });
    expect(evaluateTrack(tr, 6)!.fx).toMatchObject({ kind: 'pulse', speed: 3 });
    expect(evaluateTrack(tr, 9)!.fx).toBeUndefined();
  });
});

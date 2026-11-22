import { describe, expect, it } from 'vitest';
import { tmuPhotoStudio } from '../src/engine/patches.js';
import { applyCommand, initialState } from '../src/engine/show.js';
import {
  addKey, applyCurve, emptyTimeline, evaluateTimeline, evaluateTrack, moveKey, parseTimeline, removeKey,
  type Keyframe, type Track,
} from '../src/engine/timeline.js';

const key = (t: number, intensity: number, hue = 0, curve: Keyframe['curve'] = 'linear'): Keyframe => ({
  t, curve, look: { intensity, sat: 1, hue, cct: 5600 },
});
const track = (keys: Keyframe[], lightIds = ['arri1']): Track => ({ id: 't', name: 't', lightIds, keys });

describe('applyCurve', () => {
  it('端は 0 と 1', () => {
    for (const c of ['linear', 'ease-in', 'ease-out', 'ease-in-out'] as const) {
      expect(applyCurve(c, 0)).toBeCloseTo(0, 3);
      expect(applyCurve(c, 1)).toBeCloseTo(1, 3);
    }
  });
  it('linear は直線、ease-in は前半が遅い、ease-out は前半が速い', () => {
    expect(applyCurve('linear', 0.3)).toBeCloseTo(0.3);
    expect(applyCurve('ease-in', 0.3)).toBeLessThan(0.3);
    expect(applyCurve('ease-out', 0.3)).toBeGreaterThan(0.3);
    expect(applyCurve('ease-in-out', 0.5)).toBeCloseTo(0.5, 2);
  });
  it('hold は次のキーまで動かない', () => {
    expect(applyCurve('hold', 0.99)).toBe(0);
    expect(applyCurve('hold', 1)).toBe(1);
  });
  it('自分で決めた bezier も使える', () => {
    expect(applyCurve([0.5, 0, 0.5, 1], 0.5)).toBeCloseTo(0.5, 2);
  });
});

describe('evaluateTrack', () => {
  const tr = track([key(1, 0), key(3, 1)]);
  it('キーがなければ null', () => expect(evaluateTrack(track([]), 1)).toBeNull());
  it('最初のキーより前、最後のキーより後は端の値のまま', () => {
    expect(evaluateTrack(tr, 0)!.intensity).toBe(0);
    expect(evaluateTrack(tr, 10)!.intensity).toBe(1);
  });
  it('間は混ぜる', () => expect(evaluateTrack(tr, 2)!.intensity).toBeCloseTo(0.5));
  it('色相は近いほうへ回る', () => {
    const t = track([key(0, 1, 350), key(1, 1, 10)]);
    const h = evaluateTrack(t, 0.5)!.hue;
    expect(Math.min(h, 360 - h)).toBeLessThan(1); // 0° 付近
  });
  it('hold は次のキーで切り替わる', () => {
    const t = track([key(0, 0, 0, 'hold'), key(2, 1)]);
    expect(evaluateTrack(t, 1.9)!.intensity).toBe(0);
    expect(evaluateTrack(t, 2)!.intensity).toBe(1);
  });
});

describe('evaluateTimeline とショーへの反映', () => {
  it('あとのトラックが上書きする', () => {
    const tl = emptyTimeline();
    tl.tracks = [track([key(0, 0.2)], ['arri1', 'arri2']), track([key(0, 0.9)], ['arri2'])];
    const out = evaluateTimeline(tl, 0);
    expect(out.arri1.intensity).toBe(0.2);
    expect(out.arri2.intensity).toBe(0.9);
  });
  it('looks 命令で状態に入り、範囲外や知らないライトは無視する', () => {
    const s0 = initialState(tmuPhotoStudio);
    const s1 = applyCommand(tmuPhotoStudio, s0, {
      type: 'looks',
      looks: { arri1: { intensity: 5, sat: -1, hue: 120, cct: 3200 }, nobody: { intensity: 1, sat: 1, hue: 0, cct: 5600 } },
    });
    expect(s1.looks.arri1).toEqual({ intensity: 1, sat: 0, hue: 120, cct: 3200, tint: 0 });
    expect(s1.looks.nobody).toBeUndefined();
    expect(s1.looks.arri2).toEqual(s0.looks.arri2);
  });
});

describe('編集', () => {
  it('キーは時間順に並び、同じ時間は置き換わる', () => {
    let t = track([]);
    t = addKey(t, key(2, 1));
    t = addKey(t, key(1, 0.5));
    t = addKey(t, key(2.005, 0.7));
    expect(t.keys.map((k) => k.t)).toEqual([1, 2.005]);
    expect(t.keys[1].look.intensity).toBe(0.7);
  });
  it('動かしても隣を飛び越えない', () => {
    const t = track([key(1, 0), key(2, 1), key(3, 0)]);
    const m = moveKey(t, 1, 9, 10);
    expect(m.keys[1].t).toBeLessThan(3);
    expect(moveKey(t, 0, -5, 10).keys[0].t).toBe(0);
  });
  it('消せる', () => expect(removeKey(track([key(1, 0), key(2, 1)]), 0).keys).toHaveLength(1));
});

describe('parseTimeline', () => {
  it('壊れたデータを拒否し、範囲外を直す', () => {
    expect(parseTimeline(null)).toBeNull();
    expect(parseTimeline({ tracks: 3 })).toBeNull();
    const tl = parseTimeline({
      duration: 99999,
      tracks: [{ lightIds: ['a'], keys: [{ t: -4, curve: 'bogus', look: { intensity: 7 } }, { t: 'x' }] }],
    })!;
    expect(tl.duration).toBe(3600);
    expect(tl.tracks[0].keys[0]).toMatchObject({ t: 0, curve: 'linear', look: { intensity: 1 } });
  });
});

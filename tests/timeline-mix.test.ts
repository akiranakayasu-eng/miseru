import { describe, expect, it } from 'vitest';
import { mixLook } from '../src/engine/timeline.js';

describe('mixLook', () => {
  it('黒（明るさ 0）から青へは、途中で別の色相を通らない', () => {
    const black = { intensity: 0, sat: 1, hue: 25, cct: 5600 };
    const blue = { intensity: 1, sat: 1, hue: 240, cct: 5600 };
    for (const u of [0.1, 0.5, 0.9]) {
      const m = mixLook(black, blue, u);
      expect(m.hue).toBe(240);
      expect(m.sat).toBe(1);
      expect(m.intensity).toBeCloseTo(u);
    }
  });
  it('青から黒へも青のまま暗くなる', () => {
    const blue = { intensity: 1, sat: 1, hue: 240, cct: 5600 };
    const black = { intensity: 0, sat: 0, hue: 0, cct: 3200 };
    const m = mixLook(blue, black, 0.5);
    expect(m.hue).toBe(240);
    expect(m.sat).toBe(1);
    expect(m.cct).toBe(5600);
    expect(m.intensity).toBeCloseTo(0.5);
  });
  it('白（彩度 0）から青へは、色相を回さずに彩度だけ上がる', () => {
    const white = { intensity: 1, sat: 0, hue: 0, cct: 5600 };
    const blue = { intensity: 1, sat: 1, hue: 240, cct: 5600 };
    const m = mixLook(white, blue, 0.5);
    expect(m.hue).toBe(240);
    expect(m.sat).toBeCloseTo(0.5);
  });
  it('色どうしは今までどおり近い回りかた', () => {
    const a = { intensity: 1, sat: 1, hue: 350, cct: 5600 };
    const b = { intensity: 1, sat: 1, hue: 10, cct: 5600 };
    expect(mixLook(a, b, 0.5).hue).toBeCloseTo(0);
  });
});

import { describe, expect, it } from 'vitest';
import { cctToRgb, hueToRgb, renderFixture } from '../src/engine/color.js';
import { arriL7cMode1, findFixtureType } from '../src/engine/fixtures.js';

const t = (id: string) => findFixtureType(id)!;

describe('hueToRgb', () => {
  it('赤・緑・青', () => {
    expect(hueToRgb(0)).toEqual([1, 0, 0]);
    expect(hueToRgb(120)).toEqual([0, 1, 0]);
    expect(hueToRgb(240)).toEqual([0, 0, 1]);
    expect(hueToRgb(360)).toEqual([1, 0, 0]);
  });
});

describe('cctToRgb', () => {
  it('低い色温度は赤み、高い色温度は青み', () => {
    const warm = cctToRgb(2700);
    const cool = cctToRgb(9000);
    expect(warm[0]).toBe(1);
    expect(warm[2]).toBeLessThan(0.6);
    expect(cool[2]).toBe(1);
    expect(cool[0]).toBeLessThan(0.9);
  });
});

describe('renderFixture', () => {
  it('RGBW: 白は W だけで出す', () => {
    const v = renderFixture(t('rgbw-4ch'), { intensity: 1, sat: 0, hue: 0, cct: 6500 });
    expect(v[3]).toBe(255);
    expect(Math.max(v[0], v[1], v[2])).toBeLessThan(20);
  });

  it('RGBW: 濃い赤は R だけ', () => {
    const v = renderFixture(t('rgbw-4ch'), { intensity: 1, sat: 1, hue: 0, cct: 5600 });
    expect(v).toEqual([255, 0, 0, 0]);
  });

  it('明るさチャンネルがないときは色の値ごと暗くする', () => {
    const v = renderFixture(t('rgb-3ch'), { intensity: 0.5, sat: 1, hue: 240, cct: 5600 });
    expect(v).toEqual([0, 0, 128]);
  });

  it('明るさチャンネルがあるときは色は 100% のまま', () => {
    const v = renderFixture(t('dim-rgb-4ch'), { intensity: 0.5, sat: 1, hue: 240, cct: 5600 });
    expect(v).toEqual([128, 0, 0, 255]);
  });

  it('ARRI Mode 1: 白は CCT 側、クロスフェード 0、固定チャンネルは 0', () => {
    const v = renderFixture(arriL7cMode1, { intensity: 1, sat: 0, hue: 0, cct: 2800 });
    expect(v).toHaveLength(12);
    expect(v[0]).toBe(255); // dimmer
    expect(v[1]).toBe(0); // 2800K = 下端
    expect(v[2]).toBe(128); // tint 中立
    expect(v[3]).toBe(0); // xfade = 白
    expect(v.slice(8)).toEqual([0, 0, 0, 0]);
  });

  it('Tint: -1 → 0（グリーン）、0 → 中立 128、+1 → 255（マゼンタ）', () => {
    const at = (tint: number) => renderFixture(arriL7cMode1, { intensity: 1, sat: 0, hue: 0, cct: 5600, tint })[2];
    expect(at(-1)).toBe(0);
    expect(at(0)).toBe(128);
    expect(at(1)).toBe(255);
  });

  it('ARRI Mode 1: 色の濃さがクロスフェードになる', () => {
    const v = renderFixture(arriL7cMode1, { intensity: 1, sat: 1, hue: 120, cct: 10000 });
    expect(v[1]).toBe(255);
    expect(v[3]).toBe(255);
    expect(v.slice(4, 8)).toEqual([0, 255, 0, 0]);
  });
});

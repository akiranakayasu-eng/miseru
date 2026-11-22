import { describe, expect, it } from 'vitest';
import { tmuPhotoStudio } from '../src/engine/patches.js';
import { applyCommand, initialState, renderUniverse, validatePatch, type Patch } from '../src/engine/show.js';

const patch = tmuPhotoStudio;

describe('スタジオのパッチ', () => {
  it('重なりもはみ出しもない', () => {
    expect(validatePatch(patch)).toEqual([]);
  });

  it('68ch を使う', () => {
    const s = applyCommand(patch, initialState(patch), { type: 'allOn' });
    const data = renderUniverse(patch, s);
    expect(data[0]).toBe(255); // スポット 1 の明るさ
    expect(data[36]).toBe(255); // パネル 1 の明るさ（ch 37）
    expect(data[60]).toBe(255); // パネル 4 の明るさ（ch 61）
    expect(Array.from(data.slice(68)).every((v) => v === 0)).toBe(true);
  });
});

describe('validatePatch', () => {
  it('アドレスの重なりを見つける', () => {
    const bad: Patch = {
      name: 'x',
      universe: 0,
      lights: [
        { id: 'a', name: 'A', typeId: 'rgbw-4ch', address: 1 },
        { id: 'b', name: 'B', typeId: 'rgbw-4ch', address: 3 },
      ],
    };
    expect(validatePatch(bad).length).toBeGreaterThan(0);
  });
});

describe('操作', () => {
  it('全消灯は明るさだけを 0 にし、解除すると元に戻る', () => {
    let s = applyCommand(patch, initialState(patch), { type: 'set', ids: ['arri1'], look: { intensity: 0.8 } });
    s = applyCommand(patch, s, { type: 'blackout', on: true });
    expect(renderUniverse(patch, s)[0]).toBe(0);
    s = applyCommand(patch, s, { type: 'blackout', on: false });
    expect(renderUniverse(patch, s)[0]).toBe(204);
  });

  it('最初に戻すと全部 0 になる', () => {
    let s = applyCommand(patch, initialState(patch), { type: 'allOn' });
    s = applyCommand(patch, s, { type: 'reset' });
    const data = renderUniverse(patch, s);
    expect(patch.lights.every((l) => data[l.address - 1] === 0)).toBe(true);
    expect(s.blackout).toBe(false);
  });

  it('範囲外の値は 0..1 に収める', () => {
    const s = applyCommand(patch, initialState(patch), { type: 'set', ids: ['diva1'], look: { intensity: 3, sat: -1 } });
    expect(s.looks.diva1.intensity).toBe(1);
    expect(s.looks.diva1.sat).toBe(0);
  });

  it('Full On は点いている照明も含めて全部を 100% の 5600K の白にする', () => {
    let s = applyCommand(patch, initialState(patch), { type: 'set', ids: ['arri1'], look: { intensity: 0.5, sat: 1, hue: 240, cct: 3200 } });
    s = applyCommand(patch, s, { type: 'blackout', on: true });
    s = applyCommand(patch, s, { type: 'master', value: 0.3 });
    s = applyCommand(patch, s, { type: 'allOn' });
    expect(s.blackout).toBe(false);
    expect(s.master).toBe(1);
    for (const l of Object.values(s.looks)) expect(l).toMatchObject({ intensity: 1, sat: 0, cct: 5600 });
  });

  it('Full On 中にもう一度押すと押す前の色に戻る（Blackout は解除のまま）。途中で照明を変えたら戻さない', () => {
    let s = applyCommand(patch, initialState(patch), { type: 'set', ids: ['arri1'], look: { intensity: 0.5, sat: 1, hue: 240 } });
    s = applyCommand(patch, s, { type: 'blackout', on: true });
    const before = s;
    s = applyCommand(patch, s, { type: 'allOn' });
    expect(s.fullOn).toBeTruthy();
    s = applyCommand(patch, s, { type: 'allOn' });
    expect(s.looks).toEqual(before.looks);
    expect(s.blackout).toBe(false); // Blackout には戻らず、Blackout の前の色で点く
    expect(s.fullOn).toBeNull();
    s = applyCommand(patch, s, { type: 'allOn' });
    s = applyCommand(patch, s, { type: 'set', ids: ['diva1'], look: { hue: 10 } });
    expect(s.fullOn).toBeNull();
  });

  it('Work Light → Blackout → 解除 でも Work Light の前の色に戻る', () => {
    let s = applyCommand(patch, initialState(patch), { type: 'set', ids: ['arri1'], look: { intensity: 0.5, sat: 1, hue: 240 } });
    const before = s;
    s = applyCommand(patch, s, { type: 'allOn' });
    s = applyCommand(patch, s, { type: 'blackout', on: true });
    expect(s.fullOn).toBeNull(); // Blackout と Work Light は同時に入らない
    expect(s.blackout).toBe(true);
    s = applyCommand(patch, s, { type: 'blackout', on: false });
    expect(s.looks).toEqual(before.looks);
    expect(s.blackout).toBe(false);
    expect(s.fullOn).toBeNull();
  });

  it('マスターで全体を暗くする', () => {
    let s = applyCommand(patch, initialState(patch), { type: 'allOn' });
    s = applyCommand(patch, s, { type: 'master', value: 0.5 });
    expect(renderUniverse(patch, s)[0]).toBe(128);
  });
});

describe('外から届く変なデータ', () => {
  it('知らない命令や壊れた値では状態を壊さない', () => {
    const s0 = initialState(patch);
    // @ts-expect-error 型にない命令
    expect(applyCommand(patch, s0, { type: 'nope' })).toBe(s0);
    // @ts-expect-error 値が文字列
    const s1 = applyCommand(patch, s0, { type: 'set', ids: ['arri1'], look: { intensity: 'x', hue: 10 } });
    expect(s1.looks.arri1.intensity).toBe(0);
    expect(s1.looks.arri1.hue).toBe(10);
    // @ts-expect-error master が文字列
    expect(applyCommand(patch, s0, { type: 'master', value: 'a' })).toBe(s0);
  });
});

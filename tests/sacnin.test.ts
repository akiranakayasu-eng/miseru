import { describe, expect, it } from 'vitest';
import { buildSacnForTest, parseSacn } from '../src/box/sacnIn.js';

describe('sACN（E1.31）を読む', () => {
  it('ユニバースとスロットを読む', () => {
    const data = new Uint8Array(512).map((_, i) => i & 0xff);
    const p = parseSacn(buildSacnForTest(1, data));
    expect(p).toMatchObject({ universe: 1, terminated: false });
    expect(p?.data?.length).toBe(512);
    expect(p?.data?.[3]).toBe(3);
  });

  it('Stream_Terminated を読む', () => {
    expect(parseSacn(buildSacnForTest(7, new Uint8Array(4), { terminated: true }))).toMatchObject({
      universe: 7,
      terminated: true,
    });
  });

  it('512 未満のスロットも読める', () => {
    expect(parseSacn(buildSacnForTest(1, new Uint8Array([1, 2, 3])))?.data).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('形がちがえば null', () => {
    const bad = buildSacnForTest(1, new Uint8Array(512));
    bad[4] = 0; // ACN の識別子を壊す
    expect(parseSacn(bad)).toBeNull();
    expect(parseSacn(new Uint8Array(10))).toBeNull();
  });
});

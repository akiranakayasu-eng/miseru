import { describe, expect, it } from 'vitest';
import { buildArtDmx } from '../src/server/artnet.js';

describe('buildArtDmx', () => {
  it('ヘッダーとデータ', () => {
    const data = new Uint8Array(512);
    data[0] = 255;
    data[511] = 7;
    const p = buildArtDmx(0, data, 3);
    expect(p.length).toBe(530);
    expect(p.subarray(0, 8).toString('ascii')).toBe('Art-Net\0');
    expect(p.readUInt16LE(8)).toBe(0x5000);
    expect(p.readUInt16BE(10)).toBe(14);
    expect(p[12]).toBe(3);
    expect(p.readUInt16BE(16)).toBe(512);
    expect(p[18]).toBe(255);
    expect(p[529]).toBe(7);
  });

  it('ユニバース番号を SubUni と Net に分ける', () => {
    const p = buildArtDmx(0x0123, new Uint8Array(512));
    expect(p[14]).toBe(0x23);
    expect(p[15]).toBe(0x01);
  });

  it('奇数の長さは偶数に切り上げる', () => {
    const p = buildArtDmx(0, new Uint8Array(3));
    expect(p.readUInt16BE(16)).toBe(4);
  });
});

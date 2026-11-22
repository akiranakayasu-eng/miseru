import { describe, expect, it } from 'vitest';
import { buildSacn, sacnMulticastAddress } from '../src/server/sacn.js';

const cid = new Uint8Array(16).map((_, i) => i + 1);

describe('buildSacn', () => {
  const data = new Uint8Array(512);
  data[0] = 255;
  data[511] = 9;
  const p = buildSacn({ cid, sourceName: 'miseru', universe: 0x0102, priority: 120, sequence: 7, data });

  it('E1.31 の長さと各層の長さ', () => {
    expect(p.length).toBe(638);
    expect(p.readUInt16BE(0)).toBe(0x10);
    expect(p.subarray(4, 16).toString('ascii')).toBe('ASC-E1.17\0\0\0');
    expect(p.readUInt16BE(16)).toBe(0x7000 | 622);
    expect(p.readUInt16BE(38)).toBe(0x7000 | 600);
    expect(p.readUInt16BE(115)).toBe(0x7000 | 523);
  });
  it('CID・名前・優先度・連番・ユニバース', () => {
    expect(Array.from(p.subarray(22, 38))).toEqual(Array.from(cid));
    expect(p.subarray(44, 50).toString('utf8')).toBe('miseru');
    expect(p[108]).toBe(120);
    expect(p[111]).toBe(7);
    expect(p.readUInt16BE(113)).toBe(0x0102);
  });
  it('DMX データはスタートコード 0 のあと 512 スロット', () => {
    expect(p.readUInt16BE(123)).toBe(513);
    expect(p[125]).toBe(0);
    expect(p[126]).toBe(255);
    expect(p[637]).toBe(9);
  });
  it('範囲外のユニバースは拒否', () => {
    expect(() => buildSacn({ cid, sourceName: 'x', universe: 0, priority: 100, sequence: 0, data })).toThrow();
    expect(() => buildSacn({ cid, sourceName: 'x', universe: 64000, priority: 100, sequence: 0, data })).toThrow();
  });
  it('マルチキャストのアドレス', () => {
    expect(sacnMulticastAddress(1)).toBe('239.255.0.1');
    expect(sacnMulticastAddress(0x0102)).toBe('239.255.1.2');
  });
});

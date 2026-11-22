import { describe, expect, it } from 'vitest';
import { buildUsbProPacket } from '../src/ui/usbPro.js';

describe('buildUsbProPacket', () => {
  it('開始 0x7E・ラベル 6・長さ・スタートコード・データ・終了 0xE7', () => {
    const data = new Uint8Array(512);
    data[0] = 200;
    data[511] = 5;
    const p = buildUsbProPacket(data);
    expect(p.length).toBe(518);
    expect(Array.from(p.slice(0, 5))).toEqual([0x7e, 6, 0x01, 0x02, 0]); // 513 = 0x0201
    expect(p[5]).toBe(200);
    expect(p[516]).toBe(5);
    expect(p[517]).toBe(0xe7);
  });
  it('短いデータはその長さで送る', () => {
    const p = buildUsbProPacket(new Uint8Array([1, 2, 3]));
    expect(Array.from(p)).toEqual([0x7e, 6, 4, 0, 0, 1, 2, 3, 0xe7]);
  });
});

import { describe, expect, it } from 'vitest';
import { buildArtDmx } from '../src/server/artnet.js';
import { ArtNetInputs, parseArtDmx, SOURCE_TIMEOUT_MS } from '../src/server/sources.js';

describe('parseArtDmx', () => {
  it('自分で作ったパケットを読み戻せる', () => {
    const data = new Uint8Array(512);
    data[0] = 9;
    data[67] = 200;
    const p = parseArtDmx(buildArtDmx(0x105, data))!;
    expect(p.universe).toBe(0x105);
    expect(p.data[0]).toBe(9);
    expect(p.data[67]).toBe(200);
  });

  it('Art-Net 以外は null', () => {
    expect(parseArtDmx(Buffer.from('hello world, not art-net'))).toBeNull();
  });
});

describe('ArtNetInputs', () => {
  it('送り主ごとに分け、届かなくなったら alive を false にする', () => {
    let changes = 0;
    const inputs = new ArtNetInputs(0, () => changes++);
    inputs.receive(buildArtDmx(0, new Uint8Array(512)), '192.0.2.50', 1000);
    inputs.receive(buildArtDmx(0, new Uint8Array(512)), '192.0.2.50', 1100);
    inputs.receive(buildArtDmx(1, new Uint8Array(512)), '192.0.2.60', 1100); // 違うユニバースは無視
    expect(changes).toBe(1);
    expect(inputs.list(1200)).toEqual([{ id: 'artnet:192.0.2.50', label: 'Art-Net 192.0.2.50', alive: true }]);
    expect(inputs.list(1100 + SOURCE_TIMEOUT_MS + 1)[0].alive).toBe(false);
  });
});

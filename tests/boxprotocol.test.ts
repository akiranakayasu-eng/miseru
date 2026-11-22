import { describe, expect, it } from 'vitest';
import { decodeFrame, encodeFrame, parseClientMessage } from '../src/box/protocol.js';

describe('フレームの形', () => {
  it('先頭 0x01、ポート番号、スロット 1〜512 の 514 バイト', () => {
    const slots = new Uint8Array(512);
    slots[0] = 255;
    slots[511] = 7;
    const buf = encodeFrame(slots, 0);
    expect(buf.length).toBe(514);
    expect(buf[0]).toBe(0x01);
    expect(buf[1]).toBe(0);
    expect(buf[2]).toBe(255);
    expect(buf[513]).toBe(7);
  });

  it('読み戻せる。種類がちがうものは null', () => {
    const f = decodeFrame(encodeFrame(new Uint8Array(512).fill(9), 0))!;
    expect(f.port).toBe(0);
    expect(f.slots[100]).toBe(9);
    expect(decodeFrame(new Uint8Array([0x02, 0, 1]))).toBeNull();
    expect(decodeFrame(new Uint8Array([0x01]))).toBeNull();
  });
});

describe('parseClientMessage', () => {
  it('仕様の JSON を読める', () => {
    expect(parseClientMessage('{"t":"hello","id":"abcd","app":"miseru","v":0}')).toMatchObject({ t: 'hello', id: 'abcd' });
    expect(parseClientMessage('{"t":"claim"}')).toEqual({ t: 'claim' });
    expect(parseClientMessage('{"t":"show_mode","on":true}')).toEqual({ t: 'show_mode', on: true });
  });

  it('壊れた JSON や知らない種類は null', () => {
    expect(parseClientMessage('not json')).toBeNull();
    expect(parseClientMessage('{"t":"nope"}')).toBeNull();
    expect(parseClientMessage('{"t":"hello"}')).toBeNull();
    expect(parseClientMessage('{"t":"show_mode"}')).toBeNull();
    expect(parseClientMessage('null')).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import { decodeShowFile, encodeShowFile, isShowFile } from '../src/engine/showFile.js';
import type { Timeline } from '../src/engine/timeline.js';

const tl: Timeline = {
  name: 'Music: song.mp3',
  duration: 12,
  loop: false,
  tracks: [{ id: 't1', name: '1 ARRI L7-C', lightIds: ['arri1'], keys: [{ t: 0, look: { intensity: 1, sat: 0, hue: 0, cct: 5600 }, curve: 'linear' }] }],
};

describe('showFile', () => {
  it('Timeline と曲を 1 つにまとめて、そのまま戻す', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255, 77]);
    const file = encodeShowFile(tl, { name: 'song.mp3', type: 'audio/mpeg', bytes });
    expect(isShowFile(file)).toBe(true);
    const back = decodeShowFile(file)!;
    expect(back.timeline.tracks[0].keys[0].look.intensity).toBe(1);
    expect(back.timeline.duration).toBe(12);
    expect(back.media!.name).toBe('song.mp3');
    expect(back.media!.type).toBe('audio/mpeg');
    expect(Array.from(back.media!.bytes)).toEqual([0, 1, 2, 250, 255, 77]);
  });
  it('曲なしでも開ける', () => {
    const back = decodeShowFile(encodeShowFile(tl, null))!;
    expect(back.media).toBe(null);
    expect(back.timeline.name).toBe('Music: song.mp3');
  });
  it('Timeline だけの .miseru.json（前の Save As…）も開ける', () => {
    const back = decodeShowFile(new TextEncoder().encode(JSON.stringify(tl)))!;
    expect(back.timeline.tracks).toHaveLength(1);
    expect(back.media).toBe(null);
  });
  it('関係ないファイルは null', () => {
    expect(decodeShowFile(new TextEncoder().encode('hello'))).toBe(null);
  });
});

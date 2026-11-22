// Timeline と曲を 1 つのファイル（.miseru）にまとめる・開く。2026-11-21 Akira さんの依頼
// （Music で作った演出を、曲ごと Box や iCloud に置いて PC・スマホで開けるように）。
// 形: 先頭 12 バイト "MISERU-SHOW\n"、4 バイト（LE）で JSON の長さ、JSON、そのあとに曲のバイト列。

import { parseTimeline, type Timeline } from './timeline.js';

const MAGIC = 'MISERU-SHOW\n';

export interface ShowMedia {
  name: string;
  type: string;
  bytes: Uint8Array;
}

export function encodeShowFile(timeline: Timeline, media?: ShowMedia | null): Uint8Array {
  const head = new TextEncoder().encode(
    JSON.stringify({ format: 'miseru-show', version: 1, timeline, media: media ? { name: media.name, type: media.type, size: media.bytes.length } : null }),
  );
  const magic = new TextEncoder().encode(MAGIC);
  const out = new Uint8Array(magic.length + 4 + head.length + (media?.bytes.length ?? 0));
  out.set(magic, 0);
  new DataView(out.buffer).setUint32(magic.length, head.length, true);
  out.set(head, magic.length + 4);
  if (media) out.set(media.bytes, magic.length + 4 + head.length);
  return out;
}

export function isShowFile(bytes: Uint8Array): boolean {
  const magic = new TextEncoder().encode(MAGIC);
  return bytes.length >= magic.length + 4 && magic.every((b, i) => bytes[i] === b);
}

/** .miseru を開く。Timeline だけの JSON（Save As… の古い形）も開ける。読めなければ null */
export function decodeShowFile(bytes: Uint8Array): { timeline: Timeline; media: ShowMedia | null } | null {
  try {
    if (!isShowFile(bytes)) {
      const timeline = parseTimeline(JSON.parse(new TextDecoder().decode(bytes)));
      return timeline ? { timeline, media: null } : null;
    }
    const at = MAGIC.length;
    const len = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(at, true);
    const head = JSON.parse(new TextDecoder().decode(bytes.subarray(at + 4, at + 4 + len))) as {
      timeline?: unknown;
      media?: { name?: unknown; type?: unknown; size?: unknown } | null;
    };
    const timeline = parseTimeline(head.timeline);
    if (!timeline) return null;
    const m = head.media;
    const start = at + 4 + len;
    if (!m || typeof m.size !== 'number' || m.size <= 0 || start + m.size > bytes.length) return { timeline, media: null };
    return {
      timeline,
      media: { name: typeof m.name === 'string' ? m.name : 'audio', type: typeof m.type === 'string' ? m.type : '', bytes: bytes.slice(start, start + m.size) },
    };
  } catch {
    return null;
  }
}

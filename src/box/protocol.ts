// miseru（ブラウザ）と箱（自作 ODE）のあいだの取り決め（WebSocket の仕様 v1.1）。
// ロックの規則は core.ts、受け入れ試験は check.ts（npm run box:check）。

export const FRAME_TYPE_DMX = 0x01;
export const DMX_SLOTS = 512;
/** ロック中の送り手から何も届かなくなってから、ロックを外すまでの時間 */
export const LOCK_TIMEOUT_MS = 5000;
/** 偽の箱の同時接続の上限の既定値。本物の箱の上限はメモリで決まり、status と GET /api/dmx の max_clients で知らせる。 */
export const MAX_CONNECTIONS = 8;
/** 箱の名前の初期値（本物の箱は /setup の「名前」、ArtPollReply の短い名前と同じ） */
export const DEFAULT_BOX_NAME = 'ODE-DIY';

/** ブラウザ → 箱（JSON） */
export type ClientMessage =
  | { t: 'hello'; id: string; app: string; v: number }
  | { t: 'claim' }
  | { t: 'release' }
  | { t: 'pin'; pin: string }
  | { t: 'force_release' }
  | { t: 'show_mode'; on: boolean }
  | { t: 'ping' };

export type Holder = { kind: 'ws'; you: boolean } | { kind: 'artnet'; ip: string } | { kind: 'sacn'; ip: string } | null;

/**
 * claim を断る理由。
 * - no_hello: hello の前に claim した
 * - busy: ほかの送り手がロックを持っている
 * - not_allowed: 箱の許可リストにこの機器の IP が無い（仕様 v1 追記、ファーム v0.2.0）
 */
export type DenyReason = 'no_hello' | 'busy' | 'not_allowed';

/** 箱 → ブラウザ（JSON） */
export type ServerMessage =
  | {
      t: 'status';
      holder: Holder;
      show_mode: boolean;
      teacher: boolean;
      max_clients: number;
      /** 箱の名前（仕様 v1 追記）。古い箱には無いことがある */
      name?: string;
    }
  | { t: 'denied'; reason: DenyReason | (string & {}) }
  | { t: 'pin'; ok: boolean };

/** 512 スロットの DMX フレームをバイナリにする。先頭 0x01、ポート番号、スロット 1〜512。 */
export function encodeFrame(slots: Uint8Array, port = 0): Uint8Array {
  const out = new Uint8Array(2 + DMX_SLOTS);
  out[0] = FRAME_TYPE_DMX;
  out[1] = port;
  out.set(slots.subarray(0, DMX_SLOTS), 2);
  return out;
}

/** バイナリのフレームを読む。種類がちがうものは null。512 未満で切れていたら残りは 0。 */
export function decodeFrame(buf: Uint8Array): { port: number; slots: Uint8Array } | null {
  if (buf.length < 2 || buf[0] !== FRAME_TYPE_DMX) return null;
  const slots = new Uint8Array(DMX_SLOTS);
  slots.set(buf.subarray(2, 2 + DMX_SLOTS));
  return { port: buf[1], slots };
}

const clientTypes = new Set(['hello', 'claim', 'release', 'pin', 'force_release', 'show_mode', 'ping']);

/** 外から届く JSON を ClientMessage として読む。壊れていれば null。 */
export function parseClientMessage(text: string): ClientMessage | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null) return null;
  const m = v as Record<string, unknown>;
  if (typeof m.t !== 'string' || !clientTypes.has(m.t)) return null;
  if (m.t === 'hello' && (typeof m.id !== 'string' || m.id.length === 0 || m.id.length > 64)) return null;
  if (m.t === 'pin' && typeof m.pin !== 'string') return null;
  if (m.t === 'show_mode' && typeof m.on !== 'boolean') return null;
  return m as ClientMessage;
}

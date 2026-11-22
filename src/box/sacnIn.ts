// sACN（E1.31）のデータパケットを読む。偽の箱が sACN を受けるときに使う（本物の箱はファーム v0.2.0 から受ける）。
// 送る側（miseru から sACN で出す）は別の話で、ここは受けるだけ。

export const SACN_PORT = 5568;

/** ACN パケットの識別子 "ASC-E1.17\0\0\0" */
const ACN_PID = [0x41, 0x53, 0x43, 0x2d, 0x45, 0x31, 0x2e, 0x31, 0x37, 0x00, 0x00, 0x00];
const VECTOR_ROOT_E131_DATA = 0x00000004;
const VECTOR_E131_DATA_PACKET = 0x00000002;
const VECTOR_DMP_SET_PROPERTY = 0x02;
/** フレーミング層の options の Stream_Terminated */
const OPT_STREAM_TERMINATED = 0x40;
/** フレーミング層の options の Preview_Data（見るだけのデータなので出さない） */
const OPT_PREVIEW = 0x80;

export interface SacnPacket {
  universe: number;
  priority: number;
  /** 送り手が流すのをやめた（このパケットの値は使わない） */
  terminated: boolean;
  /** スロット 1〜（最大 512）。スタートコード 0 以外のときは null */
  data: Uint8Array | null;
}

/** E1.31 のデータパケットを読む。形がちがえば null。 */
export function parseSacn(buf: Uint8Array): SacnPacket | null {
  if (buf.length < 126) return null;
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (v.getUint16(0) !== 0x0010) return null;
  for (let i = 0; i < ACN_PID.length; i++) if (buf[4 + i] !== ACN_PID[i]) return null;
  if (v.getUint32(18) !== VECTOR_ROOT_E131_DATA) return null;
  if (v.getUint32(40) !== VECTOR_E131_DATA_PACKET) return null;
  if (buf[117] !== VECTOR_DMP_SET_PROPERTY) return null;
  const options = buf[112];
  const universe = v.getUint16(113);
  const priority = buf[108];
  const terminated = (options & OPT_STREAM_TERMINATED) !== 0;
  const count = v.getUint16(123); // スタートコード + スロット数
  const slots = Math.max(0, Math.min(count - 1, 512, buf.length - 126));
  const startCode = buf[125];
  const usable = startCode === 0 && (options & OPT_PREVIEW) === 0;
  return { universe, priority, terminated, data: usable ? buf.slice(126, 126 + slots) : null };
}

/** 試験用: E1.31 のデータパケットを作る（必要な欄だけ埋める） */
export function buildSacnForTest(universe: number, slots: Uint8Array, opts: { terminated?: boolean } = {}): Uint8Array {
  const n = Math.min(slots.length, 512);
  const buf = new Uint8Array(126 + n);
  const v = new DataView(buf.buffer);
  v.setUint16(0, 0x0010);
  buf.set(ACN_PID, 4);
  v.setUint16(16, 0x7000 | (buf.length - 16));
  v.setUint32(18, VECTOR_ROOT_E131_DATA);
  v.setUint16(38, 0x7000 | (buf.length - 38));
  v.setUint32(40, VECTOR_E131_DATA_PACKET);
  buf[108] = 100;
  buf[112] = opts.terminated ? OPT_STREAM_TERMINATED : 0;
  v.setUint16(113, universe);
  v.setUint16(115, 0x7000 | (buf.length - 115));
  buf[117] = VECTOR_DMP_SET_PROPERTY;
  buf[118] = 0xa1;
  v.setUint16(121, 1);
  v.setUint16(123, n + 1);
  buf[125] = 0;
  buf.set(slots.subarray(0, n), 126);
  return buf;
}

// sACN（E1.31）のデータパケットを作って UDP で送る。

import dgram from 'node:dgram';
import { randomBytes } from 'node:crypto';

export const SACN_PORT = 5568;
const PACKET_LENGTH = 638;

/** ユニバースごとのマルチキャスト宛先（239.255.<上位>.<下位>） */
export function sacnMulticastAddress(universe: number): string {
  return `239.255.${(universe >> 8) & 0xff}.${universe & 0xff}`;
}

/** E1.31 データパケット（512 スロット固定）を作る。universe は 1〜63999、priority は 0〜200。 */
export function buildSacn(opts: {
  cid: Uint8Array;
  sourceName: string;
  universe: number;
  priority: number;
  sequence: number;
  data: Uint8Array;
}): Buffer {
  if (!Number.isInteger(opts.universe) || opts.universe < 1 || opts.universe > 63999) throw new RangeError('universe must be 1–63999');
  if (opts.cid.length !== 16) throw new RangeError('CID must be 16 bytes');
  const b = Buffer.alloc(PACKET_LENGTH);
  // ルート層
  b.writeUInt16BE(0x0010, 0);
  b.writeUInt16BE(0x0000, 2);
  b.write('ASC-E1.17\0\0\0', 4, 'ascii');
  b.writeUInt16BE(0x7000 | (PACKET_LENGTH - 16), 16);
  b.writeUInt32BE(0x00000004, 18);
  b.set(opts.cid, 22);
  // フレーミング層
  b.writeUInt16BE(0x7000 | (PACKET_LENGTH - 38), 38);
  b.writeUInt32BE(0x00000002, 40);
  b.write(opts.sourceName.slice(0, 63), 44, 'utf8');
  b.writeUInt8(Math.min(200, Math.max(0, Math.round(opts.priority))), 108);
  b.writeUInt16BE(0, 109); // 同期アドレス（使わない）
  b.writeUInt8(opts.sequence & 0xff, 111);
  b.writeUInt8(0, 112);
  b.writeUInt16BE(opts.universe, 113);
  // DMP 層
  b.writeUInt16BE(0x7000 | (PACKET_LENGTH - 115), 115);
  b.writeUInt8(0x02, 117);
  b.writeUInt8(0xa1, 118);
  b.writeUInt16BE(0x0000, 119);
  b.writeUInt16BE(0x0001, 121);
  b.writeUInt16BE(513, 123);
  b.writeUInt8(0, 125); // スタートコード
  b.set(opts.data.subarray(0, 512), 126);
  return b;
}

export interface SacnSenderOptions {
  /** 1 始まりのユニバース番号 */
  universe: number;
  priority?: number;
  /** 空ならマルチキャスト、入れればその IP へ直接送る */
  host?: string;
  /** 送信に使うこちら側の IP（複数の口があるとき） */
  bindAddress?: string;
}

export class SacnSender {
  private socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  private sequence = 0;
  private cid = randomBytes(16);

  private lastError = '';

  constructor(private opts: SacnSenderOptions) {
    this.listen(opts.bindAddress);
  }

  private listen(address: string | undefined): void {
    // 送れないときもアプリを落とさず、知らせだけ出して続ける
    this.socket.on('error', (err: NodeJS.ErrnoException) => {
      if (err.syscall === 'bind' && address) {
        console.error(`sACN: ${address} がこの PC にありません。IP を指定せずに送ります`);
        this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
        this.listen(undefined);
        return;
      }
      this.report(err);
    });
    this.socket.bind({ port: 0, address }, () => {
      if (!this.opts.host) this.socket.setMulticastTTL(8);
    });
  }

  private report(err: Error): void {
    if (err.message === this.lastError) return;
    this.lastError = err.message;
    console.error(`sACN: 送れません（${err.message}）`);
  }

  send(data: Uint8Array): void {
    const packet = buildSacn({
      cid: this.cid,
      sourceName: 'miseru',
      universe: this.opts.universe,
      priority: this.opts.priority ?? 100,
      sequence: this.sequence,
      data,
    });
    this.sequence = (this.sequence + 1) & 0xff;
    this.socket.send(packet, SACN_PORT, this.opts.host || sacnMulticastAddress(this.opts.universe), (err) => {
      if (err) this.report(err);
      else this.lastError = '';
    });
  }

  close(): void {
    this.socket.close();
  }
}

// Art-Net 4 の ArtDmx パケットを作って UDP で送る。

import dgram from 'node:dgram';

export const ARTNET_PORT = 6454;
const OP_DMX = 0x5000;
const PROTOCOL_VERSION = 14;

/** ArtDmx パケットを作る。universe は 15bit のポートアドレス（Net/SubNet/Universe）。 */
export function buildArtDmx(universe: number, data: Uint8Array, sequence = 0): Buffer {
  if (universe < 0 || universe > 0x7fff) throw new RangeError('universe must be 0–32767');
  let length = Math.min(512, Math.max(2, data.length));
  if (length % 2) length += 1; // 長さは偶数でなければならない
  const buf = Buffer.alloc(18 + length);
  buf.write('Art-Net\0', 0, 'ascii');
  buf.writeUInt16LE(OP_DMX, 8);
  buf.writeUInt16BE(PROTOCOL_VERSION, 10);
  buf.writeUInt8(sequence & 0xff, 12);
  buf.writeUInt8(0, 13); // Physical
  buf.writeUInt8(universe & 0xff, 14); // SubUni
  buf.writeUInt8((universe >> 8) & 0x7f, 15); // Net
  buf.writeUInt16BE(length, 16);
  buf.set(data.subarray(0, Math.min(length, data.length)), 18);
  return buf;
}

export interface ArtNetSenderOptions {
  host: string;
  universe: number;
  port?: number;
  broadcast?: boolean;
  bindAddress?: string;
}

export class ArtNetSender {
  private socket = dgram.createSocket('udp4');
  private sequence = 1;
  private lastError = '';

  constructor(private opts: ArtNetSenderOptions) {
    // 送れないとき（ODE の口が無い、指定の IP がこの PC に無いなど）もアプリを落とさず、知らせだけ出して続ける
    this.socket.on('error', (err: NodeJS.ErrnoException) => {
      if (err.syscall === 'bind') {
        console.error(`Art-Net: ${opts.bindAddress} がこの PC にありません。有線 LAN の IP を確かめてください。いまは IP を指定せずに送ります`);
        this.socket = dgram.createSocket('udp4');
        this.socket.on('error', (e) => this.report(e));
        if (opts.broadcast) this.socket.bind(0, () => this.socket.setBroadcast(true));
        return;
      }
      this.report(err);
    });
    if (opts.broadcast || opts.bindAddress) {
      this.socket.bind({ port: 0, address: opts.bindAddress }, () => {
        if (opts.broadcast) this.socket.setBroadcast(true);
      });
    }
  }

  private report(err: Error): void {
    if (err.message === this.lastError) return;
    this.lastError = err.message;
    console.error(`Art-Net: ${this.opts.host} に送れません（${err.message}）`);
  }

  send(data: Uint8Array): void {
    const packet = buildArtDmx(this.opts.universe, data, this.sequence);
    // 0 は「順番を使わない」の意味なので 1〜255 を回す
    this.sequence = this.sequence >= 255 ? 1 : this.sequence + 1;
    this.socket.send(packet, this.opts.port ?? ARTNET_PORT, this.opts.host, (err) => {
      if (err) this.report(err);
      else this.lastError = '';
    });
  }

  close(): void {
    this.socket.close();
  }
}

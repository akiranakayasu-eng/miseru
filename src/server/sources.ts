// ODE に流す光の「出どころ」を 1 つだけ選ぶ切り替え役。
// 自分の画面（app）のほか、Wi-Fi 側から届く Art-Net（Luminair、Max、TouchDesigner など）を受け取って並べる。

import dgram from 'node:dgram';
import { ARTNET_PORT } from './artnet.js';

export interface ExternalSource {
  id: string;
  label: string;
  lastSeen: number;
  data: Uint8Array;
}

/** ArtDmx パケットを読む。違うものなら null。 */
export function parseArtDmx(msg: Buffer): { universe: number; data: Uint8Array } | null {
  if (msg.length < 20 || msg.subarray(0, 8).toString('ascii') !== 'Art-Net\0') return null;
  if (msg.readUInt16LE(8) !== 0x5000) return null;
  const universe = msg[14] | ((msg[15] & 0x7f) << 8);
  const length = Math.min(msg.readUInt16BE(16), msg.length - 18, 512);
  const data = new Uint8Array(512);
  data.set(msg.subarray(18, 18 + length));
  return { universe, data };
}

export const SOURCE_TIMEOUT_MS = 5000;

export class ArtNetInputs {
  private sources = new Map<string, ExternalSource>();
  private socket?: dgram.Socket;

  constructor(
    private universe: number,
    private onChange: () => void,
  ) {}

  listen(bindAddress = '0.0.0.0', port = ARTNET_PORT): void {
    this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.socket.on('message', (msg, rinfo) => this.receive(msg, rinfo.address));
    this.socket.on('error', (err) => console.error('Art-Net input:', err.message));
    this.socket.bind(port, bindAddress);
  }

  receive(msg: Buffer, from: string, now = Date.now()): void {
    const pkt = parseArtDmx(msg);
    if (!pkt || pkt.universe !== this.universe) return;
    const id = `artnet:${from}`;
    const isNew = !this.sources.has(id);
    this.sources.set(id, { id, label: `Art-Net ${from}`, lastSeen: now, data: pkt.data });
    if (isNew) this.onChange();
  }

  get(id: string): ExternalSource | undefined {
    return this.sources.get(id);
  }

  list(now = Date.now()) {
    return [...this.sources.values()].map((s) => ({ id: s.id, label: s.label, alive: now - s.lastSeen < SOURCE_TIMEOUT_MS }));
  }

  close(): void {
    this.socket?.close();
  }
}

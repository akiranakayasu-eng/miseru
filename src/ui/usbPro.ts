// ENTTEC DMX USB Pro を Web Serial（Chrome / Edge）で直接動かす。
// USB Pro は受け取ったデータを自分で DMX に出し続けるので、変化のあったときだけ送ればよい。

/** 「DMX を送る」パケット（ラベル 6）。データの先頭にスタートコード 0 を付ける。 */
export function buildUsbProPacket(data: Uint8Array): Uint8Array {
  const length = Math.min(512, data.length) + 1;
  const out = new Uint8Array(length + 5);
  out[0] = 0x7e;
  out[1] = 6;
  out[2] = length & 0xff;
  out[3] = (length >> 8) & 0xff;
  out[4] = 0; // スタートコード
  out.set(data.subarray(0, length - 1), 5);
  out[out.length - 1] = 0xe7;
  return out;
}

// Web Serial の型は TypeScript に標準で入っていないので、使う分だけ書く
interface SerialPortLike {
  open(o: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  writable: WritableStream<Uint8Array> | null;
}
interface SerialLike {
  requestPort(): Promise<SerialPortLike>;
}

export const usbProSupported = (): boolean => typeof navigator !== 'undefined' && 'serial' in navigator;

export class UsbProLink {
  private port: SerialPortLike | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private pending: Uint8Array | null = null;
  private busy = false;

  /** ポートの選択画面を開いてつなぐ（ボタンを押した直後に呼ぶ必要がある） */
  async connect(): Promise<void> {
    const serial = (navigator as unknown as { serial: SerialLike }).serial;
    const port = await serial.requestPort();
    await port.open({ baudRate: 250000 });
    if (!port.writable) throw new Error('Port is not writable');
    this.port = port;
    this.writer = port.writable.getWriter();
  }

  get connected(): boolean {
    return this.writer !== null;
  }

  /** 最新の 512ch を送る。書き込み中に来た分は最新の 1 つだけ残す。 */
  send(data: Uint8Array): void {
    this.pending = data;
    void this.flush();
  }

  private async flush(): Promise<void> {
    if (this.busy || !this.writer) return;
    this.busy = true;
    try {
      while (this.pending && this.writer) {
        const next = this.pending;
        this.pending = null;
        await this.writer.write(buildUsbProPacket(next));
      }
    } catch {
      await this.close(); // 抜けたときなど
    } finally {
      this.busy = false;
    }
  }

  async close(): Promise<void> {
    const { writer, port } = this;
    this.writer = null;
    this.port = null;
    this.pending = null;
    try {
      writer?.releaseLock();
      await port?.close();
    } catch {
      // すでに閉じている
    }
  }
}

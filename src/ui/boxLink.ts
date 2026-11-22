// 箱への出口。仕様 v0 のとおり、hello → claim のあと、512 バイトの DMX フレームを送る。
// 照明の計算（色、明るさ、タイムライン）はブラウザ側で済ませてあり、ここは送るだけ。

import { encodeFrame, DMX_SLOTS, type ClientMessage, type ServerMessage } from '../box/protocol.js';

export type BoxStatus = Extract<ServerMessage, { t: 'status' }>;
export type LinkState = 'connecting' | 'open' | 'closed';

export interface BoxLinkOptions {
  url: string;
  /** タブごとのランダムな id。再接続で同じ id なら同じ送り手として扱われる */
  id: string;
  onState: (s: LinkState) => void;
  onStatus: (s: BoxStatus) => void;
  /** claim が通らなかった */
  onDenied: (reason: string) => void;
  /** ロックを持っていたのに外された（時間切れ、先生、ボタン） */
  onLost: () => void;
  onPin: (ok: boolean) => void;
  /** 変化中のフレームの間隔（ミリ秒）。既定は約 30fps */
  frameIntervalMs?: number;
  /** 変化がなくても送り直す間隔（ミリ秒）。仕様の最低は 1 秒に 1 回 */
  heartbeatMs?: number;
  reconnectMs?: number;
  WebSocketImpl?: typeof WebSocket;
}

export class BoxLink {
  private ws: WebSocket | null = null;
  private frame: Uint8Array = new Uint8Array(DMX_SLOTS);
  private dirty = false;
  private lastSent = 0;
  private wantLock = true;
  private hadLock = false;
  private holdingNow = false;
  private stopped = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;

  constructor(private o: BoxLinkOptions) {}

  connect(): void {
    this.stopped = false;
    const WS = this.o.WebSocketImpl ?? WebSocket;
    this.o.onState('connecting');
    const ws = new WS(this.o.url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      this.o.onState('open');
      this.sendJson({ t: 'hello', id: this.o.id, app: 'miseru', v: 0 });
      if (this.wantLock) this.sendJson({ t: 'claim' });
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return;
      let m: ServerMessage;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      this.handle(m);
    };
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      this.holdingNow = false;
      this.o.onState('closed');
      if (!this.stopped) this.retry = setTimeout(() => this.connect(), this.o.reconnectMs ?? 1500);
    };
    if (!this.timer) this.timer = setInterval(() => this.pump(), this.o.frameIntervalMs ?? 33);
  }

  close(): void {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.ws?.close();
  }

  /** 最新の DMX フレームを渡す。変化があれば次の間隔で送られる。 */
  setFrame(slots: Uint8Array): void {
    this.frame = slots;
    this.dirty = true;
  }

  claim(): void {
    this.wantLock = true;
    this.sendJson({ t: 'claim' });
  }

  /** 「おしまい」: 待たずに全消灯してロックを外す */
  release(): void {
    this.wantLock = false;
    this.sendJson({ t: 'release' });
  }

  pin(pin: string): void {
    this.sendJson({ t: 'pin', pin });
  }

  forceRelease(): void {
    this.sendJson({ t: 'force_release' });
  }

  setShowMode(on: boolean): void {
    this.sendJson({ t: 'show_mode', on });
  }

  private handle(m: ServerMessage): void {
    if (m.t === 'status') {
      const mine = m.holder?.kind === 'ws' && m.holder.you;
      if (mine) this.hadLock = true;
      else if (this.hadLock) {
        // 持っていたロックが外れた。勝手に取り直さない。
        this.hadLock = false;
        this.wantLock = false;
        this.o.onLost();
      }
      if (mine && !this.holdingNow) this.dirty = true; // 取れたらすぐ最新の値を送る
      this.holdingNow = mine;
      this.o.onStatus(m);
    } else if (m.t === 'denied') {
      this.wantLock = false;
      this.o.onDenied(m.reason);
    } else if (m.t === 'pin') {
      this.o.onPin(m.ok);
    }
  }

  private pump(): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== ws.OPEN || !this.holdingNow) return;
    const now = Date.now();
    const heartbeatMs = this.o.heartbeatMs ?? 1000;
    if (this.dirty || now - this.lastSent >= heartbeatMs) {
      ws.send(encodeFrame(this.frame, 0));
      this.dirty = false;
      this.lastSent = now;
    }
  }

  private sendJson(m: ClientMessage): void {
    const ws = this.ws;
    if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(m));
  }
}

/** タブごとの id。sessionStorage に保存して、再読み込みや再接続でも同じにする。 */
export function tabId(): string {
  const key = 'miseru.boxid';
  try {
    const saved = sessionStorage.getItem(key);
    if (saved) return saved;
  } catch {
    // 保存できなくても動く（そのときは再接続で別の送り手になる）
  }
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const id = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  try {
    sessionStorage.setItem(key, id);
  } catch {
    // 同上
  }
  return id;
}

// 箱の本体（ロックの規則）。仕様 v0 の「ロックの規則」1〜6 をそのまま書いたもの。
// ネットワークにも時計にも依存しないので、ファームを書く側の受け入れ試験にも使える。

import {
  DEFAULT_BOX_NAME,
  DMX_SLOTS,
  LOCK_TIMEOUT_MS,
  MAX_CONNECTIONS,
  decodeFrame,
  type ClientMessage,
  type Holder,
  type ServerMessage,
} from './protocol.js';

/** ネットワークから届く照明信号の種類（Art-Net と sACN は同じ扱い） */
export type NetKind = 'artnet' | 'sacn';

type Owner = { kind: 'ws'; id: string } | { kind: NetKind; ip: string };

interface Conn {
  id?: string;
  /** 接続してきた機器の IP（許可リストの照合に使う）。分からなければ undefined */
  ip?: string;
  teacher: boolean;
}

export interface BoxCoreOptions {
  /** 先生の PIN。空なら先生の操作は使えない */
  pin: string;
  timeoutMs?: number;
  maxConnections?: number;
  /** 箱の名前。status で知らせる（既定 ODE-DIY） */
  name?: string;
  /**
   * 許可リスト（IP、本物の箱は 8 個まで）。空か未指定なら誰でも使える。
   * 入れると、リストに無い機器の claim は not_allowed で断り、Art-Net・sACN も無視する。
   * 画面を開いて状態を見ることはできる。
   */
  allow?: string[];
}

export class BoxCore {
  /** いま DMX に出している 512 スロット */
  output: Uint8Array = new Uint8Array(DMX_SLOTS);
  showMode = false;
  /** ロックまたは公演モードが変わるたびに増える（状態を配り直す合図） */
  version = 0;

  private owner: Owner | null = null;
  private lastSeen = 0;
  private conns = new Map<number, Conn>();
  private timeoutMs: number;
  private maxConnections: number;
  private allow: Set<string>;
  /** 箱の名前 */
  readonly name: string;

  constructor(private opts: BoxCoreOptions) {
    this.timeoutMs = opts.timeoutMs ?? LOCK_TIMEOUT_MS;
    this.maxConnections = opts.maxConnections ?? MAX_CONNECTIONS;
    this.name = opts.name ?? DEFAULT_BOX_NAME;
    this.allow = new Set((opts.allow ?? []).map(normalizeIp).filter((ip) => ip !== ''));
  }

  /** 接続を受け付ける。同時接続の上限を超えたら false（接続を断る）。ip は許可リストの照合に使う。 */
  open(conn: number, ip?: string): boolean {
    if (this.conns.size >= this.maxConnections) return false;
    this.conns.set(conn, { teacher: false, ip: ip === undefined ? undefined : normalizeIp(ip) });
    return true;
  }

  /** この IP の機器が照明を動かしてよいか（許可リストが空なら誰でもよい） */
  allowed(ip: string | undefined): boolean {
    if (this.allow.size === 0) return true;
    return ip !== undefined && this.allow.has(normalizeIp(ip));
  }

  close(conn: number): void {
    // ロックは外さない。同じ id で再接続すれば続けられ、戻らなければ時間切れで外れる。
    this.conns.delete(conn);
  }

  /** ロックを持つ送り手の値を出す。持たない接続のフレームは黙って捨てる。 */
  binary(conn: number, data: Uint8Array, now: number): void {
    const c = this.conns.get(conn);
    if (!c || !this.isMyLock(c)) return;
    const frame = decodeFrame(data);
    if (!frame) return;
    this.output = frame.slots;
    this.lastSeen = now;
  }

  /** JSON のメッセージを処理して、その接続への返事を返す。 */
  message(conn: number, msg: ClientMessage, now: number): ServerMessage[] {
    const c = this.conns.get(conn);
    if (!c) return [];
    switch (msg.t) {
      case 'hello':
        c.id = msg.id;
        // 同じ id の再接続は同じ送り手として続ける
        if (this.isMyLock(c)) this.lastSeen = now;
        return [this.status(conn)];
      case 'claim':
        if (!c.id) return [{ t: 'denied', reason: 'no_hello' }];
        if (!this.allowed(c.ip)) return [{ t: 'denied', reason: 'not_allowed' }];
        if (this.isMyLock(c)) {
          this.lastSeen = now;
          return [];
        }
        if (this.owner) return [{ t: 'denied', reason: 'busy' }];
        this.take({ kind: 'ws', id: c.id }, now);
        return [];
      case 'ping':
        if (this.isMyLock(c)) this.lastSeen = now;
        return [];
      case 'release':
        if (this.isMyLock(c)) this.releaseLock();
        return [];
      case 'pin': {
        const ok = this.opts.pin !== '' && msg.pin === this.opts.pin;
        c.teacher = ok;
        return [{ t: 'pin', ok }, this.status(conn)];
      }
      case 'force_release':
        if (c.teacher) this.releaseLock();
        return [];
      case 'show_mode':
        if (c.teacher && this.showMode !== msg.on) {
          this.showMode = msg.on;
          this.version++;
        }
        return [];
    }
  }

  /** Art-Net の ArtDmx。空いていれば最初に届いた IP がロックを取る。 */
  artnet(ip: string, slots: Uint8Array, now: number): void {
    this.net('artnet', ip, slots, now);
  }

  /** sACN（E1.31）のデータ。Art-Net と同じ扱いで、空いていれば最初に届いた IP がロックを取る。 */
  sacn(ip: string, slots: Uint8Array, now: number): void {
    this.net('sacn', ip, slots, now);
  }

  /** sACN の Stream_Terminated。その送り手がロックを持っていれば、待たずに全消灯して外す。 */
  sacnTerminated(ip: string): void {
    if (this.owner?.kind === 'sacn' && this.owner.ip === normalizeIp(ip)) this.releaseLock();
  }

  private net(kind: NetKind, rawIp: string, slots: Uint8Array, now: number): void {
    const ip = normalizeIp(rawIp);
    if (!this.allowed(ip)) return;
    if (!this.owner) this.take({ kind, ip }, now);
    if (this.owner?.kind !== kind || this.owner.ip !== ip) return;
    this.output = slots.length === DMX_SLOTS ? slots : padSlots(slots);
    this.lastSeen = now;
  }

  /** 時間を進める。公演モード以外で、ロック中の送り手が止まったら全消灯して外す。 */
  tick(now: number): void {
    if (this.owner && !this.showMode && now - this.lastSeen >= this.timeoutMs) this.releaseLock();
  }

  /** 箱の押しボタン: 待たずに全消灯してロックを外す（公演モード中でも外れる）。 */
  button(): void {
    this.releaseLock();
  }

  status(conn: number): ServerMessage {
    const c = this.conns.get(conn);
    let holder: Holder = null;
    if (this.owner?.kind === 'ws') holder = { kind: 'ws', you: !!c && this.isMyLock(c) };
    else if (this.owner) holder = { kind: this.owner.kind, ip: this.owner.ip };
    return {
      t: 'status',
      holder,
      show_mode: this.showMode,
      teacher: c?.teacher ?? false,
      max_clients: this.maxConnections,
      name: this.name,
    };
  }

  /** 同時接続の上限 */
  get maxClients(): number {
    return this.maxConnections;
  }

  get connections(): number {
    return this.conns.size;
  }

  get holder(): Owner | null {
    return this.owner;
  }

  private isMyLock(c: Conn): boolean {
    return !!c.id && this.owner?.kind === 'ws' && this.owner.id === c.id;
  }

  private take(owner: Owner, now: number): void {
    this.owner = owner;
    this.lastSeen = now;
    this.version++;
  }

  private releaseLock(): void {
    this.output = new Uint8Array(DMX_SLOTS);
    if (this.owner) {
      this.owner = null;
      this.version++;
    }
  }
}

/** IPv4 を IPv6 の形（::ffff:192.0.2.10）で受けたときも、同じ IP として扱う */
export function normalizeIp(ip: string): string {
  const s = ip.trim();
  return s.startsWith('::ffff:') ? s.slice(7) : s;
}

function padSlots(slots: Uint8Array): Uint8Array {
  const out = new Uint8Array(DMX_SLOTS);
  out.set(slots.subarray(0, DMX_SLOTS));
  return out;
}

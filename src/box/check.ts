// 箱（自作 ODE）の受け入れ試験。仕様 v1（とその追記）のとおりに動くかを、ネットワークの外側から確かめる。
// 本物の箱にも偽の箱（sim.ts）にも同じ手順で使える。
//
//   npm run box:check -- --host 192.0.2.223 --pin 0000
//
// 出している DMX の値は箱の GET /api/dmx で読む（箱にもこの読み取り専用の口を付けてもらう）。
// 時間切れの確かめに、ロックの時間切れ（既定 5 秒）の 2 回分ほど待つので、全体で 30 秒ほどかかる。

import dgram from 'node:dgram';
import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import { ARTNET_PORT, buildArtDmx } from '../server/artnet.js';
import { encodeFrame, LOCK_TIMEOUT_MS, type ServerMessage } from './protocol.js';
import { buildSacnForTest, SACN_PORT } from './sacnIn.js';

export interface CheckOptions {
  host: string;
  /** HTTP と WebSocket のポート */
  port?: number;
  pin: string;
  /** 箱のロックの時間切れ */
  timeoutMs?: number;
  artnetPort?: number;
  /** 箱が sACN を受けるポート（既定 5568）。ユニキャストで送る */
  sacnPort?: number;
  /** 箱が sACN で受けるユニバース（既定 1） */
  sacnUniverse?: number;
  log?: (line: string) => void;
}

export interface CheckResult {
  name: string;
  ok: boolean;
  detail?: string;
}

interface DmxState {
  name?: string;
  holder: { kind: string; ip?: string } | null;
  show_mode: boolean;
  max_clients: number;
  output: number[];
}

const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const randomId = () => Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);

class Client {
  readonly inbox: ServerMessage[] = [];
  closeCode = 0;
  private constructor(readonly ws: WebSocket) {
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      try {
        this.inbox.push(JSON.parse(String(data)) as ServerMessage);
      } catch {
        // 壊れた JSON は試験の対象外
      }
    });
    ws.on('close', (code) => (this.closeCode = code));
  }

  static async open(url: string): Promise<Client> {
    const ws = new WebSocket(url);
    const c = new Client(ws);
    await new Promise<void>((ok, ng) => {
      ws.once('open', () => ok());
      ws.once('error', ng);
    });
    return c;
  }

  static async join(url: string, id = randomId()): Promise<Client> {
    const c = await Client.open(url);
    c.json({ t: 'hello', id, app: 'miseru-check', v: 0 });
    return c;
  }

  json(m: object) {
    this.ws.send(JSON.stringify(m));
  }

  frame(value: number) {
    this.ws.send(encodeFrame(new Uint8Array(512).fill(value)));
  }

  /** 条件に合うメッセージが届くまで待つ。前に届いた分は捨てる。 */
  async waitFor(pred: (m: ServerMessage) => boolean, ms = 2000): Promise<ServerMessage | null> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const i = this.inbox.findIndex(pred);
      if (i >= 0) return this.inbox.splice(0, i + 1).at(-1) ?? null;
      await sleep(20);
    }
    return null;
  }

  async closed(ms = 2000): Promise<number> {
    const end = Date.now() + ms;
    while (Date.now() < end && !this.closeCode) await sleep(20);
    return this.closeCode;
  }

  close() {
    this.ws.close();
  }
}

/** ロック中の送り手のふりをして、フレームを送り続ける */
function keepSending(c: Client, value: number, everyMs = 200) {
  c.frame(value);
  const timer = setInterval(() => c.ws.readyState === WebSocket.OPEN && c.frame(value), everyMs);
  return () => clearInterval(timer);
}

/** sACN の送り手のふりをして、値を送り続ける */
function keepSendingSacn(send: (value: number) => Promise<void>, value: number, everyMs = 200) {
  void send(value);
  const timer = setInterval(() => void send(value), everyMs);
  return () => clearInterval(timer);
}

export async function runChecks(o: CheckOptions): Promise<CheckResult[]> {
  const port = o.port ?? 80;
  const timeoutMs = o.timeoutMs ?? LOCK_TIMEOUT_MS;
  const base = `http://${o.host}:${port}`;
  const wsUrl = `ws://${o.host}:${port}/ws`;
  const log = o.log ?? (() => {});
  const results: CheckResult[] = [];
  const opened: Client[] = [];
  let first: Client | undefined;
  const stops: (() => void)[] = [];
  const udp = dgram.createSocket('udp4');

  const check = async (name: string, body: () => Promise<string | true>) => {
    let r: CheckResult;
    try {
      const v = await body();
      r = v === true ? { name, ok: true } : { name, ok: false, detail: v };
    } catch (e) {
      r = { name, ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
    results.push(r);
    log(`${r.ok ? '✓' : '✗'} ${name}${r.detail ? `（${r.detail}）` : ''}`);
  };
  const dmx = async (): Promise<DmxState> => (await fetch(`${base}/api/dmx`)).json() as Promise<DmxState>;
  const allAre = (s: DmxState, v: number) => s.output.length === 512 && s.output.every((x) => x === v);
  const join = async (id?: string) => {
    const c = await Client.join(wsUrl, id);
    opened.push(c);
    return c;
  };
  const artnet = (value: number) =>
    new Promise<void>((ok) =>
      udp.send(buildArtDmx(0, new Uint8Array(512).fill(value)), o.artnetPort ?? ARTNET_PORT, o.host, () => ok()),
    );
  const sacn = (value: number, terminated = false) =>
    new Promise<void>((ok) =>
      udp.send(
        buildSacnForTest(o.sacnUniverse ?? 1, new Uint8Array(512).fill(value), { terminated }),
        o.sacnPort ?? SACN_PORT,
        o.host,
        () => ok(),
      ),
    );
  /** 箱をロック無し・全消灯に戻す */
  const reset = async () => {
    for (const s of stops.splice(0)) s();
    const t = await join();
    t.json({ t: 'pin', pin: o.pin });
    await t.waitFor((m) => m.t === 'pin');
    t.json({ t: 'show_mode', on: false });
    t.json({ t: 'force_release' });
    await sleep(150);
    t.close();
  };

  try {
    await check('HTTP: / で画面（HTML）を返す', async () => {
      const r = await fetch(`${base}/`);
      const type = r.headers.get('content-type') ?? '';
      return r.ok && type.startsWith('text/html') ? true : `status ${r.status}, ${type}`;
    });

    await check('HTTP: 画面の JS と CSS を正しい Content-Type で返す', async () => {
      const html = await (await fetch(`${base}/`)).text();
      const js = html.match(/src="\.?\/?(assets\/[^"]+\.js)"/)?.[1];
      const css = html.match(/href="\.?\/?(assets\/[^"]+\.css)"/)?.[1];
      if (!js || !css) return 'index.html に assets/*.js と *.css が見つからない';
      const tj = (await fetch(`${base}/${js}`)).headers.get('content-type') ?? '';
      const tc = (await fetch(`${base}/${css}`)).headers.get('content-type') ?? '';
      const okJs = /javascript/.test(tj);
      const okCss = tc.startsWith('text/css');
      return okJs && okCss ? true : `js: ${tj} / css: ${tc}`;
    });

    await check('HTTP: 知らないパスには index.html を返す', async () => {
      const r = await fetch(`${base}/teacher/somewhere`);
      const type = r.headers.get('content-type') ?? '';
      return r.ok && type.startsWith('text/html') ? true : `status ${r.status}, ${type}`;
    });

    await check('状態: 箱の名前（name）を status と GET /api/dmx で知らせる', async () => {
      const s = await dmx();
      if (typeof s.name !== 'string' || s.name === '') return `GET /api/dmx に name が無い（${JSON.stringify(s.name)}）`;
      // 接続の上限（偽の箱は既定 8）を使い切らないよう、確かめたらすぐ閉じる
      const c = await Client.join(wsUrl);
      const st = await c.waitFor((m) => m.t === 'status');
      c.close();
      if (st?.t !== 'status') return 'status が来ない';
      if (st.name !== s.name) return `status の name（${JSON.stringify(st.name)}）が GET /api/dmx（${s.name}）とちがう`;
      return true;
    });

    await reset();

    await check('規則 1: 最初に claim した接続がロックを取り、その値を出す', async () => {
      const a = (first = await join());
      a.json({ t: 'claim' });
      const st = await a.waitFor((m) => m.t === 'status' && m.holder?.kind === 'ws' && m.holder.you);
      if (!st) return 'status で holder.you が true にならない';
      stops.push(keepSending(a, 10));
      await sleep(300);
      const s = await dmx();
      return allAre(s, 10) ? true : `出力が 10 にならない（先頭 ${s.output.slice(0, 4)}）`;
    });

    await check('規則 1: ほかの接続は busy で断られ、そのフレームは捨てられる', async () => {
      const b = await join();
      b.json({ t: 'claim' });
      const d = await b.waitFor((m) => m.t === 'denied');
      if (!d || d.t !== 'denied' || d.reason !== 'busy') return 'denied busy が来ない';
      b.frame(99);
      await sleep(300);
      const s = await dmx();
      return allAre(s, 10) ? true : `ロック外のフレームが出力された（先頭 ${s.output.slice(0, 4)}）`;
    });

    await check('規則 3: release で待たずに全消灯し、ロックを外す', async () => {
      if (!first) return '前の試験でロックを取れていない';
      for (const s of stops.splice(0)) s();
      first.json({ t: 'release' });
      await sleep(300);
      const s = await dmx();
      if (s.holder !== null) return `holder が残っている（${JSON.stringify(s.holder)}）`;
      return allAre(s, 0) ? true : '全消灯にならない';
    });

    await check('規則 2: WebSocket が切れても、同じ id で時間切れ前に戻れば続けられる', async () => {
      const id = randomId();
      const a = await join(id);
      a.json({ t: 'claim' });
      await a.waitFor((m) => m.t === 'status' && m.holder?.kind === 'ws' && m.holder.you);
      a.frame(20);
      a.ws.terminate();
      await sleep(Math.min(1000, timeoutMs / 3));
      const a2 = await join(id);
      a2.frame(21);
      await sleep(300);
      const s = await dmx();
      a2.json({ t: 'release' });
      await sleep(200);
      return allAre(s, 21) ? true : `戻った接続の値が出ない（先頭 ${s.output.slice(0, 4)}）`;
    });

    await check(`規則 2: ロック中の送り手が ${timeoutMs}ms 黙ると、全消灯してロックを外す`, async () => {
      const a = await join();
      a.json({ t: 'claim' });
      await a.waitFor((m) => m.t === 'status' && m.holder?.kind === 'ws' && m.holder.you);
      a.frame(30);
      await sleep(300);
      if (!allAre(await dmx(), 30)) return '最初の値が出ない';
      await sleep(timeoutMs + 800);
      const s = await dmx();
      if (s.holder !== null) return `時間切れでも holder が残っている（${JSON.stringify(s.holder)}）`;
      return allAre(s, 0) ? true : '時間切れのあと全消灯にならない';
    });

    await check('規則 1: 空いていれば Art-Net の送り手がロックを取り、WebSocket は busy', async () => {
      await artnet(40);
      await sleep(300);
      const s = await dmx();
      if (s.holder?.kind !== 'artnet') return `Art-Net がロックを取らない（${JSON.stringify(s.holder)}）`;
      if (!allAre(s, 40)) return 'Art-Net の値が出ない';
      const b = await join();
      b.json({ t: 'claim' });
      const d = await b.waitFor((m) => m.t === 'denied');
      return d ? true : 'Art-Net のロック中に claim が通ってしまう';
    });

    await reset();

    await check('規則 1: sACN の送り手もロックを取り（holder.kind が sacn）、Stream_Terminated で即全消灯', async () => {
      const stop = keepSendingSacn(sacn, 50);
      stops.push(stop);
      await sleep(300);
      const s = await dmx();
      if (s.holder?.kind !== 'sacn') return `sACN がロックを取らない（${JSON.stringify(s.holder)}）`;
      if (!allAre(s, 50)) return 'sACN の値が出ない';
      stop();
      await sacn(0, true);
      await sleep(300);
      const after = await dmx();
      if (after.holder !== null) return `Stream_Terminated でも holder が残っている（${JSON.stringify(after.holder)}）`;
      return allAre(after, 0) ? true : 'Stream_Terminated のあと全消灯にならない';
    });

    await check('規則 3: 先生の PIN の誤りは断り、正しければ force_release で即全消灯', async () => {
      const t = await join();
      t.json({ t: 'pin', pin: `${o.pin}x` });
      const ng = await t.waitFor((m) => m.t === 'pin');
      if (!ng || ng.t !== 'pin' || ng.ok) return '間違った PIN が通った';
      t.json({ t: 'pin', pin: o.pin });
      const ok = await t.waitFor((m) => m.t === 'pin');
      if (!ok || ok.t !== 'pin' || !ok.ok) return '正しい PIN が通らない';
      t.json({ t: 'force_release' });
      await sleep(300);
      const s = await dmx();
      return s.holder === null && allAre(s, 0) ? true : 'force_release で外れない';
    });

    await check('規則 4（公演モード）: 時間切れでは外れず、force_release だけで外れる', async () => {
      const t = await join();
      t.json({ t: 'pin', pin: o.pin });
      await t.waitFor((m) => m.t === 'pin');
      t.json({ t: 'show_mode', on: true });
      const a = await join();
      a.json({ t: 'claim' });
      await a.waitFor((m) => m.t === 'status' && m.holder?.kind === 'ws' && m.holder.you);
      a.frame(50);
      await sleep(timeoutMs + 800);
      const held = await dmx();
      if (!held.show_mode) return 'show_mode が入らない';
      if (held.holder === null || !allAre(held, 50)) return '公演モードなのに時間切れで外れた';
      t.json({ t: 'force_release' });
      t.json({ t: 'show_mode', on: false });
      await sleep(300);
      const s = await dmx();
      return s.holder === null && allAre(s, 0) && !s.show_mode ? true : 'force_release で外れない';
    });

    await check('接続は max_clients 本まで。超えた分は close code 1013 で断る', async () => {
      for (const c of opened.splice(0)) c.close();
      await sleep(300);
      const max = (await dmx()).max_clients;
      if (!Number.isInteger(max) || max < 1) return `GET /api/dmx の max_clients が正しくない（${max}）`;
      const many: Client[] = [];
      try {
        for (let i = 0; i < max; i++) many.push(await Client.open(wsUrl));
        const status = await many[0].waitFor((m) => m.t === 'status');
        if (status?.t === 'status' && status.max_clients !== max) return `status の max_clients（${status.max_clients}）が GET /api/dmx（${max}）とちがう`;
        const extra = await Client.open(wsUrl).catch(() => null);
        if (!extra) return `${max + 1} 本目が接続できず、close code を確かめられない`;
        many.push(extra);
        const code = await extra.closed();
        return code === 1013 ? true : `${max + 1} 本目の close code が ${code || 'なし'}`;
      } finally {
        for (const c of many) c.close();
      }
    });
  } finally {
    for (const s of stops) s();
    for (const c of opened) c.close();
    udp.close();
  }
  return results;
}

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runChecks({
    host: arg('host', '127.0.0.1'),
    port: Number(arg('port', '80')),
    pin: arg('pin', '0000'),
    timeoutMs: Number(arg('timeout', String(LOCK_TIMEOUT_MS))),
    artnetPort: Number(arg('artnet-port', String(ARTNET_PORT))),
    sacnPort: Number(arg('sacn-port', String(SACN_PORT))),
    sacnUniverse: Number(arg('sacn-universe', '1')),
    log: (l) => console.log(l),
  }).then((rs) => {
    const ng = rs.filter((r) => !r.ok).length;
    console.log(ng ? `\n${ng} 件が仕様どおりではありません。` : `\nすべて仕様どおりです（${rs.length} 件）。`);
    process.exit(ng ? 1 : 0);
  });
}

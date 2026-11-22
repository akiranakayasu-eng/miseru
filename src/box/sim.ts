// 偽の箱（Node.js）。本物の箱と同じ仕様で、画面を配り、WebSocket と Art-Net・sACN を受け、DMX の値を出す。
// miseru の出口の確認と、ファームの受け入れ試験の相手に使う。
//
//   npm run box:sim -- --port 8081 --pin 0000 --dir dist/box
//   （ほかに --name ODE-DIY、--allow 192.0.2.10,192.0.2.11、--artnet-in、--sacn-in）
//
// 出している DMX の値は GET /api/dmx で見られる（JSON）。

import dgram from 'node:dgram';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { parseArtDmx } from '../server/sources.js';
import { BoxCore } from './core.js';
import { DEFAULT_BOX_NAME, parseClientMessage, type ServerMessage } from './protocol.js';
import { parseSacn, SACN_PORT } from './sacnIn.js';

export interface SimOptions {
  port: number;
  pin: string;
  dir: string;
  timeoutMs?: number;
  /** 同時接続の上限（既定 8） */
  maxClients?: number;
  /** Art-Net を受けるポート。未指定なら受けない（0 なら空いているポート） */
  artnetPort?: number;
  /** sACN を受けるポート。未指定なら受けない（0 なら空いているポート） */
  sacnPort?: number;
  /** sACN で受けるユニバース（既定 1） */
  sacnUniverse?: number;
  /** 箱の名前（既定 ODE-DIY） */
  name?: string;
  /** 許可リスト（IP）。空なら誰でも使える */
  allow?: string[];
  host?: string;
  log?: (line: string) => void;
}

const mime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

export interface Sim {
  core: BoxCore;
  port: number;
  artnetPort: number;
  sacnPort: number;
  /** 箱の押しボタンを押す */
  button(): void;
  close(): Promise<void>;
}

export async function startSim(o: SimOptions): Promise<Sim> {
  const log = o.log ?? (() => {});
  const core = new BoxCore({
    pin: o.pin,
    timeoutMs: o.timeoutMs,
    maxConnections: o.maxClients,
    name: o.name ?? DEFAULT_BOX_NAME,
    allow: o.allow,
  });
  const dir = resolve(o.dir);
  const sockets = new Map<WebSocket, number>();
  let nextConn = 1;

  const http = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/api/dmx') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return res.end(
        JSON.stringify({
          name: core.name,
          holder: core.holder,
          show_mode: core.showMode,
          max_clients: core.maxClients,
          output: Array.from(core.output),
        }),
      );
    }
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
    let file = join(dir, rel);
    if (!file.startsWith(dir) || !existsSync(file) || statSync(file).isDirectory()) file = join(dir, 'index.html');
    if (!existsSync(file)) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('画面がありません。npm run build:box を実行してください。');
    }
    res.writeHead(200, { 'content-type': mime[extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  });

  const wss = new WebSocketServer({ server: http, path: '/ws' });
  const send = (ws: WebSocket, m: ServerMessage) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m));
  };
  const broadcastStatus = () => {
    for (const [ws, conn] of sockets) send(ws, core.status(conn));
  };

  wss.on('connection', (ws, req) => {
    const conn = nextConn++;
    if (!core.open(conn, req.socket.remoteAddress)) {
      ws.close(1013, 'too many connections');
      return;
    }
    sockets.set(ws, conn);
    send(ws, core.status(conn));
    ws.on('message', (data, isBinary) => {
      const now = Date.now();
      if (isBinary) {
        const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
        core.binary(conn, new Uint8Array(buf), now);
        return;
      }
      const msg = parseClientMessage(String(data));
      if (!msg) return;
      const before = core.version;
      for (const reply of core.message(conn, msg, now)) send(ws, reply);
      if (core.version !== before) {
        log(`ロック/公演モードが変わりました（holder=${JSON.stringify(core.holder)} show=${core.showMode}）`);
        broadcastStatus();
      }
    });
    ws.on('close', () => {
      sockets.delete(ws);
      core.close(conn);
    });
  });

  // 時間切れは 0.1 秒刻みで確かめ、状態は 1 秒ごとにも配る（接続したてのタブにも届くように）
  const tickTimer = setInterval(() => {
    const before = core.version;
    core.tick(Date.now());
    if (core.version !== before) {
      log(`時間切れでロックが外れました（全消灯）`);
      broadcastStatus();
    }
  }, 100);
  const statusTimer = setInterval(broadcastStatus, 1000);

  let udp: dgram.Socket | undefined;
  let artnetPort = 0;
  if (o.artnetPort !== undefined) {
    udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    udp.on('message', (msg, rinfo) => {
      const pkt = parseArtDmx(msg);
      if (pkt && pkt.universe === 0) core.artnet(rinfo.address, pkt.data, Date.now());
    });
    await new Promise<void>((ok) => udp!.bind(o.artnetPort, o.host ?? '0.0.0.0', ok));
    artnetPort = udp.address().port;
  }

  let sacnUdp: dgram.Socket | undefined;
  let sacnPort = 0;
  if (o.sacnPort !== undefined) {
    const universe = o.sacnUniverse ?? 1;
    sacnUdp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    sacnUdp.on('message', (msg, rinfo) => {
      const pkt = parseSacn(new Uint8Array(msg));
      if (!pkt || pkt.universe !== universe) return;
      const before = core.version;
      if (pkt.terminated) core.sacnTerminated(rinfo.address);
      else if (pkt.data) core.sacn(rinfo.address, pkt.data, Date.now());
      if (core.version !== before) broadcastStatus();
    });
    await new Promise<void>((ok) => sacnUdp!.bind(o.sacnPort, o.host ?? '0.0.0.0', ok));
    sacnPort = sacnUdp.address().port;
    try {
      // sACN はふつうマルチキャスト（239.255.<上位>.<下位>）で届くので、そのグループに入る
      sacnUdp.addMembership(`239.255.${(universe >> 8) & 0xff}.${universe & 0xff}`);
    } catch {
      // マルチキャストが使えない環境（試験の 127.0.0.1 など）では、ユニキャストだけ受ける
    }
  }

  await new Promise<void>((ok) => http.listen(o.port, o.host ?? '0.0.0.0', ok));
  const port = (http.address() as { port: number }).port;
  log(`偽の箱: http://localhost:${port}/（画面は ${dir}）`);

  return {
    core,
    port,
    artnetPort,
    sacnPort,
    button: () => {
      core.button();
      broadcastStatus();
    },
    close: async () => {
      clearInterval(tickTimer);
      clearInterval(statusTimer);
      udp?.close();
      sacnUdp?.close();
      for (const ws of sockets.keys()) ws.terminate();
      wss.close();
      await new Promise<void>((ok) => http.close(() => ok()));
    },
  };
}

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const artnetIn = process.argv.includes('--artnet-in');
  const sacnIn = process.argv.includes('--sacn-in');
  const allow = arg('allow', '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  startSim({
    port: Number(arg('port', '8081')),
    pin: arg('pin', '0000'),
    dir: arg('dir', 'dist/box'),
    timeoutMs: Number(arg('timeout', '5000')),
    maxClients: Number(arg('max-clients', '8')),
    artnetPort: artnetIn ? Number(arg('artnet-port', '6454')) : undefined,
    sacnPort: sacnIn ? Number(arg('sacn-port', String(SACN_PORT))) : undefined,
    sacnUniverse: Number(arg('sacn-universe', '1')),
    name: arg('name', DEFAULT_BOX_NAME),
    allow,
    log: (l) => console.log(l),
  }).then((s) => {
    console.log(
      `箱の名前: ${s.core.name} / 先生の PIN: ${arg('pin', '0000')} / ロックの時間切れ: ${arg('timeout', '5000')}ms` +
        (artnetIn ? ' / Art-Net 受信あり' : '') +
        (sacnIn ? ' / sACN 受信あり' : '') +
        (allow.length ? ` / 許可リスト: ${allow.join(', ')}` : ''),
    );
    process.on('SIGINT', () => s.close().then(() => process.exit(0)));
  });
}

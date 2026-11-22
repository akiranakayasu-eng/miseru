// 常駐アプリ: 照明の状態を持ち、Art-Net を送り、画面（Web）を配る。

import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { applyCommand, fixtureTypes, fxNow, hasFx, initialState, patches, renderUniverse, validatePatch } from '../engine/index.js';
import type { ShowCommand, ShowState } from '../engine/index.js';
import { ArtNetSender } from './artnet.js';
import { SacnSender } from './sacn.js';
import { PairingAuth } from './auth.js';
import { loadConfig } from './config.js';
import { ArtNetInputs } from './sources.js';

const config = loadConfig(process.argv[2]);
const patch = patches[config.patch];
if (!patch) throw new Error(`Unknown patch: ${config.patch}`);
const patchErrors = validatePatch(patch);
if (patchErrors.length) throw new Error(patchErrors.join('\n'));

const auth = new PairingAuth(join(config.dataDir, 'tokens.json'));
let state: ShowState = initialState(patch);

// ---- Art-Net 出力 ----
// 変化があった直後は 30 回/秒、落ち着いたら 1 回/秒送り続ける（Art-Net は 4 秒以内の再送が必要）。
const universe = config.artnet.universe ?? patch.universe;
const sender = config.artnet.host
  ? new ArtNetSender({ host: config.artnet.host, universe, broadcast: config.artnet.broadcast, bindAddress: config.artnet.bindAddress })
  : null;

// sACN は Art-Net と同じデータを、設定したときだけ並べて送る（universe は 1 始まり）
const sacnSender = config.sacn.enabled
  ? new SacnSender({
      universe: config.sacn.universe ?? universe + 1,
      priority: config.sacn.priority,
      host: config.sacn.host,
      bindAddress: config.sacn.bindAddress,
    })
  : null;

// ODE に流す出どころ。'app' はこのアプリの画面、それ以外は Wi-Fi 側から届いた Art-Net。
let activeSource = 'app';
const inputs = new ArtNetInputs(universe, () => broadcastSources());
if (config.input.enabled) inputs.listen(config.input.bindAddress);

let lastChange = 0;
let lastSend = 0;
setInterval(() => {
  const now = Date.now();
  const external = activeSource === 'app' ? undefined : inputs.get(activeSource);
  // 外からの出どころを選んでいるときは、届いた分をそのまま 30 回/秒で流す（途切れたら最後の状態を保つ）
  // 演出（ストロボ・チェイスなど）が付いている間も、30 回/秒で送り続ける
  const busy = external ? true : now - lastChange < 2000 || hasFx(state.looks);
  if (!busy && now - lastSend < 1000) return;
  lastSend = now;
  const out = external ? external.data : renderUniverse(patch, state, fxNow());
  sender?.send(out);
  sacnSender?.send(out);
}, 1000 / 30);

// ---- 画面の配信と API ----
const uiDir = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../ui');
const mime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
};

function isLocal(req: IncomingMessage): boolean {
  const a = req.socket.remoteAddress ?? '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 10_000) break;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/api/pair' && req.method === 'POST') {
    const body = (await readBody(req)) as { code?: string };
    const result = auth.pair(body.code);
    return sendJson(res, 'token' in result ? 200 : 403, result);
  }
  if (url.pathname === '/api/pair-code') {
    // 接続コードは常駐アプリを動かしている PC からだけ見られる
    if (!isLocal(req)) return sendJson(res, 403, { error: 'Available from this computer only' });
    return sendJson(res, 200, { code: auth.code });
  }
  if (url.pathname === '/api/status') {
    return sendJson(res, 200, { requirePairing: config.requirePairing });
  }

  // 静的ファイル
  const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
  let file = join(uiDir, rel);
  if (!file.startsWith(uiDir) || !existsSync(file) || statSync(file).isDirectory()) file = join(uiDir, 'index.html');
  if (!existsSync(file)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('The UI has not been built yet. Run npm run build.');
  }
  res.writeHead(200, { 'content-type': mime[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
});

// ---- 操作（WebSocket） ----
const wss = new WebSocketServer({ server, path: '/ws' });
const clients = new Set<WebSocket>();
const teachers = new WeakSet<WebSocket>();

function broadcast() {
  const msg = JSON.stringify({ type: 'state', state });
  for (const c of clients) c.send(msg);
}

function sourcesMessage() {
  return JSON.stringify({
    type: 'sources',
    active: activeSource,
    list: [{ id: 'app', label: 'This app (miseru)', alive: true }, ...inputs.list()],
  });
}

function broadcastSources() {
  const msg = sourcesMessage();
  for (const c of clients) c.send(msg);
}
// 出どころが途切れたかどうかを画面に知らせる
setInterval(broadcastSources, 2000);

wss.on('connection', (ws, req) => {
  const token = new URL(req.url ?? '/', 'http://localhost').searchParams.get('token');
  if (config.requirePairing && !auth.isValid(token)) {
    ws.close(4401, 'unpaired');
    return;
  }
  clients.add(ws);
  let pinFailures = 0;
  ws.send(JSON.stringify({ type: 'hello', patch, fixtureTypes, state, teacherAvailable: !!config.teacherPin }));
  ws.send(sourcesMessage());
  ws.on('message', (raw) => {
    let msg: ShowCommand | { type: 'teacher'; pin: string } | { type: 'source'; id: string };
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (msg.type === 'teacher') {
      const ok = !!config.teacherPin && msg.pin === config.teacherPin;
      if (ok) teachers.add(ws);
      else if ((pinFailures += 1) >= 5) ws.close(4403, 'too many attempts');
      ws.send(JSON.stringify({ type: 'teacher', ok }));
      return;
    }
    if (msg.type === 'source') {
      if (!teachers.has(ws)) return;
      if (msg.id === 'app' || inputs.get(msg.id)) {
        activeSource = msg.id;
        lastChange = Date.now();
        broadcastSources();
      }
      return;
    }
    state = applyCommand(patch, state, msg);
    lastChange = Date.now();
    broadcast();
  });
  ws.on('close', () => clients.delete(ws));
});

server.listen(config.http.port, config.http.host, () => {
  console.log(`miseru: ${patch.name} (${patch.lights.length} fixtures)`);
  console.log(`UI: http://localhost:${config.http.port}/`);
  if (sacnSender) console.log(`sACN output: universe ${config.sacn.universe ?? universe + 1}, ${config.sacn.host || 'multicast'}`);
  console.log(sender ? `Art-Net output: ${config.artnet.host} (universe ${universe})` : 'Art-Net output: off (artnet.host is empty)');
  if (config.input.enabled) console.log(`Art-Net input: ${config.input.bindAddress ?? '0.0.0.0'}:6454 (switch sources in the Admin panel)`);
  if (config.requirePairing) console.log(`Pairing code: ${auth.code}`);
});

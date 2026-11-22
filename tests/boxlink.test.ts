import { afterEach, describe, expect, it } from 'vitest';
import { BoxLink, type BoxStatus } from '../src/ui/boxLink.js';
import { startSim, type Sim } from '../src/box/sim.js';
import { applyCommand, initialState, renderUniverse, tmuPhotoStudio } from '../src/engine/index.js';

let sim: Sim | undefined;
const links: BoxLink[] = [];

afterEach(async () => {
  for (const l of links.splice(0)) l.close();
  await sim?.close();
  sim = undefined;
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 3000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('時間内に条件が満たされませんでした');
    await wait(10);
  }
}

function link(port: number, id: string) {
  const seen = { status: null as BoxStatus | null, denied: '', lost: 0, pin: null as boolean | null };
  const l = new BoxLink({
    url: `ws://127.0.0.1:${port}/ws`,
    id,
    onState: () => {},
    onStatus: (s) => (seen.status = s),
    onDenied: (r) => (seen.denied = r),
    onLost: () => seen.lost++,
    onPin: (ok) => (seen.pin = ok),
    frameIntervalMs: 10,
    heartbeatMs: 200,
  });
  links.push(l);
  l.connect();
  return { l, seen };
}

describe('miseru の出口 ↔ 偽の箱', () => {
  it('hello と claim でロックを取り、エンジンの値が DMX に出る', async () => {
    sim = await startSim({ port: 0, pin: '0000', dir: 'dist/box', timeoutMs: 5000 });
    const { l, seen } = link(sim.port, 'tab-a');
    await until(() => seen.status?.holder?.kind === 'ws' && seen.status.holder.you);

    const patch = tmuPhotoStudio;
    let state = applyCommand(patch, initialState(patch), { type: 'set', ids: ['arri1'], look: { intensity: 1, sat: 1, hue: 0 } });
    l.setFrame(renderUniverse(patch, state));
    await until(() => sim!.core.output[0] === 255);
    expect(Array.from(sim.core.output.slice(0, 8))).toEqual([255, 99, 128, 255, 255, 0, 0, 0]);

    // 全消灯
    state = applyCommand(patch, state, { type: 'blackout', on: true });
    l.setFrame(renderUniverse(patch, state));
    await until(() => sim!.core.output[0] === 0);
  });

  it('2 つ目のタブは busy で断られ、フレームは使われない', async () => {
    sim = await startSim({ port: 0, pin: '0000', dir: 'dist/box' });
    const a = link(sim.port, 'tab-a');
    await until(() => a.seen.status?.holder?.kind === 'ws' && a.seen.status.holder.you);
    const b = link(sim.port, 'tab-b');
    await until(() => b.seen.denied === 'busy');
    b.l.setFrame(new Uint8Array(512).fill(99));
    a.l.setFrame(new Uint8Array(512).fill(11));
    await until(() => sim!.core.output[0] === 11);
    await wait(100);
    expect(sim.core.output[0]).toBe(11);
  });

  it('おしまい（release）で待たずに全消灯し、次のタブが取れる', async () => {
    sim = await startSim({ port: 0, pin: '0000', dir: 'dist/box' });
    const a = link(sim.port, 'tab-a');
    await until(() => a.seen.status?.holder?.kind === 'ws' && a.seen.status.holder.you);
    a.l.setFrame(new Uint8Array(512).fill(200));
    await until(() => sim!.core.output[0] === 200);
    a.l.release();
    await until(() => sim!.core.output[0] === 0 && sim!.core.holder === null);

    const b = link(sim.port, 'tab-b');
    await until(() => b.seen.status?.holder?.kind === 'ws' && b.seen.status.holder.you);
  });

  it('先生の force_release で外され、取り直さずに onLost になる', async () => {
    sim = await startSim({ port: 0, pin: '0000', dir: 'dist/box' });
    const a = link(sim.port, 'tab-a');
    const t = link(sim.port, 'teacher');
    await until(() => a.seen.status?.holder?.kind === 'ws' && a.seen.status.holder.you);
    await until(() => t.seen.status !== null);
    t.l.pin('9999');
    await until(() => t.seen.pin === false);
    t.l.pin('0000');
    await until(() => t.seen.pin === true);
    t.l.forceRelease();
    await until(() => a.seen.lost === 1);
    await wait(150);
    expect(sim.core.holder).toBeNull();
  });

  it('止まった送り手は時間切れで外れ、全消灯する', async () => {
    sim = await startSim({ port: 0, pin: '0000', dir: 'dist/box', timeoutMs: 300 });
    const a = link(sim.port, 'tab-a');
    await until(() => a.seen.status?.holder?.kind === 'ws' && a.seen.status.holder.you);
    a.l.setFrame(new Uint8Array(512).fill(150));
    await until(() => sim!.core.output[0] === 150);
    a.l.close(); // フレームも ping も止まる
    await until(() => sim!.core.holder === null, 2000);
    expect(sim.core.output[0]).toBe(0);
  });

  it('ブラウザは変化がなくても 1 秒に 1 回以上フレームを送り直す', async () => {
    sim = await startSim({ port: 0, pin: '0000', dir: 'dist/box', timeoutMs: 600 });
    const a = link(sim.port, 'tab-a');
    await until(() => a.seen.status?.holder?.kind === 'ws' && a.seen.status.holder.you);
    a.l.setFrame(new Uint8Array(512).fill(42));
    await wait(1500); // 時間切れ（600ms）より長く、値は変えない
    expect(sim.core.holder).not.toBeNull();
    expect(sim.core.output[0]).toBe(42);
  });

  it('Art-Net の送り手が先にロックを取っていれば、ブラウザは busy', async () => {
    sim = await startSim({ port: 0, pin: '0000', dir: 'dist/box', artnetPort: 0 });
    const { buildArtDmx } = await import('../src/server/artnet.js');
    const dgram = await import('node:dgram');
    const s = dgram.createSocket('udp4');
    s.send(buildArtDmx(0, new Uint8Array(512).fill(33)), sim.artnetPort, '127.0.0.1');
    await until(() => sim!.core.output[0] === 33);
    s.close();
    const a = link(sim.port, 'tab-a');
    await until(() => a.seen.denied === 'busy');
    expect(a.seen.status?.holder).toMatchObject({ kind: 'artnet' });
  });
});

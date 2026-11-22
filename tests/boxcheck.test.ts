import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runChecks } from '../src/box/check.js';
import { startSim, type Sim } from '../src/box/sim.js';

// 受け入れ試験そのものが正しいかを、偽の箱に当てて確かめる（偽の箱は仕様どおりのはず）。
describe('受け入れ試験（偽の箱に当てる）', () => {
  let sim: Sim;
  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'miseru-box-'));
    mkdirSync(join(dir, 'assets'));
    writeFileSync(
      join(dir, 'index.html'),
      '<!doctype html><script type="module" src="./assets/index-x.js"></script><link rel="stylesheet" href="./assets/index-x.css">',
    );
    writeFileSync(join(dir, 'assets', 'index-x.js'), 'console.log(1)');
    writeFileSync(join(dir, 'assets', 'index-x.css'), 'body{}');
    sim = await startSim({ port: 0, pin: '0000', dir, timeoutMs: 400, artnetPort: 0, sacnPort: 0, host: '127.0.0.1' });
  });
  afterAll(() => sim.close());

  it('すべての項目が通る', async () => {
    const results = await runChecks({
      host: '127.0.0.1',
      port: sim.port,
      pin: '0000',
      timeoutMs: 400,
      artnetPort: sim.artnetPort,
      sacnPort: sim.sacnPort,
    });
    expect(results.filter((r) => !r.ok)).toEqual([]);
    expect(results.length).toBe(14);
  }, 20000);

  it('仕様とちがえば落ちる（PIN をまちがえると先生の項目が通らない）', async () => {
    const results = await runChecks({
      host: '127.0.0.1',
      port: sim.port,
      pin: '9999',
      timeoutMs: 400,
      artnetPort: sim.artnetPort,
      sacnPort: sim.sacnPort,
    });
    expect(results.filter((r) => !r.ok).map((r) => r.name)).toEqual(
      expect.arrayContaining([expect.stringContaining('PIN'), expect.stringContaining('公演モード')]),
    );
  }, 20000);
});

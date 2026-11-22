import { describe, expect, it } from 'vitest';
import { BoxCore } from '../src/box/core.js';
import { encodeFrame, type ServerMessage } from '../src/box/protocol.js';

const hello = (id: string) => ({ t: 'hello' as const, id, app: 'miseru', v: 0 });
const frame = (v: number) => encodeFrame(new Uint8Array(512).fill(v));
const statusOf = (r: ServerMessage[]) => r.find((m) => m.t === 'status');

function setup(opts: { pin?: string; timeoutMs?: number } = {}) {
  const box = new BoxCore({ pin: opts.pin ?? '0000', timeoutMs: opts.timeoutMs ?? 5000 });
  const join = (conn: number, id: string, now = 0) => {
    expect(box.open(conn)).toBe(true);
    box.message(conn, hello(id), now);
  };
  return { box, join };
}

describe('ロックの規則 1: 最初に claim した接続が取る', () => {
  it('空いていれば取れ、ほかは busy で断られる', () => {
    const { box, join } = setup();
    join(1, 'aaaa');
    join(2, 'bbbb');
    expect(box.message(1, { t: 'claim' }, 0)).toEqual([]);
    expect(box.message(2, { t: 'claim' }, 0)).toEqual([{ t: 'denied', reason: 'busy' }]);
    expect(statusOf([box.status(1)])).toMatchObject({ holder: { kind: 'ws', you: true } });
    expect(statusOf([box.status(2)])).toMatchObject({ holder: { kind: 'ws', you: false } });
  });

  it('hello の前の claim は断る', () => {
    const { box } = setup();
    box.open(1);
    expect(box.message(1, { t: 'claim' }, 0)).toEqual([{ t: 'denied', reason: 'no_hello' }]);
  });

  it('ロックを持つ接続のフレームだけを使い、ほかは捨てる', () => {
    const { box, join } = setup();
    join(1, 'aaaa');
    join(2, 'bbbb');
    box.message(1, { t: 'claim' }, 0);
    box.binary(2, frame(9), 10);
    expect(box.output[0]).toBe(0);
    box.binary(1, frame(7), 10);
    expect(box.output[0]).toBe(7);
    expect(box.output[511]).toBe(7);
  });

  it('512 未満で切れたフレームは残りを 0 にする', () => {
    const { box, join } = setup();
    join(1, 'aaaa');
    box.message(1, { t: 'claim' }, 0);
    box.binary(1, new Uint8Array([0x01, 0, 5, 6, 7]), 1);
    expect(Array.from(box.output.slice(0, 4))).toEqual([5, 6, 7, 0]);
  });

  it('Art-Net も、空いていれば最初に届いた IP がロックを取る', () => {
    const { box, join } = setup();
    box.artnet('192.0.2.31', new Uint8Array(512).fill(3), 0);
    box.artnet('192.0.2.32', new Uint8Array(512).fill(9), 1);
    expect(box.output[0]).toBe(3);
    join(1, 'aaaa');
    expect(box.message(1, { t: 'claim' }, 2)).toEqual([{ t: 'denied', reason: 'busy' }]);
    expect(statusOf([box.status(1)])).toMatchObject({ holder: { kind: 'artnet', ip: '192.0.2.31' } });
  });
});

describe('ロックの規則 2: 5 秒届かなければ全消灯して外す', () => {
  it('フレームも ping も 5 秒なければ外れ、全スロット 0', () => {
    const { box, join } = setup();
    join(1, 'aaaa');
    box.message(1, { t: 'claim' }, 0);
    box.binary(1, frame(200), 1000);
    box.tick(5999);
    expect(box.output[0]).toBe(200);
    box.tick(6000);
    expect(box.output[0]).toBe(0);
    expect(box.holder).toBeNull();
  });

  it('ping で時間切れを延ばせる', () => {
    const { box, join } = setup();
    join(1, 'aaaa');
    box.message(1, { t: 'claim' }, 0);
    box.message(1, { t: 'ping' }, 4000);
    box.tick(8999);
    expect(box.holder).not.toBeNull();
    box.tick(9000);
    expect(box.holder).toBeNull();
  });

  it('WebSocket が切れてもすぐには外さず、同じ id で再接続すれば続けられる', () => {
    const { box, join } = setup();
    join(1, 'aaaa');
    box.message(1, { t: 'claim' }, 0);
    box.binary(1, frame(50), 100);
    box.close(1);
    box.tick(3000);
    expect(box.output[0]).toBe(50);
    join(2, 'aaaa', 3500);
    box.binary(2, frame(60), 3600);
    expect(box.output[0]).toBe(60);
    box.tick(8000);
    expect(box.holder).not.toBeNull();
  });

  it('戻ってこなければ 5 秒で外れ、次の送り手が取れる', () => {
    const { box, join } = setup();
    join(1, 'aaaa');
    box.message(1, { t: 'claim' }, 0);
    box.close(1);
    join(2, 'bbbb', 100);
    expect(box.message(2, { t: 'claim' }, 100)).toEqual([{ t: 'denied', reason: 'busy' }]);
    box.tick(5000);
    expect(box.message(2, { t: 'claim' }, 5001)).toEqual([]);
    expect(statusOf([box.status(2)])).toMatchObject({ holder: { kind: 'ws', you: true } });
  });
});

describe('ロックの規則 3: release・先生の force_release・ボタンは待たない', () => {
  it('release は本人だけ有効で、すぐ全消灯', () => {
    const { box, join } = setup();
    join(1, 'aaaa');
    join(2, 'bbbb');
    box.message(1, { t: 'claim' }, 0);
    box.binary(1, frame(80), 1);
    box.message(2, { t: 'release' }, 2);
    expect(box.output[0]).toBe(80);
    box.message(1, { t: 'release' }, 3);
    expect(box.output[0]).toBe(0);
    expect(box.holder).toBeNull();
  });

  it('force_release は先生だけ。PIN がちがえば先生になれない', () => {
    const { box, join } = setup();
    join(1, 'aaaa');
    join(2, 'bbbb');
    box.message(1, { t: 'claim' }, 0);
    box.binary(1, frame(80), 1);
    expect(box.message(2, { t: 'pin', pin: '9999' }, 2)[0]).toEqual({ t: 'pin', ok: false });
    box.message(2, { t: 'force_release' }, 3);
    expect(box.holder).not.toBeNull();
    expect(box.message(2, { t: 'pin', pin: '0000' }, 4)[0]).toEqual({ t: 'pin', ok: true });
    box.message(2, { t: 'force_release' }, 5);
    expect(box.holder).toBeNull();
    expect(box.output[0]).toBe(0);
  });

  it('PIN が空の設定では先生になれない', () => {
    const { box, join } = setup({ pin: '' });
    join(1, 'aaaa');
    expect(box.message(1, { t: 'pin', pin: '' }, 0)[0]).toEqual({ t: 'pin', ok: false });
  });

  it('ボタンは公演モード中でも外す', () => {
    const { box, join } = setup();
    join(1, 'aaaa');
    box.message(1, { t: 'claim' }, 0);
    box.message(1, { t: 'pin', pin: '0000' }, 0);
    box.message(1, { t: 'show_mode', on: true }, 0);
    box.binary(1, frame(10), 1);
    box.button();
    expect(box.holder).toBeNull();
    expect(box.output[0]).toBe(0);
  });
});

describe('ロックの規則 4: 公演モード', () => {
  it('時間切れでは外れず、最後の値を出し続ける。先生だけが切り替えられる', () => {
    const { box, join } = setup();
    join(1, 'aaaa');
    join(2, 'bbbb');
    box.message(1, { t: 'claim' }, 0);
    box.binary(1, frame(120), 1);
    box.message(1, { t: 'show_mode', on: true }, 2);
    expect(box.showMode).toBe(false);
    box.message(2, { t: 'pin', pin: '0000' }, 3);
    box.message(2, { t: 'show_mode', on: true }, 4);
    expect(box.showMode).toBe(true);
    box.tick(60_000);
    expect(box.holder).not.toBeNull();
    expect(box.output[0]).toBe(120);
    box.message(2, { t: 'force_release' }, 60_001);
    expect(box.holder).toBeNull();
    expect(box.output[0]).toBe(0);
  });

  it('公演モードを切ると、止まっている送り手は次の tick で外れる', () => {
    const { box, join } = setup();
    join(1, 'aaaa');
    box.message(1, { t: 'claim' }, 0);
    box.message(1, { t: 'pin', pin: '0000' }, 0);
    box.message(1, { t: 'show_mode', on: true }, 0);
    box.tick(30_000);
    box.message(1, { t: 'show_mode', on: false }, 30_001);
    box.tick(30_002);
    expect(box.holder).toBeNull();
  });
});

describe('ロックの規則 5: ロックがなければ 0 を出し続ける', () => {
  it('外れたあとは次の送り手が来るまで全スロット 0', () => {
    const { box, join } = setup();
    join(1, 'aaaa');
    box.message(1, { t: 'claim' }, 0);
    box.binary(1, frame(255), 1);
    box.tick(6000);
    expect(Array.from(box.output).every((v) => v === 0)).toBe(true);
    box.binary(1, frame(255), 6001);
    expect(Array.from(box.output).every((v) => v === 0)).toBe(true);
  });
});

describe('接続の上限', () => {
  it('同時接続は 8 本まで。9 本目は断る', () => {
    const { box } = setup();
    for (let i = 0; i < 8; i++) expect(box.open(i)).toBe(true);
    expect(box.open(8)).toBe(false);
    box.close(0);
    expect(box.open(8)).toBe(true);
  });

  it('上限は設定で変えられ、status の max_clients で知らせる', () => {
    const box = new BoxCore({ pin: '0000', maxConnections: 30 });
    for (let i = 0; i < 30; i++) expect(box.open(i)).toBe(true);
    expect(box.open(30)).toBe(false);
    expect(box.status(0)).toMatchObject({ t: 'status', max_clients: 30 });
  });
});

describe('状態の変化', () => {
  it('ロックと公演モードが変わると version が増える', () => {
    const { box, join } = setup();
    join(1, 'aaaa');
    const v0 = box.version;
    box.message(1, { t: 'claim' }, 0);
    expect(box.version).toBe(v0 + 1);
    box.message(1, { t: 'release' }, 1);
    expect(box.version).toBe(v0 + 2);
  });
});

describe('仕様 v1 の追記（ファーム v0.2.0）', () => {
  const slots = (v: number) => new Uint8Array(512).fill(v);

  it('status で箱の名前を知らせる（既定 ODE-DIY、設定で変えられる）', () => {
    expect(new BoxCore({ pin: '' }).status(0)).toMatchObject({ t: 'status', name: 'ODE-DIY' });
    expect(new BoxCore({ pin: '', name: 'スタジオ' }).status(0)).toMatchObject({ name: 'スタジオ' });
  });

  it('sACN の送り手は Art-Net と同じくロックを取り、holder.kind は sacn', () => {
    const { box, join } = setup();
    join(1, 'aaaa');
    box.sacn('192.0.2.50', slots(30), 0);
    expect(box.status(1)).toMatchObject({ holder: { kind: 'sacn', ip: '192.0.2.50' } });
    expect(box.output[0]).toBe(30);
    expect(box.message(1, { t: 'claim' }, 1)).toEqual([{ t: 'denied', reason: 'busy' }]);
    // ほかの送り手の値は使わない
    box.artnet('192.0.2.60', slots(99), 2);
    box.sacn('192.0.2.61', slots(99), 2);
    expect(box.output[0]).toBe(30);
  });

  it('sACN も 5 秒黙れば外れ、Stream_Terminated なら待たずに全消灯して外れる', () => {
    const { box } = setup({ timeoutMs: 5000 });
    box.sacn('192.0.2.50', slots(30), 0);
    box.tick(4999);
    expect(box.holder).not.toBeNull();
    box.tick(5000);
    expect(box.holder).toBeNull();

    box.sacn('192.0.2.50', slots(30), 6000);
    box.sacnTerminated('192.0.2.99'); // 持ち主でなければ何もしない
    expect(box.holder).not.toBeNull();
    box.sacnTerminated('192.0.2.50');
    expect(box.holder).toBeNull();
    expect(box.output.every((x) => x === 0)).toBe(true);
  });

  it('許可リストに無い機器の claim は not_allowed で断り、Art-Net・sACN も無視する', () => {
    const box = new BoxCore({ pin: '0000', allow: ['192.0.2.10'] });
    box.open(1, '::ffff:192.0.2.10'); // IPv6 の形でも同じ IP として扱う
    box.open(2, '192.0.2.11');
    box.message(1, { t: 'hello', id: 'aaaa', app: 'miseru', v: 0 }, 0);
    box.message(2, { t: 'hello', id: 'bbbb', app: 'miseru', v: 0 }, 0);
    expect(box.message(2, { t: 'claim' }, 0)).toEqual([{ t: 'denied', reason: 'not_allowed' }]);
    // 見ることはできる
    expect(box.status(2)).toMatchObject({ t: 'status', holder: null });
    box.artnet('192.0.2.11', slots(5), 0);
    box.sacn('192.0.2.11', slots(5), 0);
    expect(box.holder).toBeNull();
    expect(box.message(1, { t: 'claim' }, 0)).toEqual([]);
    expect(box.status(1)).toMatchObject({ holder: { kind: 'ws', you: true } });
  });

  it('許可リストが空なら誰でも使える', () => {
    const box = new BoxCore({ pin: '', allow: [] });
    box.open(1, '192.168.0.5');
    box.message(1, { t: 'hello', id: 'aaaa', app: 'miseru', v: 0 }, 0);
    expect(box.message(1, { t: 'claim' }, 0)).toEqual([]);
  });
});

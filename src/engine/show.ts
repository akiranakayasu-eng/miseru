// 照明全体の状態（どのライトがどう光っているか）と、DMX の 512ch への書き出し。

import { defaultLook, renderFixture, type Look } from './color.js';
import { applyFxAll, sanitizeFx } from './effects.js';
import { findFixtureType, type FixtureType } from './fixtures.js';

export interface PatchedLight {
  id: string;
  /** 画面に出す名前（例: 「スポット 1」） */
  name: string;
  typeId: string;
  /** DMX アドレス（1 始まり） */
  address: number;
  /** まとめて操作するためのグループ名（例: 「スポット」） */
  group?: string;
  /** 仮想スタジオ（天井を上から見た図）での中心の位置 0..1（部屋の幅・奥行きに対する割合） */
  position?: { x: number; y: number };
  /** 仮想スタジオでの形と大きさ（部屋の幅・奥行きに対する割合）。round はスポット、panel は面光源 */
  shape?: { kind: 'round' | 'panel'; w: number; h: number };
  /** 図に出す灯体番号 */
  number?: number;
}

/** 画面で灯体を区別する名前（番号があれば「1 ARRI L7-C」） */
export function lightLabel(l: Pick<PatchedLight, 'name' | 'number'>): string {
  return l.number !== undefined ? `${l.number} ${l.name}` : l.name;
}

export interface Patch {
  name: string;
  /** Art-Net のユニバース番号（0 始まり） */
  universe: number;
  lights: PatchedLight[];
  /** 仮想スタジオの部屋。aspect は 幅 / 奥行き、top は図の上側にあるもの（例: Backdrop） */
  room?: { aspect: number; top?: string };
}

export interface ShowState {
  looks: Record<string, Look>;
  /** 全体の明るさ 0..1 */
  master: number;
  /** 全消灯中か */
  blackout: boolean;
  /** Full On（作業灯）を押す前の状態。Full On 中だけある。もう一度押すとこれに戻す（2026-11-21 Akira さんの指示） */
  fullOn?: { looks: Record<string, Look>; master: number; blackout: boolean } | null;
}

export type ShowCommand =
  | { type: 'set'; ids: string[]; look: Partial<Look> }
  | { type: 'master'; value: number }
  | { type: 'blackout'; on: boolean }
  /** Full On（作業灯）: 全部を 100% の 5600K の白に。Full On 中にもう一度送ると、押す前に戻す */
  | { type: 'allOn' }
  /** 最初に戻す（フェーダーリセット）: 全部を消灯・初期値に戻す */
  | { type: 'reset' }
  /** 何台かの見た目をまとめて置き換える（タイムラインの再生で使う） */
  | { type: 'looks'; looks: Record<string, Look> };

export function initialState(patch: Patch): ShowState {
  const looks: Record<string, Look> = {};
  for (const l of patch.lights) looks[l.id] = { ...defaultLook };
  return { looks, master: 1, blackout: false };
}

export function validatePatch(patch: Patch): string[] {
  const errors: string[] = [];
  const used = new Map<number, string>();
  const ids = new Set<string>();
  for (const l of patch.lights) {
    if (ids.has(l.id)) errors.push(`Duplicate fixture ID: ${l.id}`);
    ids.add(l.id);
    const type = findFixtureType(l.typeId);
    if (!type) {
      errors.push(`${l.name}: unknown fixture type ${l.typeId}`);
      continue;
    }
    const end = l.address + type.channels.length - 1;
    if (l.address < 1 || end > 512) errors.push(`${l.name}: address ${l.address}–${end} is outside 1–512`);
    for (let ch = l.address; ch <= end; ch++) {
      const other = used.get(ch);
      if (other) errors.push(`${l.name}: channel ${ch} overlaps ${other}`);
      else used.set(ch, l.name);
    }
  }
  return errors;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

export function applyCommand(patch: Patch, state: ShowState, cmd: ShowCommand): ShowState {
  switch (cmd.type) {
    case 'set': {
      if (!Array.isArray(cmd.ids) || typeof cmd.look !== 'object' || cmd.look === null) return state;
      const looks = { ...state.looks };
      const allowed = ['intensity', 'sat', 'hue', 'cct', 'tint'] as const;
      const given: Partial<Look> = {};
      for (const k of allowed) {
        const v = cmd.look[k];
        if (typeof v === 'number' && Number.isFinite(v)) given[k] = v;
      }
      // 演出: fx に null を送ると外し、正しい形なら付ける（2026-11-21）
      const fxGiven = 'fx' in cmd.look ? (cmd.look.fx === null ? null : sanitizeFx(cmd.look.fx)) : undefined;
      for (const id of cmd.ids) {
        if (!looks[id]) continue;
        const next = { ...looks[id], ...given };
        if (fxGiven !== undefined) next.fx = fxGiven;
        next.intensity = clamp01(next.intensity);
        next.sat = clamp01(next.sat);
        if (next.tint !== undefined) next.tint = Math.max(-1, Math.min(1, next.tint));
        looks[id] = next;
      }
      // Full On のあとで照明を変えたら、もう一度押しても戻さない（変えたものを消さないため）
      return { ...state, looks, fullOn: null };
    }
    case 'master':
      return typeof cmd.value === 'number' && Number.isFinite(cmd.value) ? { ...state, master: clamp01(cmd.value) } : state;
    case 'blackout':
      // Work Light → Blackout → 解除 のときは、Work Light にも戻さず、Work Light の前の色で点いた状態に戻す（2026-11-21 Akira さんの指示「逆の押し順も同じ」）
      // Blackout と Work Light は同時に入らない（Restore が 2 つ出ないように。2026-11-21 Akira さんの指示）。
      // Work Light 中に Blackout を押したら、Work Light をやめて押す前の色に戻したうえで全消灯する
      if (state.fullOn)
        return { ...state, looks: { ...state.looks, ...state.fullOn.looks }, master: state.fullOn.master, blackout: cmd.on === true, fullOn: null };
      return { ...state, blackout: cmd.on === true };
    case 'allOn': {
      const looks = { ...state.looks };
      // 作業灯・点検用: 全部の照明を 100% の 5600K の白にし、Blackout とマスターも戻す（2026-11-21 Akira さん選択。前は消えている照明だけを点けていた）
      // Full On 中にもう一度押すと、押す前の状態に戻す（2026-11-21 Akira さんの指示）
      // Blackout は戻さない（Blackout → Work Light → Work Light で、Blackout の前の色で点いた状態に戻す。2026-11-21 Akira さんの指示）
      if (state.fullOn) return { ...state, looks: { ...looks, ...state.fullOn.looks }, master: state.fullOn.master, blackout: false, fullOn: null };
      const saved = { looks: state.looks, master: state.master, blackout: state.blackout };
      for (const id of Object.keys(looks)) looks[id] = { ...looks[id], intensity: 1, sat: 0, cct: 5600, tint: 0, fx: null };
      return { ...state, looks, blackout: false, master: 1, fullOn: saved };
    }
    case 'reset':
      return initialState(patch);
    case 'looks': {
      if (typeof cmd.looks !== 'object' || cmd.looks === null) return state;
      const looks = { ...state.looks };
      for (const [id, l] of Object.entries(cmd.looks)) {
        if (!looks[id] || typeof l !== 'object' || l === null) continue;
        const next = { ...looks[id] };
        for (const k of ['intensity', 'sat', 'hue', 'cct', 'tint'] as const) {
          if (typeof l[k] === 'number' && Number.isFinite(l[k])) next[k] = l[k];
        }
        // タイムラインの再生: キーに演出があれば付け、無ければ外す
        const fx = sanitizeFx((l as { fx?: unknown }).fx);
        if (fx) next.fx = fx;
        else delete next.fx;
        next.intensity = clamp01(next.intensity);
        next.sat = clamp01(next.sat);
        if (next.tint !== undefined) next.tint = Math.max(-1, Math.min(1, next.tint));
        looks[id] = next;
      }
      return { ...state, looks, fullOn: null };
    }
  }
  // 知らない命令は無視する（外から届くデータなので）
  return state;
}

/** 512ch の DMX データを作る。全消灯中は明るさを 0 にし、ファンなどの固定値は送り続ける。 */
export function renderUniverse(patch: Patch, state: ShowState, t?: number): Uint8Array {
  const data = new Uint8Array(512);
  // 演出は時間 t（秒）のときの見た目にして送る。t が無ければ演出をかけない
  const looks = t === undefined ? state.looks : applyFxAll(patch.lights, state.looks, t);
  for (const light of patch.lights) {
    const type: FixtureType | undefined = findFixtureType(light.typeId);
    const look = looks[light.id];
    if (!type || !look) continue;
    const factor = state.blackout ? 0 : state.master;
    const values = renderFixture(type, { ...look, intensity: look.intensity * factor });
    values.forEach((v, i) => {
      const ch = light.address - 1 + i;
      if (ch >= 0 && ch < 512) data[ch] = v;
    });
  }
  return data;
}

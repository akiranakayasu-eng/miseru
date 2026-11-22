// 照明ごとの ch（開始アドレス）と機種・モードの変更。この端末のブラウザに保存する（箱やほかの端末には届かない）。

import { findFixtureType, type Patch } from '../engine/index.js';

export interface LightEdit {
  address?: number;
  typeId?: string;
}
export type PatchEdits = Record<string, LightEdit>;

const KEY = 'miseru.patchEdits';

export function loadEdits(): PatchEdits {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as PatchEdits) : {};
  } catch {
    return {};
  }
}

export function saveEdits(edits: PatchEdits) {
  try {
    if (Object.keys(edits).length === 0) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify(edits));
  } catch {
    /* 保存できなくても、この画面を開いている間は使える */
  }
}

/** 元のパッチに変更を重ねる。知らない機種や範囲外の ch は無視して元のまま使う */
export function applyEdits(base: Patch, edits: PatchEdits): Patch {
  return {
    ...base,
    lights: base.lights.map((l) => {
      const e = edits[l.id];
      if (!e) return l;
      const typeId = e.typeId && findFixtureType(e.typeId) ? e.typeId : l.typeId;
      const count = findFixtureType(typeId)?.channels.length ?? 1;
      const address = e.address !== undefined && Number.isInteger(e.address) && e.address >= 1 && e.address + count - 1 <= 512 ? e.address : l.address;
      return { ...l, typeId, address };
    }),
  };
}

/** ch が重なっているほかの照明（なければ空） */
export function overlaps(patch: Patch, id: string): string[] {
  const span = (typeId: string, address: number) => [address, address + (findFixtureType(typeId)?.channels.length ?? 1) - 1];
  const me = patch.lights.find((l) => l.id === id);
  if (!me) return [];
  const [a1, a2] = span(me.typeId, me.address);
  return patch.lights.filter((l) => l.id !== id).filter((l) => {
    const [b1, b2] = span(l.typeId, l.address);
    return a1 <= b2 && b1 <= a2;
  }).map((l) => l.id);
}

/** 書き出すファイルの形。照明ごとの id・番号・名前・機種・開始 ch を並べる */
export interface PatchFile {
  format: 'miseru-patch';
  version: 1;
  name: string;
  lights: { id: string; number?: number; name: string; typeId: string; address: number }[];
}

export function exportPatch(patch: Patch): string {
  const file: PatchFile = {
    format: 'miseru-patch',
    version: 1,
    name: patch.name,
    lights: patch.lights.map((l) => ({ id: l.id, number: l.number, name: l.name, typeId: l.typeId, address: l.address })),
  };
  return JSON.stringify(file, null, 2);
}

/** 読み込んだファイルを、基本設定との差（変更）に直す。形が違えばエラー */
export function importPatch(text: string, defaults: Patch): PatchEdits {
  const v = JSON.parse(text) as Partial<PatchFile>;
  if (v.format !== 'miseru-patch' || !Array.isArray(v.lights)) throw new Error('Not a miseru patch file');
  const edits: PatchEdits = {};
  for (const l of v.lights) {
    const base = defaults.lights.find((d) => d.id === l?.id);
    if (!base) continue;
    const e: LightEdit = {};
    if (typeof l.typeId === 'string' && l.typeId !== base.typeId && findFixtureType(l.typeId)) e.typeId = l.typeId;
    if (typeof l.address === 'number' && l.address !== base.address) e.address = l.address;
    if (Object.keys(e).length) edits[base.id] = e;
  }
  return edits;
}

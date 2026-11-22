import type { Patch } from './show.js';

/**
 * 都立大 撮影スタジオの常設パッチ（Universe 1、68ch）。
 * 出典: https://lecture.nakayasu.com/ja/docs/photo-studio/
 * 仮想スタジオの配置は天井図の位置・形・番号に合わせた。
 * 部屋は天井図の 952 × 556 の枠で、位置と大きさはその割合。
 * 3 の高さは画面の並びに合わせて 7 と 5 の中間に置いた。
 */
const W = 952;
const H = 556;
const at = (x: number, y: number) => ({ x: (x - 24) / W, y: (y - 20) / H });
const spot = { kind: 'round' as const, w: 96 / W, h: 96 / H };
const panelH = { kind: 'panel' as const, w: 148 / W, h: 72 / H };
const panelV = { kind: 'panel' as const, w: 80 / W, h: 124 / H };
const ARRI = 'arri-l7c-plus-mode1-12ch';
const DIVA = 'kinoflo-diva-lite-31-p25-8ch';

export const tmuPhotoStudio: Patch = {
  name: 'TMU Photo Studio',
  universe: 0,
  room: { aspect: W / H, top: 'Backdrop' },
  lights: [
    { id: 'arri1', number: 1, name: 'ARRI L7-C', typeId: ARRI, address: 1, group: 'ARRI L7-C', position: at(680, 456), shape: spot },
    { id: 'arri2', number: 2, name: 'ARRI L7-C', typeId: ARRI, address: 13, group: 'ARRI L7-C', position: at(320, 456), shape: spot },
    { id: 'arri3', number: 3, name: 'ARRI L7-C', typeId: ARRI, address: 25, group: 'ARRI L7-C', position: at(500, 235), shape: spot },
    { id: 'diva1', number: 4, name: 'Diva-Lite 31', typeId: DIVA, address: 37, group: 'Diva-Lite 31', position: at(780, 320), shape: panelV },
    { id: 'diva2', number: 5, name: 'Diva-Lite 31', typeId: DIVA, address: 45, group: 'Diva-Lite 31', position: at(220, 320), shape: panelV },
    { id: 'diva3', number: 6, name: 'Diva-Lite 31', typeId: DIVA, address: 53, group: 'Diva-Lite 31', position: at(700, 150), shape: panelH },
    { id: 'diva4', number: 7, name: 'Diva-Lite 31', typeId: DIVA, address: 61, group: 'Diva-Lite 31', position: at(300, 150), shape: panelH },
  ],
};

/**
 * 床置きの白 4 灯（STAGE EVOLUTION PAR100CW、1ch モード＝明るさだけ、DMX 101〜104）。
 * 天井図の四隅に置く（縦は天井の上の段・下の段にそろえ、横は外側に 1 列ずつ）。Admin で「床置き 4 灯」を入れたときだけ足す。
 */
const FLOOR = 'dimmer-1ch';
export const floorPars: Patch['lights'] = [
  { id: 'floor1', number: 8, name: 'Floor PAR', typeId: FLOOR, address: 101, group: 'Floor PAR', position: { x: 0.04, y: at(0, 150).y }, shape: spot },
  { id: 'floor2', number: 9, name: 'Floor PAR', typeId: FLOOR, address: 102, group: 'Floor PAR', position: { x: 0.96, y: at(0, 150).y }, shape: spot },
  { id: 'floor3', number: 10, name: 'Floor PAR', typeId: FLOOR, address: 103, group: 'Floor PAR', position: { x: 0.04, y: at(0, 456).y }, shape: spot },
  { id: 'floor4', number: 11, name: 'Floor PAR', typeId: FLOOR, address: 104, group: 'Floor PAR', position: { x: 0.96, y: at(0, 456).y }, shape: spot },
];

/** 天井の 7 灯に床置きの 4 灯を足したパッチ */
export const tmuPhotoStudioWithFloor: Patch = { ...tmuPhotoStudio, name: 'TMU Photo Studio + Floor PAR', lights: [...tmuPhotoStudio.lights, ...floorPars] };

export const patches: Record<string, Patch> = { 'tmu-photo-studio': tmuPhotoStudio, 'tmu-photo-studio-floor': tmuPhotoStudioWithFloor };

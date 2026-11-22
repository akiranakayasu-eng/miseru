// ライトの種類（Fixture）の定義。チャンネルの並びを「役割」の配列で書く。
// 子どもに見せるのは「明るさ・色・白のあたたかさ」だけで、ここに書いた役割から DMX の値を計算する。

export type ChannelRole =
  | { kind: 'dimmer' }
  | { kind: 'red' }
  | { kind: 'green' }
  | { kind: 'blue' }
  | { kind: 'white' }
  /** 色温度。0 → minK、255 → maxK として直線で割り当てる。 */
  | { kind: 'cct'; minK: number; maxK: number }
  /** グリーン／マゼンタ補正。中立の値を送り続ける。 */
  | { kind: 'tint'; neutral: number }
  /** 白（CCT）→ 色（RGB）のクロスフェード。0 = 白、255 = 色。 */
  | { kind: 'xfade' }
  /** ファン、プリセット、ストロボなど、触らせない チャンネル。常に value を送る。 */
  | { kind: 'fixed'; value: number; label: string };

export interface FixtureType {
  id: string;
  name: string;
  maker?: string;
  mode?: string;
  channels: ChannelRole[];
  /** メーカー資料かスタジオ資料でチャンネル配置を確かめたか */
  verified: boolean;
  note?: string;
}

// ---- ひな形（どのメーカーでも並びが合えば使える） ----

export const templates: FixtureType[] = [
  { id: 'dimmer-1ch', name: 'Intensity only (1 ch)', channels: [{ kind: 'dimmer' }], verified: true },
  {
    id: 'rgb-3ch',
    name: 'RGB（3ch）',
    channels: [{ kind: 'red' }, { kind: 'green' }, { kind: 'blue' }],
    verified: true,
  },
  {
    id: 'rgbw-4ch',
    name: 'RGBW（4ch）',
    channels: [{ kind: 'red' }, { kind: 'green' }, { kind: 'blue' }, { kind: 'white' }],
    verified: true,
  },
  {
    id: 'dim-rgb-4ch',
    name: 'Intensity + RGB (4 ch)',
    channels: [{ kind: 'dimmer' }, { kind: 'red' }, { kind: 'green' }, { kind: 'blue' }],
    verified: true,
  },
  {
    id: 'dim-rgbw-5ch',
    name: 'Intensity + RGBW (5 ch)',
    channels: [{ kind: 'dimmer' }, { kind: 'red' }, { kind: 'green' }, { kind: 'blue' }, { kind: 'white' }],
    verified: true,
  },
];

// ---- 都立大 撮影スタジオの 2 機種 ----

/** スタジオ資料（QLC+ 用ページ、ファームウェア V4.x）の Mode 1 12ch 版。 */
export const arriL7cMode1: FixtureType = {
  id: 'arri-l7c-plus-mode1-12ch',
  name: 'ARRI L7-C Plus',
  maker: 'ARRI',
  mode: 'Mode 1: CCT & RGBW 8 bit（12ch）',
  channels: [
    { kind: 'dimmer' },
    { kind: 'cct', minK: 2800, maxK: 10000 },
    { kind: 'tint', neutral: 128 },
    { kind: 'xfade' },
    { kind: 'red' },
    { kind: 'green' },
    { kind: 'blue' },
    { kind: 'white' },
    { kind: 'fixed', value: 0, label: 'Fan' },
    { kind: 'fixed', value: 0, label: 'Preset' },
    { kind: 'fixed', value: 0, label: 'Strobe' },
    { kind: 'fixed', value: 0, label: 'Reserved' },
  ],
  verified: true,
  note: 'Only the CCT endpoints (2800 K / 10000 K) are documented; values in between are interpolated linearly.',
};

/**
 * Kino Flo Diva-Lite 31 LED DMX の P25「xfade CCT & RGB 8 bit」（8ch）。
 * チャンネルの並びはまだ資料で確かめていない仮の定義。実機で確認してから verified にする。
 */
export const divaLite31P25: FixtureType = {
  id: 'kinoflo-diva-lite-31-p25-8ch',
  name: 'Kino Flo Diva-Lite 31',
  maker: 'Kino Flo',
  mode: 'P25: xfade CCT & RGB 8 bit（8ch）',
  channels: [
    { kind: 'dimmer' },
    { kind: 'cct', minK: 2500, maxK: 9900 },
    { kind: 'tint', neutral: 128 },
    { kind: 'xfade' },
    { kind: 'red' },
    { kind: 'green' },
    { kind: 'blue' },
    { kind: 'fixed', value: 0, label: '予備' },
  ],
  verified: false,
  note: 'P25 のチャンネル表が手元にないため ARRI と同じ並びで仮置き。メーカーの DMX Personalities 資料で要確認。',
};

export const fixtureTypes: FixtureType[] = [...templates, arriL7cMode1, divaLite31P25];

export function findFixtureType(id: string): FixtureType | undefined {
  return fixtureTypes.find((t) => t.id === id);
}

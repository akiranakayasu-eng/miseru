import { existsSync, readFileSync } from 'node:fs';

export interface Config {
  /** 使うパッチの名前（src/engine/patches.ts） */
  patch: string;
  http: { host: string; port: number };
  /** host を空にすると Art-Net を送らない（画面だけで試すとき） */
  artnet: {
    host: string;
    universe?: number;
    broadcast?: boolean;
    /** 送信に使うこちら側の IP（ODE だけをつないだ LAN の口）。空なら OS に任せる */
    bindAddress?: string;
  };
  /** host を空にし universe を入れると sACN をマルチキャストで送る。host を入れればその IP へ直接送る */
  sacn: {
    enabled: boolean;
    /** 1 始まり */
    universe?: number;
    priority?: number;
    host?: string;
    bindAddress?: string;
  };
  /** Wi-Fi 側から Art-Net を受け取って切り替えられるようにする */
  input: { enabled: boolean; bindAddress?: string };
  /** 先生用の PIN。空なら先生用の操作（出どころの切り替え）は使えない */
  teacherPin: string;
  /** false にすると接続コードなしで操作できる（開発用） */
  requirePairing: boolean;
  dataDir: string;
}

export const defaultConfig: Config = {
  patch: 'tmu-photo-studio',
  http: { host: '0.0.0.0', port: 8080 },
  artnet: { host: '' },
  sacn: { enabled: false },
  input: { enabled: false },
  teacherPin: '',
  requirePairing: true,
  dataDir: 'data',
};

export function loadConfig(path = 'miseru.config.json'): Config {
  if (!existsSync(path)) return defaultConfig;
  const user = JSON.parse(readFileSync(path, 'utf8')) as Partial<Config>;
  return {
    ...defaultConfig,
    ...user,
    http: { ...defaultConfig.http, ...user.http },
    artnet: { ...defaultConfig.artnet, ...user.artnet },
    sacn: { ...defaultConfig.sacn, ...user.sacn },
    input: { ...defaultConfig.input, ...user.input },
  };
}

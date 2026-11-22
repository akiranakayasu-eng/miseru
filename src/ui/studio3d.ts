// miseru の 3D ビュー（WebGL1 だけ、外部ライブラリなし。箱の画面の大きさの上限に収めるため three.js は使わない）
// 部屋: 幅 w(x) 奥行き d(z、-z が背景側) 高さ h。床が y=0。
// 部屋の大きさ・照明の高さと向きは資料が無いので仮置き（2026-11-21）。
type V3 = number[];
export interface Light3D { idx: number; pos: V3; dir: V3; half: number; soft: number; panel: boolean; floor: boolean; reach: number; rgb: V3; k: number }
export interface LightIn { x: number; y: number; panel?: boolean; floor?: boolean; rgb: V3; k: number; set?: SceneLight }

// ---------- スタジオの設定（Solid 表示で決める。2026-11-22 Akira さんの依頼） ----------
/** 照明 1 灯の置き方。x, z は平面図の位置（m、中心が原点、-z が奥の壁）、h は高さ（m）。角度は度 */
export interface SceneLight { x: number; z: number; h: number; pan: number; tilt: number; beam: number; soft: number }
/** 人。pose: 立ち・座り・演奏・ダンス、kind: 大人・子ども、wear: 服（明るい・暗い・色）、inst: 楽器、dance: ダンスのポーズ（2026-11-22 Akira さん） */
export type Inst = 'guitar' | 'violin' | 'keys' | 'drums';
export type Dance = 'ballet' | 'arabesque' | 'contemporary' | 'floor' | 'hiphop';
export interface ScenePerson { x: number; z: number; pose: 'stand' | 'sit' | 'musician' | 'dancer'; kind: 'adult' | 'child'; wear: 'light' | 'dark' | 'color'; inst?: Inst; dance?: Dance }
export interface Scene { room: { w: number; d: number; h: number }; lights: Record<string, SceneLight>; people: ScenePerson[] }
export const defaultScene = (): Scene => ({ room: { w: 5.5, d: 7.5, h: 3 }, lights: {}, people: [{ x: 0, z: -0.35, pose: 'sit', kind: 'adult', wear: 'light' }] });
const SOFT0 = 0.67;
const deg = Math.PI / 180;
/** 向き（pan: 0 で奥の壁へ、右へ回すと +。tilt: 水平から下向きが +）から方向の単位ベクトル */
export const aimDir = (pan: number, tilt: number): V3 => [Math.sin(pan * deg) * Math.cos(tilt * deg), -Math.sin(tilt * deg), -Math.cos(pan * deg) * Math.cos(tilt * deg)];
/** 今の灯体から、設定の値を作る（初めて動かすときの出発点） */
export function sceneLightOf(l: Light3D): SceneLight {
  const r = (v: number, k = 100) => Math.round(v * k) / k;
  return { x: r(l.pos[0]), z: r(l.pos[2]), h: r(l.pos[1]), pan: Math.round(Math.atan2(l.dir[0], -l.dir[2]) / deg), tilt: Math.round(Math.asin(-l.dir[1]) / deg), beam: Math.round((l.half * 2) / deg), soft: r(l.soft) };
}
/** 向ける先: 人（番号）・床（真下）・壁（奥・手前・左・右の真ん中の高さ）。そこから pan と tilt を出す（2026-11-22 Akira さん: 向け先を選んでから細かく直す） */
export type AimAt = { person: number } | 'floor' | 'back' | 'front' | 'left' | 'right';
export function aimTo(l: SceneLight, at: AimAt, people: ScenePerson[]): SceneLight {
  let t: V3;
  if (at === 'floor') return { ...l, tilt: 90 };
  if (at === 'back') t = [l.x, ROOM.h / 2, ROOM.back];
  else if (at === 'front') t = [l.x, ROOM.h / 2, ROOM.back + ROOM.d];
  else if (at === 'left') t = [-ROOM.w / 2, ROOM.h / 2, l.z];
  else if (at === 'right') t = [ROOM.w / 2, ROOM.h / 2, l.z];
  else {
    const p = people[at.person]; if (!p) return l;
    const s = p.kind === 'child' ? 0.72 : 1;
    // 胸のあたり（座り・ドラム・床のポーズは低く）
    t = [p.x, (p.pose === 'sit' || (p.pose === 'musician' && p.inst === 'drums') || (p.pose === 'dancer' && p.dance === 'floor') ? 0.95 : 1.35) * s, p.z];
  }
  const d = [t[0] - l.x, t[1] - l.h, t[2] - l.z], L = Math.hypot(...d) || 1;
  const tilt = Math.asin(Math.max(-1, Math.min(1, -d[1] / L))) / deg;
  const pan = Math.abs(d[0]) + Math.abs(d[2]) < 1e-6 ? l.pan : Math.atan2(d[0], -d[2]) / deg;
  return { ...l, pan: Math.round(pan), tilt: Math.round(tilt) };
}
/** 部屋の大きさを変える（奥の壁の位置は奥行きに合わせて動かす） */
export function setRoom(w: number, d: number, h: number) {
  ROOM.w = w; ROOM.d = d; ROOM.h = h; ROOM.back = -0.4533 * d;
}
// カメラの決まった向き（2026-11-22 Akira さん: 既定は斜めの Home、上・前・右・左・後ろのボタン）
// 前 = 手前（奥の壁を見る向き）、右 = 手前から見て右（+x）。部屋全体が枠に入る距離にする
export type CamView = 'home' | 'top' | 'front' | 'right' | 'left' | 'back';
export function camFor(view: CamView, fov: number, asp: number) {
  const { w, d, h, back } = ROOM, zc = back + d / 2, t = Math.tan(fov / 2);
  const fit = (W: number, H: number) => 1.08 * Math.max(H / 2 / t, W / 2 / (t * asp));
  const side = (yaw: number, W: number, depth: number) => ({ yaw, pitch: 0.06, dist: depth * 0.2 + fit(W, h) * 0.95, tgt: [0, h * 0.45, zc] });
  switch (view) {
    case 'top': return { yaw: 0, pitch: 1.5, dist: h + fit(w, d) * 0.9, tgt: [0, 0, zc] };
    case 'front': return side(0, w, d);
    case 'back': return side(Math.PI, w, d);
    case 'right': return side(Math.PI / 2, d, w);
    case 'left': return side(-Math.PI / 2, d, w);
    default: return { yaw: 0.6, pitch: 0.42, dist: fit(Math.max(w, d), Math.max(w, d)) * 0.72, tgt: [0, 0.9, zc] };
  }
}
interface Buf { p: WebGLBuffer; n: WebGLBuffer; m: WebGLBuffer; count: number }
// 部屋は奥に長い（2026-11-21 Akira さんの指示）。奥の壁は z=back、手前へ d
export const ROOM = { w: 5.5, d: 7.5, h: 3.0, back: -3.4 };
// 天井図の枠（照明が吊ってある範囲）の 3D での大きさ。中心が原点
const RIG = { w: 5.0, d: 3.5 };
const MAXL = 12;

// ---------- 行列 ----------
function persp(fovy: number, asp: number, n: number, f: number): number[] {
  const t = 1 / Math.tan(fovy / 2), nf = 1 / (n - f);
  return [t / asp, 0, 0, 0, 0, t, 0, 0, 0, 0, (f + n) * nf, -1, 0, 0, 2 * f * n * nf, 0];
}
function lookAt(e: V3, c: V3, u: V3): number[] {
  let zx = e[0] - c[0], zy = e[1] - c[1], zz = e[2] - c[2];
  let l = Math.hypot(zx, zy, zz); zx /= l; zy /= l; zz /= l;
  let xx = u[1] * zz - u[2] * zy, xy = u[2] * zx - u[0] * zz, xz = u[0] * zy - u[1] * zx;
  l = Math.hypot(xx, xy, xz); xx /= l; xy /= l; xz /= l;
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
  return [xx, yx, zx, 0, xy, yy, zy, 0, xz, yz, zz, 0,
    -(xx * e[0] + xy * e[1] + xz * e[2]), -(yx * e[0] + yy * e[1] + yz * e[2]), -(zx * e[0] + zy * e[1] + zz * e[2]), 1];
}
function mul(a: number[], b: number[]): number[] {
  const o: number[] = new Array(16);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
    let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + j] * b[i * 4 + k]; o[i * 4 + j] = s;
  }
  return o;
}

// ---------- 形（位置・法線・素材 0=部屋 1=背景紙 2=人 3=灯体の発光面 4=灯体の筐体） ----------
class Mesh {
  p: number[] = []; n: number[] = []; m: number[] = [];
  tri(a: V3, b: V3, c: V3, na: V3, nb: V3, nc: V3, m: number) {
    this.p.push(...a, ...b, ...c); this.n.push(...na, ...nb, ...nc); this.m.push(m, m, m);
  }
  quad(a: V3, b: V3, c: V3, d: V3, n: V3, m: number) { this.tri(a, b, c, n, n, n, m); this.tri(a, c, d, n, n, n, m); }
}
// 細かく割った面（光の当たり方を頂点ではなく画素で計算するので、割るのは見た目の折れ線のためだけ）
function addRoom(M: Mesh) {
  const { w, d, h, back } = ROOM, x0 = -w / 2, x1 = w / 2, zb = back, zf = back + d;
  M.quad([x0, 0, zf], [x1, 0, zf], [x1, 0, zb], [x0, 0, zb], [0, 1, 0], 0); // 床
  M.quad([x0, h, zb], [x1, h, zb], [x1, h, zf], [x0, h, zf], [0, -1, 0], 0); // 天井
  M.quad([x0, 0, zb], [x1, 0, zb], [x1, h, zb], [x0, h, zb], [0, 0, 1], 0); // 奥の壁
  M.quad([x0, 0, zf], [x0, 0, zb], [x0, h, zb], [x0, h, zf], [1, 0, 0], 0); // 左
  M.quad([x1, 0, zb], [x1, 0, zf], [x1, h, zf], [x1, h, zb], [-1, 0, 0], 0); // 右
  // 背景紙は置かない（2026-11-21 Akira さんの指示）。部屋は黒系
}
function addEllipsoid(M: Mesh, c: V3, r: V3, m: number, seg = 16, ring = 10) {
  const P = (i: number, j: number): V3 => { const t = (i / ring) * Math.PI, f = (j / seg) * Math.PI * 2; return [Math.sin(t) * Math.cos(f), Math.cos(t), Math.sin(t) * Math.sin(f)]; };
  for (let i = 0; i < ring; i++) for (let j = 0; j < seg; j++) {
    const u = [P(i, j), P(i + 1, j), P(i + 1, j + 1), P(i, j + 1)];
    const v = u.map((q) => [c[0] + q[0] * r[0], c[1] + q[1] * r[1], c[2] + q[2] * r[2]]);
    const nn = u.map((q) => { const n = [q[0] / r[0], q[1] / r[1], q[2] / r[2]]; const l = Math.hypot(...n); return n.map((x) => x / l); });
    M.tri(v[0], v[2], v[1], nn[0], nn[2], nn[1], m); M.tri(v[0], v[3], v[2], nn[0], nn[3], nn[2], m);
  }
}
// 2 点の間の円柱（両端を丸める）
// 2 点の間の、太さが変わる円柱（両端を丸める）。rb を省くと同じ太さ
// flat: 端を丸めず平らにふさぐ（太鼓など）
function addLimb(M: Mesh, a: V3, b: V3, r: number, m: number, rb = r, flat = false) {
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], L = Math.hypot(...d), z = d.map((x) => x / L);
  const t = Math.abs(z[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  let x = [t[1] * z[2] - t[2] * z[1], t[2] * z[0] - t[0] * z[2], t[0] * z[1] - t[1] * z[0]]; const xl = Math.hypot(...x); x = x.map((v) => v / xl);
  const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
  const S = 16;
  for (let j = 0; j < S; j++) {
    const f0 = (j / S) * Math.PI * 2, f1 = ((j + 1) / S) * Math.PI * 2;
    const n0 = x.map((v, k) => v * Math.cos(f0) + y[k] * Math.sin(f0)), n1 = x.map((v, k) => v * Math.cos(f1) + y[k] * Math.sin(f1));
    const A = a.map((v, k) => v + n0[k] * r), B = a.map((v, k) => v + n1[k] * r), C = b.map((v, k) => v + n1[k] * rb), D = b.map((v, k) => v + n0[k] * rb);
    M.tri(A, C, B, n0, n1, n1, m);
    M.tri(A, D, C, n0, n0, n1, m);
    if (flat) {
      const mz = z.map((v) => -v);
      M.tri(a, B, A, mz, mz, mz, m);
      M.tri(b, D, C, z, z, z, m);
    }
  }
  if (!flat) {
    addEllipsoid(M, a, [r, r, r], m, 12, 8);
    addEllipsoid(M, b, [rb, rb, rb], m, 12, 8);
  }
}
type PF = (x: number, y: number, z: number) => V3;
// 胴: 高さごとの楕円の輪をつないで、腰から肩までなめらかに（玉を重ねると節に見えた）
function torso(M: Mesh, P: PF, cl: number) {
  const T: [number, number, number, number][] = [
    // [高さ, 横の半径, 前後の半径, 前後の中心]
    [0.44, 0.13, 0.1, -0.06], [0.5, 0.165, 0.12, -0.065], [0.58, 0.165, 0.115, -0.07], [0.68, 0.145, 0.1, -0.08],
    [0.78, 0.155, 0.1, -0.085], [0.87, 0.18, 0.11, -0.09], [0.94, 0.2, 0.105, -0.09], [0.99, 0.17, 0.085, -0.09], [1.02, 0.07, 0.055, -0.085],
  ];
  const RS = 24;
  for (let i = 0; i + 1 < T.length; i++) {
    const ring = (r: number[], f: number): [V3, V3] => {
      const c = Math.cos(f), sn = Math.sin(f);
      const n = [c / r[1], 0, sn / r[2]], nl = Math.hypot(...n);
      return [P(c * r[1], r[0], r[3] + sn * r[2]), n.map((v) => v / nl)];
    };
    for (let j = 0; j < RS; j++) {
      const f0 = (j / RS) * Math.PI * 2, f1 = ((j + 1) / RS) * Math.PI * 2;
      const [a0, na0] = ring(T[i], f0), [a1, na1] = ring(T[i], f1), [b0, nb0] = ring(T[i + 1], f0), [b1, nb1] = ring(T[i + 1], f1);
      M.tri(a0, b1, a1, na0, nb1, na1, cl); M.tri(a0, b0, b1, na0, nb0, nb1, cl);
    }
  }
}
function head(E: (c: V3, r: V3, m: number, a?: number, b?: number) => void, Lb: (a: V3, b: V3, r: number, m: number, rb?: number) => void, P: PF) {
  // 首と頭（あごを少し前に）
  Lb(P(0, 0.99, -0.085), P(0, 1.1, -0.07), 0.048, 6, 0.042);
  E(P(0, 1.19, -0.065), [0.082, 0.11, 0.098], 6, 24, 16);
  E(P(0, 1.225, -0.085), [0.088, 0.095, 0.098], 7, 24, 16); // 髪（後ろと上だけ見える）
}
// 人（こちら向き）。座り（椅子つき、2026-11-21）と立ち、大人と子ども（0.72 倍）、服の 3 種（2026-11-22 Akira さんの依頼）。
// 服 2（明るい）・9（暗い）・10（色）・肌 6・椅子と髪と靴 7
export const SUBJECT = [0, 0, -0.35];
// 演奏の腕。[0, 左ひじ, 左手, 右ひじ, 右手]（左は -x、人はこちら向き）
const ARMS: Record<Inst, number[]> = {
  guitar: [0, -0.3, 1.15, 0, -0.38, 1.3, 0.12, 0.25, 1.2, 0, 0.08, 1.12, 0.2],
  violin: [0, -0.3, 1.25, 0.25, -0.16, 1.44, 0.42, 0.35, 1.2, 0.05, 0.18, 1.41, 0.22],
  keys: [0, -0.22, 1.12, 0.08, -0.2, 1.0, 0.4, 0.22, 1.12, 0.08, 0.2, 1.0, 0.4],
  drums: [0, -0.28, 0.75, 0.05, -0.25, 0.78, 0.3, 0.28, 0.75, 0.05, 0.2, 0.8, 0.35],
};
// ダンスのポーズ 5 種（2026-11-22 Akira さん: コンテンポラリー・バレエ・ヒップホップなど）。
// [体の高さのずれ, 左ひじ, 左手, 右ひじ, 右手, 左ひざ, 左足, 右ひざ, 右足]
const DANCE: Record<Dance, number[]> = {
  // バレエ: つま先立ちで両腕を頭の上に丸く
  ballet: [0.52, -0.28, 1.7, -0.05, -0.08, 1.92, -0.02, 0.28, 1.7, -0.05, 0.08, 1.92, -0.02, -0.08, 0.56, -0.06, -0.06, 0.14, -0.04, 0.08, 0.56, -0.06, 0.06, 0.14, -0.04],
  // アラベスク: 左脚で立ち、右脚を後ろへ高く、左腕は前、右腕は横
  arabesque: [0.48, -0.2, 1.55, 0.15, -0.22, 1.7, 0.42, 0.42, 1.45, -0.1, 0.68, 1.48, -0.12, -0.09, 0.5, -0.06, -0.09, 0.08, -0.06, 0.12, 0.85, -0.45, 0.14, 1.0, -0.85],
  // コンテンポラリー: 大きく踏み出して、両腕を斜めに伸ばす
  contemporary: [0.3, -0.42, 1.4, -0.05, -0.68, 1.6, -0.05, 0.4, 1.05, -0.05, 0.62, 0.85, -0.05, -0.15, 0.45, 0.35, -0.15, 0.05, 0.4, 0.12, 0.35, -0.45, 0.14, 0.08, -0.85],
  // 床: 片ひざをつき、両腕を上へ
  floor: [-0.05, -0.2, 1.12, 0.05, -0.25, 1.38, 0.12, 0.25, 1.1, 0, 0.35, 1.35, -0.05, -0.12, 0.45, 0.3, -0.12, 0.05, 0.35, 0.12, 0.06, 0.1, 0.13, 0.06, -0.32],
  // ヒップホップ: 脚を広げてひざを曲げ、片腕を胸の前、片腕を斜め上へ
  hiphop: [0.38, -0.32, 1.12, 0.12, 0, 1.2, 0.22, 0.4, 1.42, 0.05, 0.62, 1.6, 0.12, -0.3, 0.45, 0.05, -0.35, 0.06, 0, 0.3, 0.45, 0.05, 0.35, 0.06, 0],
};
function addPerson(M: Mesh, ps: ScenePerson) {
  const s = ps.kind === 'child' ? 0.72 : 1, cl = ps.wear === 'dark' ? 9 : ps.wear === 'color' ? 10 : 2;
  const P = (x: number, y: number, z: number): V3 => [ps.x + x * s, y * s, ps.z + z * s];
  const E = (c: V3, r: V3, m: number, a?: number, b?: number) => addEllipsoid(M, c, r.map((v) => v * s), m, a, b);
  const Lb = (a: V3, b: V3, r: number, m: number, rb = r) => addLimb(M, a, b, r * s, m, rb * s);
  const Cy = (a: V3, b: V3, r: number, m: number) => addLimb(M, a, b, r * s, m, r * s, true);
  const box = (c: V3, h: V3, m = 7) => {
    const C = (sx: number, sy: number, sz: number): V3 => [c[0] + sx * h[0] * s, c[1] + sy * h[1] * s, c[2] + sz * h[2] * s];
    M.quad(C(-1, 1, -1), C(-1, 1, 1), C(1, 1, 1), C(1, 1, -1), [0, 1, 0], m);
    M.quad(C(-1, -1, 1), C(-1, -1, -1), C(1, -1, -1), C(1, -1, 1), [0, -1, 0], m);
    M.quad(C(-1, -1, 1), C(1, -1, 1), C(1, 1, 1), C(-1, 1, 1), [0, 0, 1], m);
    M.quad(C(1, -1, -1), C(-1, -1, -1), C(-1, 1, -1), C(1, 1, -1), [0, 0, -1], m);
    M.quad(C(1, -1, 1), C(1, -1, -1), C(1, 1, -1), C(1, 1, 1), [1, 0, 0], m);
    M.quad(C(-1, -1, -1), C(-1, -1, 1), C(-1, 1, 1), C(-1, 1, -1), [-1, 0, 0], m);
  };
  // 楽器（2026-11-22 Akira さんの依頼）。人はこちら（+z）向き。ドラムは座って、ほかは立って弾く
  const inst = ps.pose === 'musician' ? ps.inst ?? 'guitar' : undefined;
  const sit = ps.pose === 'sit' || inst === 'drums';
  if (inst === 'guitar') {
    E(P(0.04, 1.12, 0.13), [0.17, 0.13, 0.05], 7);
    Lb(P(0.1, 1.16, 0.13), P(-0.45, 1.36, 0.11), 0.022, 7);
  } else if (inst === 'violin') {
    E(P(-0.09, 1.48, 0.13), [0.08, 0.03, 0.15], 7);
    Lb(P(-0.11, 1.48, 0.27), P(-0.15, 1.46, 0.45), 0.012, 7);
    Lb(P(0.18, 1.41, 0.22), P(-0.32, 1.54, 0.16), 0.005, 2);
  } else if (inst === 'keys') {
    box(P(0, 0.95, 0.48), [0.5, 0.035, 0.15]);
    box(P(0, 0.987, 0.55), [0.47, 0.004, 0.07], 2);
    for (const sx of [-1, 1]) Lb(P(sx * 0.35, 0.95, 0.48), P(sx * 0.4, 0, 0.48), 0.015, 4);
  } else if (inst === 'drums') {
    Cy(P(0, 0.28, 0.4), P(0, 0.28, 0.75), 0.26, 4);
    Cy(P(-0.3, 0.58, 0.28), P(-0.3, 0.7, 0.28), 0.17, 4);
    Cy(P(0.12, 0.72, 0.55), P(0.12, 0.88, 0.5), 0.13, 4);
    Cy(P(0.42, 0.25, 0.25), P(0.42, 0.6, 0.25), 0.18, 4);
    Cy(P(-0.55, 1.08, 0.45), P(-0.55, 1.095, 0.45), 0.22, 3);
    Lb(P(-0.55, 1.08, 0.45), P(-0.55, 0, 0.45), 0.01, 4);
  }
  // 腕と脚の形（表 ARMS・DANCE）。無ければ立ちは腕を下ろし、座りは手をももの上に
  const pose = ps.pose === 'dancer' ? DANCE[ps.dance ?? 'ballet'] : inst ? ARMS[inst] : undefined;
  const legs = !!pose && pose.length > 13;
  const up = sit ? 0 : legs ? pose![0] : 0.48;
  const Q = (i: number) => P(pose![i], pose![i + 1], pose![i + 2]);
  torso(M, (x, y, z) => P(x, y + up, z), cl);
  E(P(0, 0.44 + up, -0.06), [sit ? 0.13 : 0.14, sit ? 0.03 : 0.06, 0.1], cl);
  head(E, Lb, (x, y, z) => P(x, y + up, z));
  for (const [k, sx] of [[0, -1], [1, 1]]) {
    const el = pose ? Q(1 + k * 6) : sit ? P(sx * 0.215, 0.72, -0.04) : P(sx * 0.2, 1.13, -0.08);
    const ha = pose ? Q(4 + k * 6) : sit ? P(sx * 0.15, 0.62, 0.2) : P(sx * 0.21, 0.87, -0.05);
    Lb(P(sx * 0.155, 0.93 + up, -0.09), el, 0.046, cl, 0.04);
    Lb(el, ha, 0.04, 6, 0.028);
    E(ha, [0.03, 0.04, 0.03], 6);
    const hip = sit ? P(sx * 0.09, 0.52, -0.04) : P(sx * 0.09, 0.44 + up, -0.07);
    const kn = legs ? Q(13 + k * 6) : sit ? P(sx * 0.11, 0.52, 0.34) : P(sx * 0.1, 0.5, -0.06);
    const ft = legs ? Q(16 + k * 6) : sit ? P(sx * 0.115, 0.08, 0.37) : P(sx * 0.1, 0.08, -0.08);
    Lb(hip, kn, 0.078, cl, 0.055);
    Lb(kn, ft, 0.052, cl, 0.036);
    E([ft[0], ft[1] - 0.04 * s, ft[2] + 0.05 * s], [0.045, 0.035, 0.1], 7);
  }
  if (!sit) return;
  // 椅子（座面の高さ 0.45m、背もたれ付き）
  box(P(0, 0.43, -0.02), [0.22, 0.025, 0.21]);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) box(P(sx * 0.19, 0.205, -0.02 + sz * 0.18), [0.018, 0.205, 0.018]);
  for (const sx of [-1, 1]) box(P(sx * 0.19, 0.68, -0.21), [0.018, 0.23, 0.018]);
  box(P(0, 0.8, -0.21), [0.2, 0.09, 0.015]);
}
// 灯体: 向き dir を前にした箱（前面だけ光る）
// LED の粒（前の面の上の小さな円。天井図の見本と同じ並び、わざと大きめ。2026-11-21 Akira さんの指示）
function addDots(M: Mesh, l: Light3D, x: V3, y: V3, d: number, pts: [number, number][], r: number) {
  const z = l.dir, S = 8, m = 3 + 0.01 * l.idx;
  for (const [u, v] of pts) {
    const c = l.pos.map((q, k) => q + x[k] * u + y[k] * v + z[k] * d);
    for (let j = 0; j < S; j++) {
      const f0 = (j / S) * Math.PI * 2, f1 = ((j + 1) / S) * Math.PI * 2;
      const P = (f: number) => c.map((q, k) => q + (x[k] * Math.cos(f) + y[k] * Math.sin(f)) * r);
      M.tri(c, P(f0), P(f1), z, z, z, m);
    }
  }
}
function addFixture(M: Mesh, l: Light3D) {
  const z = l.dir, t = Math.abs(z[1]) < 0.95 ? [0, 1, 0] : [1, 0, 0];
  let x = [t[1] * z[2] - t[2] * z[1], t[2] * z[0] - t[0] * z[2], t[0] * z[1] - t[1] * z[0]]; const xl = Math.hypot(...x); x = x.map((v) => v / xl);
  const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
  // 床置きは細長い筒（2026-11-21 Akira さんの指示）
  const [hw, hh, hd] = l.panel ? [0.3, 0.14, 0.05] : l.floor ? [0.09, 0.09, 0.16] : [0.15, 0.15, 0.12];
  // 丸い灯体（ARRI L7-C・床置き PAR）は円筒で、前の丸い面が光る（2026-11-21 Akira さんの指示）
  if (!l.panel) {
    const S = 28, R = hw, Rl = R * 0.86;
    const P = (r: number, f: number, d: number) => l.pos.map((v, k) => v + (x[k] * Math.cos(f) + y[k] * Math.sin(f)) * r + z[k] * d);
    const N = (f: number) => x.map((v, k) => v * Math.cos(f) + y[k] * Math.sin(f));
    const back = z.map((q) => -q);
    for (let j = 0; j < S; j++) {
      const f0 = (j / S) * Math.PI * 2, f1 = ((j + 1) / S) * Math.PI * 2;
      M.tri(P(R, f0, -hd), P(R, f1, -hd), P(R, f1, hd), N(f0), N(f1), N(f1), 4); // 胴
      M.tri(P(R, f0, -hd), P(R, f1, hd), P(R, f0, hd), N(f0), N(f1), N(f0), 4);
      M.tri(l.pos.map((v, k) => v - z[k] * hd), P(R, f1, -hd), P(R, f0, -hd), back, back, back, 4); // 後ろのふた
      M.tri(P(Rl, f0, hd), P(R, f0, hd), P(R, f1, hd), z, z, z, 4); // 前の縁
      M.tri(P(Rl, f0, hd), P(R, f1, hd), P(Rl, f1, hd), z, z, z, 4);
      M.tri(l.pos.map((v, k) => v + z[k] * (hd + 0.002)), P(Rl, f0, hd + 0.002), P(Rl, f1, hd + 0.002), z, z, z, 8 + 0.01 * l.idx); // 前の面（暗く光る）
    }
    const pts: [number, number][] = [[0, 0]];
    // 粒の細かさは中くらい（2026-11-21 Akira さん: 19 個は粗く、91 個は細かすぎた）: 同心円 1・6・12・18 の 37 個
    for (let ring = 1; ring <= 3; ring++) { const rr = ring * Rl * 0.27, n = ring * 6; for (let i = 0; i < n; i++) { const f = (i / n) * Math.PI * 2 - Math.PI / 2; pts.push([rr * Math.cos(f), rr * Math.sin(f)]); } }
    addDots(M, l, x, y, hd + 0.005, pts, Rl * 0.105);
    if (l.pos[1] > 1.5) addLimb(M, [l.pos[0], ROOM.h, l.pos[2]], [l.pos[0], l.pos[1] + R * 0.9, l.pos[2]], 0.015, 4);
    return;
  }
  const C = (sx: number, sy: number, sz: number) => l.pos.map((v, k) => v + x[k] * sx * hw + y[k] * sy * hh + z[k] * sz * hd);
  const neg = (v: V3) => v.map((q) => -q);
  M.quad(C(-1, -1, 1), C(1, -1, 1), C(1, 1, 1), C(-1, 1, 1), z, 8 + 0.01 * l.idx); // 前面（暗く光る）
  const grid: [number, number][] = [];
  for (let r = 0; r < 6; r++) for (let c = 0; c < 14; c++) grid.push([(c - 6.5) * 0.04, (r - 2.5) * 0.042]);
  addDots(M, l, x, y, hd + 0.004, grid, 0.013);
  M.quad(C(1, -1, -1), C(-1, -1, -1), C(-1, 1, -1), C(1, 1, -1), neg(z), 4);
  M.quad(C(-1, 1, -1), C(-1, 1, 1), C(1, 1, 1), C(1, 1, -1), y, 4);
  M.quad(C(1, -1, -1), C(1, -1, 1), C(-1, -1, 1), C(-1, -1, -1), neg(y), 4);
  M.quad(C(1, -1, 1), C(1, -1, -1), C(1, 1, -1), C(1, 1, 1), x, 4);
  M.quad(C(-1, -1, -1), C(-1, -1, 1), C(-1, 1, 1), C(-1, 1, -1), neg(x), 4);
  // 吊り棒（天井付き）
  if (l.pos[1] > 1.5) addLimb(M, [l.pos[0], ROOM.h, l.pos[2]], [l.pos[0], l.pos[1] + hh, l.pos[2]], 0.015, 4);
}
// 光の筋（円すい、加算で薄く）
function addBeam(B: Mesh, l: Light3D) {
  const z = l.dir, t = Math.abs(z[1]) < 0.95 ? [0, 1, 0] : [1, 0, 0];
  let x = [t[1] * z[2] - t[2] * z[1], t[2] * z[0] - t[0] * z[2], t[0] * z[1] - t[1] * z[0]]; const xl = Math.hypot(...x); x = x.map((v) => v / xl);
  const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
  const len = l.reach, r1 = Math.tan(l.half) * len, r0 = l.panel ? 0.2 : 0.1, S = 20;
  for (let j = 0; j < S; j++) {
    const f0 = (j / S) * Math.PI * 2, f1 = ((j + 1) / S) * Math.PI * 2;
    const ring = (f: number, r: number, d: number) => l.pos.map((v, k) => v + (x[k] * Math.cos(f) + y[k] * Math.sin(f)) * r + z[k] * d);
    const A = ring(f0, r0, 0.05), Bp = ring(f1, r0, 0.05), C = ring(f1, r1, len), D = ring(f0, r1, len);
    // 法線の代わりに「軸からの距離 0..1」と灯体番号を入れる
    B.tri(A, Bp, C, [0, l.idx, 0], [0, l.idx, 0], [1, l.idx, 0], 5); B.tri(A, C, D, [0, l.idx, 0], [1, l.idx, 0], [1, l.idx, 0], 5);
  }
}

const VS = `attribute vec3 p;attribute vec3 n;attribute float m;uniform mat4 vp;varying vec3 vP;varying vec3 vN;varying float vM;
void main(){vP=p;vN=n;vM=m;gl_Position=vp*vec4(p,1.);}`;
const FS = `precision highp float;varying vec3 vP;varying vec3 vN;varying float vM;
uniform vec3 lp[${MAXL}];uniform vec3 ld[${MAXL}];uniform vec3 lc[${MAXL}];uniform vec2 lk[${MAXL}];uniform int nl;uniform vec3 eye;uniform float amb;uniform float solid;
void main(){
 vec3 N0=normalize(vN);
 if(solid>.5){float sh=.35+.65*abs(dot(N0,normalize(eye-vP)));vec3 a;
  int i=int(floor((vM-(vM>7.995?8.:3.))*100.+.5));
  if((vM>=7.995&&vM<8.5)||(vM>=2.995&&vM<3.5)){a=vec3(.25);for(int k=0;k<${MAXL};k++){if(k==i)a=.25+lc[k]*.35;}gl_FragColor=vec4(a,1.);return;}
  a=vM<.5?vec3(.3,.3,.32):vM<2.5?vec3(.8,.8,.82):vM<4.5?vec3(.2,.2,.22):vM<5.5?vec3(.5):vM<6.5?vec3(.85,.72,.62):vM<7.5?vec3(.3,.27,.25):vM<9.5?vec3(.24,.24,.27):vec3(.25,.45,.8);
  gl_FragColor=vec4(a*sh,1.);return;}
 if(vM>=7.995&&vM<8.5){int i=int(floor((vM-8.)*100.+.5));vec3 c=vec3(.03);
  for(int k=0;k<${MAXL};k++){if(k==i)c+=lc[k]*.12;}
  gl_FragColor=vec4(pow(c/(1.+c),vec3(1./2.2)),1.);return;}
 if(vM>=2.995&&vM<3.5){int i=int(floor((vM-3.)*100.+.5));vec3 c=vec3(.06);
  for(int k=0;k<${MAXL};k++){if(k==i)c+=lc[k]*1.6;}
  gl_FragColor=vec4(c/(1.+c*.25),1.);return;}
 vec3 alb=vM<.5?vec3(.07,.07,.074):vM<1.5?vec3(.12,.12,.125):vM<2.5?vec3(.6,.6,.62):vM>9.5?vec3(.12,.26,.55):vM>8.5?vec3(.08,.08,.1):vM>6.5?vec3(.22,.19,.17):vM>5.5?vec3(.8,.66,.57):vec3(.08,.08,.09);
 vec3 N=normalize(vN);vec3 V=normalize(eye-vP);
 if(dot(N,V)<0.&&vM>1.5&&(vM<2.995||vM>4.5))N=-N;
 vec3 c=alb*amb*(.6+.4*N.y);
 for(int k=0;k<${MAXL};k++){if(k>=nl)break;
  vec3 L=lp[k]-vP;float d=length(L);L/=d;
  float cs=dot(-L,ld[k]);float sp=smoothstep(lk[k].x,lk[k].y,cs);
  float df=max(dot(N,L),0.);
  float at=1./(1.+.12*d*d);
  vec3 H=normalize(L+V);float s=pow(max(dot(N,H),0.),24.)*(vM>5.5&&vM<6.5?.3:vM>1.5&&vM<2.5?.12:.05);
  c+=lc[k]*sp*at*(alb*df+s*df);}
 c=c/(1.+c*.6);c=pow(c,vec3(1./2.2));
 gl_FragColor=vec4(c,1.);}`;
// 光の筋: ふち（視線に対して横向きの所）ほど薄くして、線に見えないようぼかす（2026-11-21 Akira さんの指示）
const BFS = `precision highp float;varying vec3 vP;varying vec3 vN;varying float vM;uniform vec3 lc[${MAXL}];uniform vec3 lp[${MAXL}];uniform vec3 ld[${MAXL}];uniform vec3 eye;uniform float beam;
void main(){int i=int(vN.y+.5);vec3 c=vec3(0.);vec3 p0=vec3(0.);vec3 d=vec3(0.,-1.,0.);
 for(int k=0;k<${MAXL};k++){if(k==i){c=lc[k];p0=lp[k];d=ld[k];}}
 vec3 q=vP-p0;vec3 r=q-d*dot(q,d);float rl=length(r);vec3 n=rl>1e-4?r/rl:vec3(0.,1.,0.);
 float f=abs(dot(n,normalize(eye-vP)));
 float a=(1.-vN.x)*beam*smoothstep(.0,.75,f);gl_FragColor=vec4(c*a,1.);}`;

function prog(gl: WebGLRenderingContext, vs: string, fs: string) {
  const sh = (t: number, s: string) => { const o = gl.createShader(t)!; gl.shaderSource(o, s); gl.compileShader(o); if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(o) ?? 'shader'); return o; };
  const p = gl.createProgram()!; gl.attachShader(p, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'program');
  return p;
}
function upload(gl: WebGLRenderingContext, M: Mesh): Buf {
  const mk = (a: number[]) => { const b = gl.createBuffer()!; gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(a), gl.STATIC_DRAW); return b; };
  return { p: mk(M.p), n: mk(M.n), m: mk(M.m), count: M.m.length };
}

/**
 * 天井図の位置（x, y: 0..1、y=0 が背景側）から 3D の灯体を作る。
 * 高さと向きは資料がないので仮置き: 天井付きは高さ 2.6m で被写体の胸へ、床置きは床から背景紙へ。
 */
export function placeLights(lights: LightIn[]): Light3D[] {
  return lights.map((l, idx) => {
    const st = l.set;
    if (st) {
      // 設定で決めた置き方（Solid 表示で動かしたもの）
      const pos: V3 = [st.x, st.h, st.z], dir = aimDir(st.pan, st.tilt);
      const reach = dir[1] < -0.05 ? Math.min(st.h / -dir[1], 6) : 4;
      return { idx, pos, dir, half: (st.beam / 2) * deg, soft: st.soft, panel: !!l.panel, floor: !!l.floor, reach, rgb: l.rgb, k: l.k };
    }
    const x = (l.x - 0.5) * RIG.w, z = -RIG.d / 2 + l.y * RIG.d;
    const floor = !!l.floor;
    // 床置きは前後の間を天井図の 2 倍に広げる（8 と 10、9 と 11。2026-11-21 Akira さんの指示）。真ん中は前後の段の中ほど
    const zc = -RIG.d / 2 + (283 / 556) * RIG.d;
    const pos: V3 = floor ? [x, 0.25, zc + (z - zc) * 2] : [x, 2.6, z];
    const tgt: V3 = floor ? [SUBJECT[0], 0.85, SUBJECT[2]] /* 腰より少し顔寄り（2026-11-21） */ : [SUBJECT[0], 0.95, SUBJECT[2]];
    let dir = tgt.map((v, k) => v - pos[k]); const dl = Math.hypot(...dir); dir = dir.map((v) => v / dl);
    // 床置きはスポットで、人の腰へ細く絞る（2026-11-21 Akira さんの指示）
    const half = l.panel ? 0.75 : floor ? 0.16 : 0.38; // 半角（ラジアン）。パネルは広く、丸は狭め
    return { idx, pos, dir, half, soft: SOFT0, panel: !!l.panel, floor, reach: Math.min(dl * 1.15, 3.6), rgb: l.rgb, k: l.k };
  });
}

export type View3D = NonNullable<ReturnType<typeof createView>>;
export function createView(canvas: HTMLCanvasElement) {
  const gl = canvas.getContext('webgl', { antialias: true, preserveDrawingBuffer: true });
  if (!gl) return null;
  const P = prog(gl, VS, FS), PB = prog(gl, VS, BFS);
  // 部屋と人（設定が変わったら作り直す）
  const still = (sc: Scene) => { setRoom(sc.room.w, sc.room.d, sc.room.h); const M = new Mesh(); addRoom(M); for (const ps of sc.people) addPerson(M, ps); return upload(gl, M); };
  let st = still(defaultScene()), stKey = '';
  let fx: Buf | null = null, bm: Buf | null = null, ls: Light3D[] = [], vpm: number[] | null = null;
  // 既定は斜めの Home（2026-11-22 Akira さん。前の既定は 11-21 のローアングル）。画面の縦横が分かったら camFor('home') に合わせる
  const cam = { yaw: 0.0, pitch: -0.06, dist: 5.2, tgt: [0, 0.95, -0.4], fov: 0.9 };
  const attrib = (pr: WebGLProgram, buf: Buf) => {
    for (const [name, b, sz] of [['p', buf.p, 3], ['n', buf.n, 3], ['m', buf.m, 1]] as [string, WebGLBuffer, number][]) {
      const loc = gl.getAttribLocation(pr, name); if (loc < 0) continue;
      gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, sz, gl.FLOAT, false, 0, 0);
    }
  };
  return {
    cam,
    setScene(sc: Scene) {
      const key = JSON.stringify([sc.room, sc.people]);
      if (key === stKey) return;
      stKey = key;
      for (const x of [st.p, st.n, st.m]) gl.deleteBuffer(x);
      st = still(sc);
      fx = null; // 吊り棒の長さが天井の高さで変わる
    },
    setLights(list: Light3D[]) {
      const same = !!fx && ls.length === list.length && ls.every((a, i) => a.pos.join() === list[i].pos.join() && a.dir.join() === list[i].dir.join() && a.half === list[i].half);
      ls = list;
      if (!same) {
        const F = new Mesh(), B = new Mesh();
        for (const l of list) { addFixture(F, l); addBeam(B, l); }
        fx = upload(gl, F); bm = upload(gl, B);
      }
    },
    /** 3D の点を canvas の画素へ（番号の札を重ねるため） */
    project(q: V3): [number, number] | null {
      const m = vpm; if (!m) return null;
      const x = m[0] * q[0] + m[4] * q[1] + m[8] * q[2] + m[12], y = m[1] * q[0] + m[5] * q[1] + m[9] * q[2] + m[13], w = m[3] * q[0] + m[7] * q[1] + m[11] * q[2] + m[15];
      if (w <= 0) return null;
      return [(x / w * 0.5 + 0.5) * canvas.width, (0.5 - y / w * 0.5) * canvas.height];
    },
    /** 画面の横・縦に dx, dy 画素ぶん、見ている点を動かす（Shift＋ドラッグ、ホイールを押してドラッグ） */
    pan(dx: number, dy: number) {
      const k = (cam.dist * 2 * Math.tan(cam.fov / 2)) / Math.max(1, canvas.clientHeight);
      const r = [Math.cos(cam.yaw), 0, -Math.sin(cam.yaw)];
      const sp = Math.sin(cam.pitch), cp = Math.cos(cam.pitch);
      const u = [-Math.sin(cam.yaw) * sp, cp, -Math.cos(cam.yaw) * sp];
      const t = cam.tgt.map((v, i) => v - r[i] * dx * k + u[i] * dy * k);
      cam.tgt = [Math.min(ROOM.w / 2, Math.max(-ROOM.w / 2, t[0])), Math.min(ROOM.h, Math.max(0, t[1])), Math.min(ROOM.back + ROOM.d, Math.max(ROOM.back, t[2]))];
    },
    lights: () => ls,
    // 片づけはバッファを消すだけ。loseContext すると、開発版の StrictMode で同じ canvas に作り直したとき
    // 失われた文脈が返ってきて描けなくなる（2026-11-21 Pro の 8096 で「not available」になった）
    dispose() {
      for (const b of [st, fx, bm]) if (b) for (const x of [b.p, b.n, b.m]) gl.deleteBuffer(x);
      fx = bm = null;
    },
    /** solid: 照明の効果を切って、形と置き場所だけを見る（Blender の Solid 表示のように。2026-11-22） */
    draw(opts: { amb?: number; beam?: number; solid?: boolean; exposure?: number } = {}) {
      const solid = !!opts.solid;
      const w = canvas.width, h = canvas.height; gl.viewport(0, 0, w, h);
      gl.clearColor(0.04, 0.04, 0.045, 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      // 床より下には行かない
      const ey = Math.max(0.08, cam.tgt[1] + cam.dist * Math.sin(cam.pitch));
      const eye = [cam.tgt[0] + cam.dist * Math.sin(cam.yaw) * Math.cos(cam.pitch), ey, cam.tgt[2] + cam.dist * Math.cos(cam.yaw) * Math.cos(cam.pitch)];
      const vp = mul(persp(cam.fov, w / h, 0.05, 40), lookAt(eye, cam.tgt, [0, 1, 0]));
      vpm = vp;
      const lp: number[] = [], ld: number[] = [], lc: number[] = [], lk: number[] = [];
      for (let i = 0; i < MAXL; i++) {
        const l = ls[i];
        lp.push(...(l ? l.pos : [0, 0, 0])); ld.push(...(l ? l.dir : [0, -1, 0]));
        // exposure: 画面としての明るさ（照明の効果だけを上げ下げ。2026-11-22）
        const k = l ? (solid ? 1 : l.k * (opts.exposure ?? 1)) * 1.7 : 0; lc.push(...(l ? l.rgb.map((c) => c * k) : [0, 0, 0]));
        lk.push(l ? Math.cos(l.half * (1 + 0.45 * l.soft)) : 1, l ? Math.cos(l.half * Math.max(0.02, 1 - 0.9 * l.soft)) : 1); // 光の輪のふち（soft が大きいほどぼける）
      }
      gl.enable(gl.DEPTH_TEST); gl.disable(gl.BLEND); gl.enable(gl.CULL_FACE); gl.cullFace(gl.BACK);
      gl.useProgram(P);
      const U = (n: string) => gl.getUniformLocation(P, n);
      gl.uniformMatrix4fv(U('vp'), false, vp); gl.uniform3fv(U('lp'), lp); gl.uniform3fv(U('ld'), ld); gl.uniform3fv(U('lc'), lc); gl.uniform2fv(U('lk'), lk);
      // amb: 照明が消えているときの明るさ（2026-11-22 Akira さん: 若干明るいので 0.12 から下げた）
      gl.uniform1i(U('nl'), ls.length); gl.uniform3fv(U('eye'), eye); gl.uniform1f(U('amb'), opts.amb ?? 0.05); gl.uniform1f(U('solid'), solid ? 1 : 0);
      // 部屋は内側から見るので、壁は向こう向きの面だけ消す（手前の壁は透ける）
      attrib(P, st); gl.drawArrays(gl.TRIANGLES, 0, st.count);
      if (fx) { gl.disable(gl.CULL_FACE); attrib(P, fx); gl.drawArrays(gl.TRIANGLES, 0, fx.count); }
      const beamK = solid ? 0.05 : opts.beam ?? 0.12;
      if (bm && beamK > 0) {
        gl.useProgram(PB); gl.disable(gl.CULL_FACE); gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE); gl.depthMask(false);
        const UB = (n: string) => gl.getUniformLocation(PB, n);
        gl.uniformMatrix4fv(UB('vp'), false, vp); gl.uniform3fv(UB('lc'), lc.map((c) => c / 1.7)); gl.uniform3fv(UB('lp'), lp); gl.uniform3fv(UB('ld'), ld); gl.uniform3fv(UB('eye'), eye); gl.uniform1f(UB('beam'), beamK * 1.4);
        attrib(PB, bm); gl.drawArrays(gl.TRIANGLES, 0, bm.count); gl.depthMask(true);
      }
    },
  };
}

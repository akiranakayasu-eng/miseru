// 音楽ファイルの分析（Music タブ）。音の波形から、音量・帯域ごとの強さ・明るさ・拍とテンポ・調・曲の区切りを求め、
// Claude に渡す短い文の要約にする。音そのものは外に出さない。画面にも DMX にも依存しない。

export interface BandLevels {
  /** 0..9（曲の中での相対） */
  loud: number;
  bass: number;
  lowMid: number;
  mid: number;
  highMid: number;
  high: number;
  /** 音の明るさ（スペクトル重心） */
  bright: number;
  /** 打撃の多さ（1 秒あたりの立ち上がりの数） */
  hits: number;
}

export interface Row extends BandLevels {
  /** 小節（テンポが取れないときは 2 秒）の始まり（秒） */
  t: number;
  /** 1 始まりの番号 */
  n: number;
}

export interface Section {
  start: number;
  end: number;
  /** rows の番号（1 始まり）の範囲 */
  fromRow: number;
  toRow: number;
  /** 平均の音量 0..9 */
  level: number;
  trend: 'rising' | 'falling' | 'flat';
  hint: 'intro' | 'build' | 'peak' | 'break' | 'body' | 'outro';
}

export interface AudioAnalysis {
  duration: number;
  /** テンポが取れなかったら null */
  bpm: number | null;
  /** 0..1 */
  tempoConfidence: number;
  /** 拍の長さ（秒）。テンポが取れなかったら 0.5 */
  beatPeriod: number;
  /** 最初の小節頭（秒） */
  firstDownbeat: number;
  key: string | null;
  keyConfidence: number;
  /** 'bar' なら rows は小節ごと、'window' なら 2 秒ごと */
  rowKind: 'bar' | 'window';
  rows: Row[];
  sections: Section[];
  /** 目立つ打撃（秒、強い順に最大 12） */
  accents: number[];
  /** 無音に近いところ [始め, 終わり]（秒） */
  silences: [number, number][];
  /** 波形の表示用（0..1、600 点） */
  envelope: number[];
}

// ---- FFT ----------------------------------------------------------------

function fft(re: Float64Array, im: Float64Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const xr = re[b] * cr - im[b] * ci;
        const xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
}

// ---- 小さな道具 ----------------------------------------------------------

const mean = (a: ArrayLike<number>, from = 0, to = a.length) => {
  let s = 0;
  for (let i = from; i < to; i++) s += a[i];
  return to > from ? s / (to - from) : 0;
};

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * p)))];
}

/** 値の列を曲の中での相対の 0..9 にする（下 5% から最大まで） */
function scale09(values: number[]): number[] {
  const lo = percentile(values, 0.05);
  const hi = Math.max(...values);
  if (!(hi > lo)) return values.map(() => 0);
  return values.map((v) => Math.max(0, Math.min(9, Math.round(((v - lo) / (hi - lo)) * 9))));
}

const db = (power: number) => 10 * Math.log10(power + 1e-12);

const BANDS: [number, number][] = [
  [20, 150],
  [150, 500],
  [500, 2000],
  [2000, 6000],
  [6000, 16000],
];

// Krumhansl の長調・短調のプロフィール
const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

function correlate(a: number[], b: number[]): number {
  const ma = mean(a);
  const mb = mean(b);
  let num = 0;
  let da = 0;
  let dbb = 0;
  for (let i = 0; i < a.length; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    dbb += (b[i] - mb) ** 2;
  }
  return da > 0 && dbb > 0 ? num / Math.sqrt(da * dbb) : 0;
}

export function estimateKey(chroma: number[]): { key: string | null; confidence: number } {
  // 音の高さがはっきりしない音（打楽器だけなど）は調を出さない
  const avg = mean(chroma);
  if (!(avg > 0) || Math.max(...chroma) / avg < 1.6) return { key: null, confidence: 0 };
  let best = { key: null as string | null, r: -1 };
  for (let tonic = 0; tonic < 12; tonic++) {
    const rotated = chroma.map((_, i) => chroma[(i + tonic) % 12]);
    const rMaj = correlate(rotated, MAJOR);
    const rMin = correlate(rotated, MINOR);
    if (rMaj > best.r) best = { key: `${NOTE_NAMES[tonic]} major`, r: rMaj };
    if (rMin > best.r) best = { key: `${NOTE_NAMES[tonic]} minor`, r: rMin };
  }
  return best.r > 0 ? { key: best.key, confidence: Math.round(best.r * 100) / 100 } : { key: null, confidence: 0 };
}

// ---- テンポ ----------------------------------------------------------------

/** 立ち上がりの強さの列（フレームごと）からテンポと拍の位置を求める */
export function estimateTempo(onset: number[], frameRate: number, forcedBpm?: number): { bpm: number | null; confidence: number; phaseFrames: number; lagFrames: number } {
  const n = onset.length;
  const minLag = Math.max(1, Math.floor((frameRate * 60) / 200));
  const maxLag = Math.min(n - 1, Math.ceil((frameRate * 60) / 60));
  if (maxLag <= minLag + 2) return { bpm: null, confidence: 0, phaseFrames: 0, lagFrames: 0 };
  const m = mean(onset);
  const x = onset.map((v) => v - m);
  let ac0 = 0;
  for (let i = 0; i < n; i++) ac0 += x[i] * x[i];
  if (ac0 <= 0) return { bpm: null, confidence: 0, phaseFrames: 0, lagFrames: 0 };
  const top = Math.min(n - 1, 2 * maxLag + 2);
  const ac = new Float64Array(top + 1);
  for (let lag = 1; lag <= top; lag++) {
    let s = 0;
    for (let i = 0; i + lag < n; i++) s += x[i] * x[i + lag];
    ac[lag] = s / ac0;
  }
  // 120 BPM あたりを少し好む（1 オクターブ幅の重み）
  let bestLag = minLag;
  let bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = (60 * frameRate) / lag;
    const w = Math.exp(-0.5 * (Math.log2(bpm / 120) / 1) ** 2);
    // 拍の半分（裏拍）と 2 倍（2 拍）にも山がある間隔を選ぶ。8 分のハイハットの曲で 3 つ分（2/3 倍のテンポ）を選ばないように
    const at = (x: number) => {
      const i = Math.floor(x);
      const u = x - i;
      return i + 1 <= top ? ac[i] * (1 - u) + ac[i + 1] * u : 0;
    };
    const score = (ac[lag] + 0.5 * Math.max(0, at(lag / 2)) + 0.5 * Math.max(0, at(lag * 2))) * w;
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }
  // 放物線で小数のずれを補う
  const a = ac[bestLag - 1];
  const b = ac[bestLag];
  const c = ac[bestLag + 1];
  let bestCand = bestLag;
  const denom = a - 2 * b + c;
  const shift = denom !== 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / denom)) : 0;
  const confidence = Math.max(0, Math.min(1, b));
  // 自己相関の格子は粗い（1 フレーム約 23 ms）ので、曲全体に拍の櫛を当てて間隔と位置を細かく合わせる。
  // 0.5% ずれると 1 分で半拍ずれるため
  const comb = (lagF: number, phase: number) => {
    let s = 0;
    let cnt = 0;
    for (let t = phase; t < n - 1; t += lagF) {
      const i = Math.floor(t);
      const u = t - i;
      s += onset[i] * (1 - u) + onset[i + 1] * u;
      cnt++;
    }
    return cnt ? s / cnt : 0;
  };
  // 人がテンポを直したとき（½・×2）は、その値の近くだけで合わせる
  let lag = forcedBpm ? (60 * frameRate) / forcedBpm : bestLag + shift;
  let bestPhase = 0;
  let bestSum = -Infinity;
  const steps = 160;
  for (let k = -steps / 2; k <= steps / 2; k++) {
    const cand = lag * (1 + (k / steps) * (forcedBpm ? 0.01 : 0.06));
    for (let p = 0; p < cand; p += 0.25) {
      const s = comb(cand, p);
      if (s > bestSum) {
        bestSum = s;
        bestPhase = p;
        bestCand = cand;
      }
    }
  }
  lag = bestCand;
  return { bpm: Math.round(((60 * frameRate) / lag) * 10) / 10, confidence: forcedBpm ? 1 : Math.round(confidence * 100) / 100, phaseFrames: bestPhase, lagFrames: lag };
}

// ---- 区切り ----------------------------------------------------------------

/** 行ごとの特徴の列から、曲の区切り（行の番号、0 始まり）を求める */
export function findBoundaries(features: number[][], minLen: number): number[] {
  const n = features.length;
  if (n < minLen * 2) return [];
  const dist = (i: number, j: number) => {
    let s = 0;
    for (let k = 0; k < features[i].length; k++) s += (features[i][k] - features[j][k]) ** 2;
    return Math.sqrt(s);
  };
  const w = Math.max(2, minLen);
  const novelty: number[] = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    let cross = 0;
    let cnt = 0;
    for (let a = Math.max(0, i - w); a < i; a++) {
      for (let b = i; b < Math.min(n, i + w); b++) {
        cross += dist(a, b);
        cnt++;
      }
    }
    novelty[i] = cnt ? cross / cnt : 0;
  }
  const m = mean(novelty);
  const sd = Math.sqrt(mean(novelty.map((v) => (v - m) ** 2)));
  const cands = novelty
    .map((v, i) => ({ v, i }))
    .filter(({ v, i }) => i >= minLen && i <= n - minLen && v > m + 0.3 * sd && v >= (novelty[i - 1] ?? 0) && v >= (novelty[i + 1] ?? 0))
    .sort((p, q) => q.v - p.v);
  const picked: number[] = [];
  for (const c of cands) if (picked.every((p) => Math.abs(p - c.i) >= minLen)) picked.push(c.i);
  return picked.sort((p, q) => p - q);
}

// ---- 本体 ------------------------------------------------------------------


/**
 * 1 チャンネルの波形を分析する。重いので、途中で画面に戻るための yieldEvery（フレーム数）ごとに await する。
 */
export async function analyzeAudio(samples: Float32Array, sampleRate: number, onProgress?: (p: number) => void, opts?: { bpm?: number }): Promise<AudioAnalysis> {
  const duration = samples.length / sampleRate;
  // 1 フレームを約 46 ms（44.1 kHz で 2048）にそろえる。テンポの細かさがサンプリング周波数で変わらないように
  const FRAME = sampleRate > 32000 ? 2048 : sampleRate > 16000 ? 1024 : 512;
  const hop = FRAME / 2;
  const frameRate = sampleRate / hop;
  const frames = Math.max(0, Math.floor((samples.length - FRAME) / hop) + 1);
  const win = new Float64Array(FRAME).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME - 1)));
  const binHz = sampleRate / FRAME;
  const bandBins = BANDS.map(([lo, hi]) => [Math.max(1, Math.floor(lo / binHz)), Math.min(FRAME / 2, Math.ceil(hi / binHz))]);
  const pitchClass = new Int8Array(FRAME / 2).fill(-1);
  for (let k = 1; k < FRAME / 2; k++) {
    const f = k * binHz;
    if (f >= 200 && f <= 2500) pitchClass[k] = ((Math.round(12 * Math.log2(f / 440)) + 69) % 12 + 12) % 12;
  }

  const rms = new Float64Array(frames);
  const bands = BANDS.map(() => new Float64Array(frames));
  const centroid = new Float64Array(frames);
  const flux = new Float64Array(frames);
  const chroma = new Array(12).fill(0);
  const re = new Float64Array(FRAME);
  const im = new Float64Array(FRAME);
  let prevLog = new Float64Array(FRAME / 2);
  let curLog = new Float64Array(FRAME / 2);

  for (let f = 0; f < frames; f++) {
    const off = f * hop;
    let e = 0;
    for (let i = 0; i < FRAME; i++) {
      const s = samples[off + i];
      e += s * s;
      re[i] = s * win[i];
      im[i] = 0;
    }
    rms[f] = Math.sqrt(e / FRAME);
    fft(re, im);
    let total = 0;
    let weighted = 0;
    let fl = 0;
    for (let k = 1; k < FRAME / 2; k++) {
      const p = re[k] * re[k] + im[k] * im[k];
      const mag = Math.sqrt(p);
      total += p;
      weighted += p * k * binHz;
      curLog[k] = Math.log1p(100 * mag);
      const d = curLog[k] - prevLog[k];
      if (d > 0) fl += d;
      if (pitchClass[k] >= 0) chroma[pitchClass[k]] += p;
    }
    for (let b = 0; b < BANDS.length; b++) {
      let s = 0;
      for (let k = bandBins[b][0]; k < bandBins[b][1]; k++) s += re[k] * re[k] + im[k] * im[k];
      bands[b][f] = s;
    }
    centroid[f] = total > 0 ? weighted / total : 0;
    flux[f] = f === 0 ? 0 : fl;
    [prevLog, curLog] = [curLog, prevLog];
    if (f % 400 === 399) {
      onProgress?.(f / frames);
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  onProgress?.(1);

  // 立ち上がり: 近くの平均を引いて正の部分だけ
  const avgW = Math.max(1, Math.round(frameRate * 0.25));
  const onset: number[] = [];
  for (let f = 0; f < frames; f++) {
    const local = mean(flux, Math.max(0, f - avgW), Math.min(frames, f + avgW + 1));
    onset.push(Math.max(0, flux[f] - local));
  }
  const onsetMean = mean(onset);
  const onsetSd = Math.sqrt(mean(onset.map((v) => (v - onsetMean) ** 2)));
  const isHit = onset.map((v, f) => v > onsetMean + 1.5 * onsetSd && v >= (onset[f - 1] ?? 0) && v >= (onset[f + 1] ?? 0));

  const tempo = estimateTempo(onset, frameRate, opts?.bpm);
  const useBars = tempo.bpm !== null && tempo.confidence >= 0.08 && duration > 8;
  const beatPeriod = useBars ? 60 / tempo.bpm! : 0.5;
  let firstBeat = useBars ? tempo.phaseFrames / frameRate : 0;
  // 小節頭: 4 拍のうち低音の立ち上がりがいちばん強い拍
  let firstDownbeat = firstBeat;
  if (useBars) {
    const sums = [0, 0, 0, 0];
    for (let k = 0; ; k++) {
      const t = firstBeat + k * beatPeriod;
      const f = Math.round(t * frameRate);
      if (f >= frames) break;
      const bassNow = bands[0][f];
      const bassPrev = bands[0][Math.max(0, f - 2)];
      sums[k % 4] += Math.max(0, db(bassNow) - db(bassPrev)) + onset[f];
    }
    const best = sums.indexOf(Math.max(...sums));
    firstDownbeat = firstBeat + best * beatPeriod;
    // 曲の頭に 1 小節より長い前があれば、頭の側へ小節をさかのぼる
    while (firstDownbeat - 4 * beatPeriod >= -0.05) firstDownbeat -= 4 * beatPeriod;
    firstDownbeat = Math.max(0, firstDownbeat);
    firstBeat = firstDownbeat;
  }

  // 行（小節か 2 秒）の始まり
  const rowLen = useBars ? 4 * beatPeriod : 2;
  const starts: number[] = [];
  if (useBars && firstDownbeat > 0.3) starts.push(0);
  for (let t = useBars ? firstDownbeat : 0; t < duration - 0.25; t += rowLen) starts.push(t);
  if (starts.length === 0) starts.push(0);
  // 頭のわずかなずれ（小節頭が 0.3 秒より前）は最初の行に含めて、表がいつも 0 秒から始まるように
  starts[0] = 0;

  const raw = starts.map((t, i) => {
    const end = i + 1 < starts.length ? starts[i + 1] : duration;
    const a = Math.min(frames, Math.max(0, Math.floor(t * frameRate)));
    const b = Math.min(frames, Math.max(a + 1, Math.floor(end * frameRate)));
    let hits = 0;
    for (let f = a; f < b; f++) if (isHit[f]) hits++;
    return {
      t,
      loud: db(mean(rms, a, b) ** 2),
      bands: bands.map((bd) => db(mean(bd, a, b))),
      bright: mean(centroid, a, b),
      hits: hits / Math.max(0.1, end - t),
    };
  });
  const loud = scale09(raw.map((r) => r.loud));
  const bandScaled = BANDS.map((_, b) => scale09(raw.map((r) => r.bands[b])));
  const bright = scale09(raw.map((r) => r.bright));
  const hits = scale09(raw.map((r) => r.hits));
  const rows: Row[] = raw.map((r, i) => ({
    t: Math.round(r.t * 100) / 100,
    n: i + 1,
    loud: loud[i],
    bass: bandScaled[0][i],
    lowMid: bandScaled[1][i],
    mid: bandScaled[2][i],
    highMid: bandScaled[3][i],
    high: bandScaled[4][i],
    bright: bright[i],
    hits: hits[i],
  }));

  // 区切り: 音量・帯域・明るさ・打撃の変わり目（最短 4 行）
  const feats = rows.map((r) => [r.loud, r.bass, r.lowMid, r.mid, r.highMid, r.high, r.bright, r.hits].map((v) => v / 9));
  const minLen = rows.length >= 24 ? 4 : 2;
  const bounds = [0, ...findBoundaries(feats, minLen), rows.length];
  const sections: Section[] = [];
  for (let s = 0; s + 1 < bounds.length; s++) {
    const from = bounds[s];
    const to = bounds[s + 1];
    const lv = rows.slice(from, to).map((r) => r.loud);
    const level = Math.round(mean(lv) * 10) / 10;
    const half = Math.max(1, Math.floor(lv.length / 2));
    const diff = mean(lv.slice(half)) - mean(lv.slice(0, half));
    const trend: Section['trend'] = diff > 1 ? 'rising' : diff < -1 ? 'falling' : 'flat';
    sections.push({
      start: rows[from].t,
      end: to < rows.length ? rows[to].t : Math.round(duration * 100) / 100,
      fromRow: from + 1,
      toRow: to,
      level,
      trend,
      hint: 'body',
    });
  }
  const levels = sections.map((s) => s.level);
  const top = Math.max(...levels);
  sections.forEach((s, i) => {
    if (i === 0 && sections.length > 1 && s.level < top - 2) s.hint = 'intro';
    else if (i === sections.length - 1 && sections.length > 1 && (s.trend === 'falling' || s.level < top - 2)) s.hint = 'outro';
    else if (s.level >= top - 1) s.hint = 'peak';
    else if (s.trend === 'rising') s.hint = 'build';
    else if (i > 0 && i < sections.length - 1 && s.level < levels[i - 1] - 2 && s.level < levels[i + 1] - 2) s.hint = 'break';
  });

  // 目立つ打撃
  const accents = onset
    .map((v, f) => ({ v, f }))
    .filter(({ f }) => isHit[f])
    .sort((a, b) => b.v - a.v)
    .reduce<number[]>((acc, { f }) => {
      const t = Math.round((f / frameRate) * 100) / 100;
      if (acc.length < 12 && acc.every((x) => Math.abs(x - t) > 2)) acc.push(t);
      return acc;
    }, [])
    .sort((a, b) => a - b);

  // 無音に近いところ（-50 dBFS 未満が 1 秒以上）
  const silences: [number, number][] = [];
  let silentFrom = -1;
  for (let f = 0; f <= frames; f++) {
    const quiet = f < frames && db(rms[f] ** 2) < -50;
    if (quiet && silentFrom < 0) silentFrom = f;
    if (!quiet && silentFrom >= 0) {
      if ((f - silentFrom) / frameRate >= 1) silences.push([Math.round((silentFrom / frameRate) * 10) / 10, Math.round((f / frameRate) * 10) / 10]);
      silentFrom = -1;
    }
  }

  const envelope: number[] = [];
  const peak = Math.max(1e-9, ...Array.from(rms));
  for (let i = 0; i < 600; i++) {
    const a = Math.floor((i / 600) * frames);
    const b = Math.max(a + 1, Math.floor(((i + 1) / 600) * frames));
    envelope.push(frames ? Math.min(1, mean(rms, a, Math.min(frames, b)) / peak) : 0);
  }

  const k = estimateKey(chroma);
  return {
    duration: Math.round(duration * 100) / 100,
    bpm: useBars ? tempo.bpm : null,
    tempoConfidence: tempo.confidence,
    beatPeriod,
    firstDownbeat: Math.round(firstDownbeat * 1000) / 1000,
    key: k.key,
    keyConfidence: k.confidence,
    rowKind: useBars ? 'bar' : 'window',
    rows,
    sections,
    accents,
    silences,
    envelope,
  };
}

/** Claude に渡す分析の要約（英語の短い表） */
export function analysisToText(a: AudioAnalysis): string {
  const lines: string[] = [];
  lines.push(`duration: ${a.duration} s`);
  if (a.bpm) lines.push(`tempo: ${a.bpm} BPM (confidence ${a.tempoConfidence}), beat = ${a.beatPeriod.toFixed(3)} s, bar = ${(a.beatPeriod * 4).toFixed(3)} s (4/4 assumed), first downbeat at ${a.firstDownbeat} s${a.tempoConfidence < 1 ? '; automatic detection, may be half or double the felt tempo' : '; confirmed by the operator'}`);
  else lines.push('tempo: not detected (free time); rows below are 2-second windows');
  if (a.key) lines.push(`key: ${a.key} (confidence ${a.keyConfidence})`);
  lines.push('');
  lines.push('sections (detected from changes in loudness, spectrum and hits; hint is only a guess):');
  a.sections.forEach((s, i) => lines.push(`  ${i + 1}. ${s.start}-${s.end} s, rows ${s.fromRow}-${s.toRow}, level ${s.level}/9, ${s.trend}, hint ${s.hint}`));
  lines.push('');
  lines.push(`${a.rowKind === 'bar' ? 'bars' : '2-second windows'} (all values 0-9, relative within this song):`);
  lines.push('  row start_s loud bass lowmid mid highmid high bright hits');
  for (const r of a.rows) lines.push(`  ${r.n} ${r.t} ${r.loud} ${r.bass} ${r.lowMid} ${r.mid} ${r.highMid} ${r.high} ${r.bright} ${r.hits}`);
  lines.push('');
  lines.push(`strongest hits (s): ${a.accents.join(', ') || 'none'}`);
  lines.push(`near-silence (s): ${a.silences.map(([s, e]) => `${s}-${e}`).join(', ') || 'none'}`);
  return lines.join('\n');
}

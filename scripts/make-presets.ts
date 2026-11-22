// Timeline のプリセット（曲＋前もって作ったキーフレームの .miseru）を作る。2026-11-22
// 曲は Akira さんが Suno で作ったもの。曲そのものはリポジトリに入れない（作業の場所は外のフォルダ）。
//   npx tsx scripts/make-presets.ts analyze <曲のフォルダ> <作業フォルダ>
//     曲ごとに <slug>.prompt.txt（曲の分析と灯体の説明。Music で Claude に渡すものと同じ）と <slug>.analysis.json を書く
//   npx tsx scripts/make-presets.ts build <曲のフォルダ> <作業フォルダ> <出力フォルダ>
//     <slug>.plan.json（ShowPlan。Music の Claude の答えと同じ形）を Timeline にし、曲と合わせて <slug>.miseru と presets.json を書く
// 曲は macOS の afconvert で 44.1 kHz モノラルの float に直す（Mac で動かす前提）
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { analyzeAudio, analysisToText } from '../src/engine/audioAnalysis.js';
import { buildUserMessage, expandPlan, type ShowPlan } from '../src/engine/musicShow.js';
import { tmuPhotoStudio } from '../src/engine/patches.js';
import { encodeShowFile } from '../src/engine/showFile.js';

const [mode, srcDir, workDir, outDir] = process.argv.slice(2);
if (!mode || !srcDir || !workDir || (mode === 'build' && !outDir)) {
  console.error('usage: make-presets.ts analyze <src> <work> | build <src> <work> <out>');
  process.exit(1);
}
const songs = readdirSync(srcDir).filter((f) => /\.(mp3|m4a|wav|aiff?)$/i.test(f)).sort();
const titleOf = (f: string) => basename(f, extname(f));
function slugOf(f: string): string {
  const a = titleOf(f).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return a || 'song-' + createHash('sha1').update(titleOf(f)).digest('hex').slice(0, 6);
}
function decode(file: string): { samples: Float32Array; sampleRate: number } {
  const tmp = join(tmpdir(), `miseru-preset-${process.pid}.wav`);
  execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEF32@44100', '-c', '1', file, tmp]);
  const b = readFileSync(tmp);
  rmSync(tmp);
  let at = 12;
  while (at + 8 <= b.length) {
    const id = b.toString('ascii', at, at + 4), len = b.readUInt32LE(at + 4);
    if (id === 'data') {
      const ab = b.buffer.slice(b.byteOffset + at + 8, b.byteOffset + at + 8 + len);
      return { samples: new Float32Array(ab), sampleRate: 44100 };
    }
    at += 8 + len + (len & 1);
  }
  throw new Error(`no data chunk: ${file}`);
}
const lights = tmuPhotoStudio.lights;
const DIRECTION = 'Make a show that follows the song: calm parts soft, builds rising, peaks bright and moving, endings fading out.';
// 曲ごとの指示。空の文字列は「おまかせ」（Music で Direction を空にしたときと同じ）。
// Slow Circuit Drift は 2026-11-22 Akira さんの依頼で「おまかせ」で作り直した。
// plan.json は、analyze が書いた prompt.txt を SHOW_SYSTEM_PROMPT と合わせて読み、Claude（作業したスレッド）が ShowPlan の形で書いたもの。
// 使った prompt.txt は scripts/presets に plan と並べて置く。
const DIRECTIONS: Record<string, string> = { 'slow-circuit-drift': '' };

mkdirSync(workDir, { recursive: true });
if (mode === 'analyze') {
  for (const f of songs) {
    const { samples, sampleRate } = decode(join(srcDir, f));
    const a = await analyzeAudio(samples, sampleRate);
    const slug = slugOf(f);
    writeFileSync(join(workDir, `${slug}.prompt.txt`), `# ${titleOf(f)}\n\n` + buildUserMessage(analysisToText(a), lights, DIRECTIONS[slug] ?? DIRECTION));
    writeFileSync(join(workDir, `${slug}.analysis.json`), JSON.stringify({ title: titleOf(f), file: f, duration: a.duration, beatPeriod: a.beatPeriod, firstDownbeat: a.firstDownbeat, bpm: a.bpm }, null, 1));
    console.log(slug, a.duration.toFixed(1), 's', a.bpm, 'bpm');
  }
} else if (mode === 'build') {
  mkdirSync(outDir, { recursive: true });
  const list: { title: string; file: string; duration: number }[] = [];
  for (const f of songs) {
    const slug = slugOf(f);
    const planPath = join(workDir, `${slug}.plan.json`);
    if (!existsSync(planPath)) {
      console.log('skip (no plan)', slug);
      continue;
    }
    const a = JSON.parse(readFileSync(join(workDir, `${slug}.analysis.json`), 'utf8'));
    const plan = JSON.parse(readFileSync(planPath, 'utf8')) as ShowPlan;
    const r = expandPlan(plan, lights, a, titleOf(f));
    const ext = extname(f).toLowerCase();
    const type = ext === '.mp3' ? 'audio/mpeg' : ext === '.m4a' ? 'audio/mp4' : ext === '.wav' ? 'audio/wav' : 'audio/aiff';
    // 公開用なので、mp3 のタグ（Suno のアカウント名・URL・カバー画像など）を外す（2026-11-22 Akira さん）。曲の名前は元のファイル名（曲名）のまま
    const raw = new Uint8Array(readFileSync(join(srcDir, f)));
    const audio = ext === '.mp3' ? stripMp3Tags(raw) : raw;
    const bytes = encodeShowFile(r.timeline, { name: f, type, bytes: audio });
    writeFileSync(join(outDir, `${slug}.miseru`), bytes);
    list.push({ title: titleOf(f), file: `${slug}.miseru`, duration: Math.round(a.duration) });
    console.log(slug, r.keyCount, 'keys', r.warnings.length ? r.warnings.join(' / ') : '');
  }
  writeFileSync(join(outDir, 'presets.json'), JSON.stringify(list, null, 1));
}

// mp3 の先頭の ID3v2（いくつ続いても）と、末尾の ID3v1（TAG、128 バイト）を外す。音のフレームには触れない
function stripMp3Tags(b: Uint8Array): Uint8Array {
  let start = 0;
  while (b[start] === 0x49 && b[start + 1] === 0x44 && b[start + 2] === 0x33) {
    const size = ((b[start + 6] & 0x7f) << 21) | ((b[start + 7] & 0x7f) << 14) | ((b[start + 8] & 0x7f) << 7) | (b[start + 9] & 0x7f);
    const footer = b[start + 5] & 0x10 ? 10 : 0;
    start += 10 + size + footer;
  }
  let end = b.length;
  if (end - start >= 128 && b[end - 128] === 0x54 && b[end - 127] === 0x41 && b[end - 126] === 0x47) end -= 128;
  return b.slice(start, end);
}

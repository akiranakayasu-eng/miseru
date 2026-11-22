// Music タブ: 曲を分析し、Claude に演出を考えてもらい、Timeline に入れる。

import { useEffect, useId, useRef, useState } from 'react';
import { analyzeAudio, analysisToText, type AudioAnalysis } from '../../engine/audioAnalysis.js';
import { buildUserMessage, expandPlan, type ExpandResult, type ShowPlan } from '../../engine/musicShow.js';
import type { PatchedLight } from '../../engine/show.js';
import { askClaudeForShow, describeError, showModels } from '../claudeShow';
import { useClaudeSettings } from '../claudeSettings';
import { isBox } from '../useShow';
import type { Media, useTimeline } from '../useTimeline';
import { requestFitAll, TIcon } from './TimelinePanel';
import { Recorder } from './Recorder';
import { ask } from '../ask';

type TimelineApi = ReturnType<typeof useTimeline>;

const DIRECTION_KEY = 'miseru.musicDirection';

async function decodeMono(url: string): Promise<{ samples: Float32Array; sampleRate: number }> {
  const buf = await (await fetch(url)).arrayBuffer();
  const ctx = new AudioContext();
  try {
    const audio = await ctx.decodeAudioData(buf);
    const n = audio.length;
    const out = new Float32Array(n);
    for (let c = 0; c < audio.numberOfChannels; c++) {
      const ch = audio.getChannelData(c);
      for (let i = 0; i < n; i++) out[i] += ch[i] / audio.numberOfChannels;
    }
    return { samples: out, sampleRate: audio.sampleRate };
  } finally {
    void ctx.close();
  }
}

const fmtTime = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;

function readLocal(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}
function writeLocal(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* 覚えられなくても動く */
  }
}

export function MusicPanel({ api, lights, onApplied, onSettings }: { api: TimelineApi; lights: PatchedLight[]; onApplied: () => void; onSettings: () => void }) {
  const { key: apiKey, model } = useClaudeSettings();
  const [direction, setDirection] = useState(() => readLocal(DIRECTION_KEY, ''));
  const [analysis, setAnalysis] = useState<{ url: string; data: AudioAnalysis } | null>(null);
  const [analyzing, setAnalyzing] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [received, setReceived] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ plan: ShowPlan; expanded: ExpandResult; cost: number; tokens: string } | null>(null);
  const abort = useRef<AbortController | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => writeLocal(DIRECTION_KEY, direction), [direction]);

  // 読み込んだ曲（Timeline と同じもの）を分析する
  const mediaUrl = api.media?.url ?? null;
  // テンポの読み違い（半分・倍）を直すための値。曲を変えたら戻す
  const [bpmFix, setBpmFix] = useState<{ url: string; bpm: number } | null>(null);
  const forced = bpmFix && bpmFix.url === mediaUrl ? bpmFix.bpm : undefined;
  const want = mediaUrl ? `${mediaUrl}|${forced ?? ''}` : null;
  useEffect(() => {
    if (!mediaUrl || !want || analysis?.url === want) return;
    let cancelled = false;
    setAnalyzing(0);
    setError(null);
    setResult(null);
    (async () => {
      try {
        const { samples, sampleRate } = await decodeMono(mediaUrl);
        const data = await analyzeAudio(samples, sampleRate, (p) => !cancelled && setAnalyzing(p), { bpm: forced });
        if (!cancelled) setAnalysis({ url: want, data });
      } catch {
        if (!cancelled) setError('Could not read the audio of this file. WAV, MP3 and AAC (M4A) work. Apple Lossless M4A does not open in Chrome: convert it to AAC or MP3.');
      } finally {
        if (!cancelled) setAnalyzing(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mediaUrl, want, forced, analysis?.url]);

  useEffect(() => {
    if (!busy) return;
    const started = performance.now();
    const id = setInterval(() => setElapsed((performance.now() - started) / 1000), 500);
    return () => clearInterval(id);
  }, [busy]);

  const current = analysis && analysis.url === want ? analysis.data : null;
  // f が 0 のときは読み取ったままのテンポ（×1）に戻す
  const scaleBpm = (f: number) => current?.bpm && mediaUrl && setBpmFix(f ? { url: mediaUrl, bpm: Math.round(current.bpm * f * 10) / 10 } : null);

  const generate = async () => {
    if (!current || !apiKey.trim()) return;
    setBusy(true);
    setElapsed(0);
    setReceived(0);
    setError(null);
    setResult(null);
    const ctrl = new AbortController();
    abort.current = ctrl;
    try {
      const message = buildUserMessage(analysisToText(current), lights, direction);
      const r = await askClaudeForShow({ apiKey: apiKey.trim(), model, userMessage: message, signal: ctrl.signal, onProgress: setReceived });
      const expanded = expandPlan(r.plan, lights, current, `Music: ${api.media?.name ?? 'song'}`);
      setResult({ plan: r.plan, expanded, cost: r.usage.cost, tokens: `${r.usage.input.toLocaleString()} in / ${r.usage.output.toLocaleString()} out` });
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
      abort.current = null;
    }
  };

  const apply = () => {
    if (!result) return;
    // スマホでは ⌘Z で戻せないので、今のタイムラインにキーがあれば先に確かめる
    if (api.tl.tracks.length > 0 && !ask('Replace the current timeline with this result?')) return;
    api.pause();
    api.setTl(result.expanded.timeline);
    requestFitAll();
    api.seek(0);
    onApplied();
  };

  return (
    <div className="mu-panel">
      {/* キーとモデルは右上の Settings で入れる。ここは入っているかだけ見せる */}
      <div className="mu-section">
      <div className="mu-heading">Claude API</div>
      <div className="mu-key-row mu-api-line">
        {apiKey.trim() ? (
          <span className="mu-key-status">
            <span aria-hidden="true">✓</span> Key ••••{apiKey.trim().slice(-4)} · {showModels.find((m) => m.id === model)?.label ?? model}
          </span>
        ) : (
          <span className="mu-note">No key yet.</span>
        )}
        <button className="tl-btn" onClick={onSettings}>
          {apiKey.trim() ? 'Change in Settings' : 'Enter it in Settings'}
        </button>
      </div>
      </div>

      <div className="mu-section">
        <div className="mu-heading">Music Analysis</div>
        <div className="mu-key-row">
          <span className="mu-file">{api.media ? api.media.name : 'No audio loaded'}</span>
          <button className="tl-btn" onClick={() => fileRef.current?.click()}>
            Load Audio/Video…
          </button>
          <input ref={fileRef} type="file" accept="audio/*,video/*" hidden onChange={(e) => e.target.files?.[0] && api.loadMedia(e.target.files[0])} />
        </div>
        {/* 箱の画面は http で配るのでブラウザが録音を許さない。箱には入れない（容量も足りない） */}
        {!isBox && <Recorder onDone={(f) => void api.loadMedia(f)} />}
        {analyzing !== null && <p className="mu-note">Analyzing… {Math.round(analyzing * 100)}%</p>}
        {current && mediaUrl && <MusicSummary a={current} url={mediaUrl} timelineApi={api} onScaleBpm={busy ? undefined : scaleBpm} fixed={forced !== undefined} />}
      </div>

      {/* Direction（左）と Result（右）の 2 段組。Generate は Direction の下、Apply・Discard は Result の下 */}
      <div className="mu-pair">
      <div className="mu-section">
        <div className="mu-heading">Direction</div>
        {/* Generate は欄の上 */}
        <div className="mu-key-row">
          {busy ? (
            <button className="tl-btn" onClick={() => abort.current?.abort()}>
              Stop
            </button>
          ) : (
            <button className="tl-btn primary-ish" disabled={!current || !apiKey.trim()} onClick={generate}>
              Generate
            </button>
          )}
          {busy && <span className="mu-note">Asking Claude… {Math.round(elapsed)} s{received ? ` · ${received.toLocaleString()} chars` : ' · thinking'}</span>}
          {!busy && !current && <span className="mu-note">Load a song first.</span>}
          {!busy && current && !apiKey.trim() && <span className="mu-note">Enter an API key (Claude API above).</span>}
        </div>
        <textarea
          className="mu-direction"
          rows={2}
          value={direction}
          onChange={(e) => setDirection(e.target.value)}
          placeholder="例: 前フリは暗く、サビで全灯を拍に合わせて。最後は暖かい白で消す。"
          aria-label="Direction for Claude"
        />
        {error && <p className="mu-error" role="alert">{error}</p>}
      </div>

      {!result && (
        <div className="mu-section">
          <div className="mu-heading">Result</div>
          <p className="mu-note mu-result-empty">Claude’s plan appears here after Generate.</p>
        </div>
      )}
      {result && (
        <div className="mu-section">
          <div className="mu-heading">Result</div>
          {/* Apply・Discard は見出しのすぐ下 */}
          <div className="mu-key-row">
            <button className="tl-btn primary-ish" onClick={apply}>
              Apply to Timeline
            </button>
            <button className="tl-btn" onClick={() => setResult(null)}>
              Discard
            </button>
            <span className="mu-note">Replaces the current timeline (⌘Z to undo).</span>
          </div>
          <p className="mu-concept">{result.plan.concept}</p>
          <ol className="mu-cues">
            {[...result.plan.cues]
              .sort((a, b) => a.start - b.start)
              .map((c, i) => (
                <li key={i}>
                  <span className="mu-cue-time">{fmtTime(c.start)}</span>
                  <span className="mu-cue-label">{c.label}</span>
                  <span className="mu-cue-meta">
                    {c.pattern} · {c.lights.length} fixture{c.lights.length === 1 ? '' : 's'}
                  </span>
                </li>
              ))}
          </ol>
          {result.expanded.warnings.map((w) => (
            <p key={w} className="mu-note">
              {w}
            </p>
          ))}
          <p className="mu-note">
            {result.expanded.keyCount.toLocaleString()} keys · {result.tokens} tokens · about ${result.cost.toFixed(2)}
          </p>
        </div>
      )}
      </div>
    </div>
  );
}

/**
 * 曲の試聴。照明のタイムラインとは別の音で鳴らす。
 * ここで再生・移動しても、照明と Timeline の時間は動かない。
 */
// 試聴の位置を曲ごとに覚えておく（ほかのタブへ移って戻っても続きから）
const previewPos = new Map<string, number>();

function usePreview(url: string, duration: number, timelineApi: TimelineApi) {
  const el = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(() => previewPos.get(url) ?? 0);
  useEffect(() => {
    const a = new Audio(url);
    el.current = a;
    const start = previewPos.get(url) ?? 0;
    a.currentTime = start;
    setTime(start);
    setPlaying(false);
    const onEnd = () => setPlaying(false);
    a.addEventListener('ended', onEnd);
    return () => {
      previewPos.set(url, a.currentTime);
      a.pause();
      a.removeEventListener('ended', onEnd);
      el.current = null;
    };
  }, [url]);
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const a = el.current;
      if (a) setTime((t) => (t === a.currentTime ? t : a.currentTime));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);
  // Timeline の再生が始まったら、試聴は止める（音が二重にならないように）
  useEffect(() => {
    if (timelineApi.playing) {
      el.current?.pause();
      setPlaying(false);
    }
  }, [timelineApi.playing]);
  const seek = (t: number) => {
    const c = Math.max(0, Math.min(duration, t));
    if (el.current) el.current.currentTime = c;
    setTime(c);
  };
  const play = () => {
    const a = el.current;
    if (!a) return;
    if (timelineApi.playing) timelineApi.pause();
    if (a.currentTime >= duration - 0.05) a.currentTime = 0;
    void a.play();
    setPlaying(true);
  };
  const pause = () => {
    el.current?.pause();
    setPlaying(false);
  };
  const stop = () => {
    pause();
    seek(0);
  };
  return { playing, time, seek, play, pause, stop };
}

function MusicSummary({ a, url, timelineApi, onScaleBpm, fixed }: { a: AudioAnalysis; url: string; timelineApi: TimelineApi; onScaleBpm?: (f: number) => void; fixed?: boolean }) {
  const api = usePreview(url, a.duration, timelineApi);
  const w = 600;
  const h = 48;
  const path = a.envelope.map((v, i) => `${i === 0 ? 'M' : 'L'}${((i + 0.5) / a.envelope.length) * w},${h - v * (h - 4)}`).join(' ');
  return (
    <div className="mu-summary">
      <div className="mu-key-row">
        <span className="mu-note">
          {fmtTime(a.duration)} · {a.bpm ? `${a.bpm} BPM` : 'free tempo'} · {a.key ?? 'no clear key'} · {a.sections.length} sections
        </span>
        {a.bpm && onScaleBpm && (
          <span className="mu-bpm-fix" role="group" aria-label="Fix tempo">
            {/* 何のボタンか分かるように、前に説明を置く */}
            <span className="mu-note">BPM wrong? Fix it:</span>
            <button className="tl-btn small" onClick={() => onScaleBpm(0.5)} title="BPM detected twice too fast: halve it">
              ½
            </button>
            <button className="tl-btn small" onClick={() => onScaleBpm(2)} title="BPM detected twice too slow: double it">
              ×2
            </button>
            {fixed && (
              <button className="tl-btn small" onClick={() => onScaleBpm(0)} title="Back to the detected BPM">
                ×1
              </button>
            )}
          </span>
        )}
      </div>
      {/* 曲の試聴（再生・停止・最初へ）。照明のタイムラインとは連動しない */}
      {/* tl-bar を付けて、Timeline の再生ボタンと同じ大きさ・形にする */}
      <div className="mu-key-row tl-bar">
        <span className="tl-transport" role="group" aria-label="Music preview">
          <button className="tl-btn tl-ic" onClick={() => api.seek(0)} aria-label="Jump to Start" title="Jump to Start">
            <TIcon name="start" />
          </button>
          <button className="tl-btn tl-ic tl-ic-text play" onClick={api.playing ? api.pause : api.play} aria-label={api.playing ? 'Pause' : 'Play'} title={api.playing ? 'Pause' : 'Play'}>
            <TIcon name={api.playing ? 'pause' : 'play'} />
            {api.playing ? 'Pause' : 'Play'}
          </button>
          <button className="tl-btn tl-ic" onClick={api.stop} aria-label="Stop" title="Stop (back to start)">
            <TIcon name="stop" />
          </button>
        </span>
        <span className="mu-time">
          {fmtTime(Math.min(api.time, a.duration))} / {fmtTime(a.duration)}
        </span>
      </div>
      {/* 波形を押す・なぞると、その位置へ（時間のインジケーター） */}
      <svg
        className="mu-wave mu-wave-seek"
        viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio="none"
        role="slider"
        aria-label="Playback position"
        aria-valuemin={0}
        aria-valuemax={Math.round(a.duration)}
        aria-valuenow={Math.round(api.time)}
        tabIndex={0}
        onPointerDown={(e) => {
          const el = e.currentTarget;
          el.setPointerCapture(e.pointerId);
          const to = (x: number) => {
            const r = el.getBoundingClientRect();
            api.seek(Math.max(0, Math.min(1, (x - r.left) / r.width)) * a.duration);
          };
          to(e.clientX);
          const move = (ev: PointerEvent) => to(ev.clientX);
          const up = () => {
            el.removeEventListener('pointermove', move);
            el.removeEventListener('pointerup', up);
            el.removeEventListener('pointercancel', up);
          };
          el.addEventListener('pointermove', move);
          el.addEventListener('pointerup', up);
          el.addEventListener('pointercancel', up);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
            e.preventDefault();
            e.stopPropagation();
            api.seek(Math.max(0, Math.min(a.duration, api.time + (e.key === 'ArrowLeft' ? -5 : 5))));
          }
        }}
      >
        {/* 波形は区間ごとに色を変える。波形の形で切り抜いた色の帯 */}
        <clipPath id="mu-wclip">
          <path d={`${path} L${w},${h} L0,${h} Z`} />
        </clipPath>
        <g clipPath="url(#mu-wclip)">
          {a.sections.map((s) => (
            <rect key={s.start} x={(s.start / a.duration) * w} y={0} width={((s.end - s.start) / a.duration) * w} height={h} className={`mu-wave-fill mu-h-${s.hint}`} />
          ))}
        </g>
        {a.sections.slice(1).map((s) => (
          <line key={s.start} x1={(s.start / a.duration) * w} x2={(s.start / a.duration) * w} y1={0} y2={h} className="mu-wave-cut" />
        ))}
        <line x1={(Math.min(api.time, a.duration) / a.duration) * w} x2={(Math.min(api.time, a.duration) / a.duration) * w} y1={0} y2={h} className="mu-wave-head" />
      </svg>
      <div className="mu-sections">
        {a.sections.map((s) => (
          <span key={s.start} className={`mu-h-${s.hint}`} style={{ flexGrow: Math.max(0.01, s.end - s.start) }} title={`${fmtTime(s.start)}–${fmtTime(s.end)} · level ${s.level}`}>
            {s.hint}
          </span>
        ))}
      </div>
    </div>
  );
}

// Timeline の波形も Music Analysis と同じ区間の色で塗る。ウェブ版だけ（箱は容量の上限のため入れない）。
// 曲を読み込んだら裏で分析し、終わるまでは今までどおりの灰色の波形。App から TimelinePanel に渡す
export function TimelineWave({ media, width }: { media: Media; width: number }) {
  const [got, setGot] = useState<{ url: string; a: AudioAnalysis } | null>(null);
  const url = media.url;
  useEffect(() => {
    if (got?.url === url) return;
    let cancelled = false;
    decodeMono(url)
      .then(({ samples, sampleRate }) => analyzeAudio(samples, sampleRate))
      .then(
        (a) => {
          if (!cancelled) setGot({ url, a });
        },
        () => {
          // 分析できない曲は灰色の波形のまま
        },
      );
    return () => {
      cancelled = true;
    };
  }, [url, got?.url]);
  const id = 'tlw' + useId().replace(/[^a-zA-Z0-9]/g, '');
  const { peaks } = media;
  if (peaks.length === 0) return null;
  const a = got && got.url === url ? got.a : null;
  const h = 40;
  const d = peaks.map((p, i) => `M${(i / peaks.length) * width},${h / 2 - p * h * 0.48}V${h / 2 + p * h * 0.48}`).join('');
  const sw = Math.max(1, width / peaks.length);
  return (
    <svg className="wave" width={width} height={h}>
      {a ? (
        <>
          <mask id={id}>
            <path d={d} stroke="#fff" strokeWidth={sw} />
          </mask>
          <g mask={`url(#${id})`} opacity={0.75}>
            {a.sections.map((s) => (
              <rect key={s.start} x={(s.start / a.duration) * width} y={0} width={((s.end - s.start) / a.duration) * width} height={h} className={`mu-h-${s.hint}`} />
            ))}
          </g>
        </>
      ) : (
        <path d={d} stroke="currentColor" strokeWidth={sw} />
      )}
    </svg>
  );
}

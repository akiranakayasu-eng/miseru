import { Splitter } from './Splitter';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { applyCurve, addKey, evaluateTrack, lightLabel, curveNames, moveKey, removeKey, updateKey, type Curve, type Look, type PatchedLight, type Timeline, type Track } from '../../engine/index.js';
import { decodeShowFile, encodeShowFile } from '../../engine/showFile.js';
import type { Media } from '../useTimeline';
import { isBox } from '../useShow';
import { cssColor, displayRgb, FIXED_WHITE, isWhiteOnly } from './colors';
import { ask } from '../ask';

/** 名前の列のはじめの幅（ドラッグで変えられる。この端末に覚える） */
const LABEL_W = 96;
const LABEL_KEY = 'miseru.tlLabelW';
/** 0 秒の位置を名前の列から右へずらす量。0 秒のキーも左半分が見えるように（styles.css の .tl-lane の margin-left と同じ） */
const LANE_X0 = 12;
const curveLabel: Record<string, string> = {
  linear: 'Linear',
  'ease-in': 'Ease In',
  'ease-out': 'Ease Out',
  'ease-in-out': 'Ease In and Out',
  hold: 'Constant',
};
const curveKey = (c: Curve) => (typeof c === 'string' ? c : 'custom');

export interface TimelineApi {
  tl: Timeline;
  setTl: (t: Timeline | ((t: Timeline) => Timeline), opts?: { group?: string }) => void;
  time: number;
  playing: boolean;
  play: () => void;
  /** 今の位置から指定の時刻まで再生して止める */
  playUntil: (t: number) => void;
  pause: () => void;
  stop: () => void;
  seek: (t: number) => void;
  media: Media | null;
  loadMedia: (f: File) => void;
  clearMedia: () => void;
}

interface Props {
  api: TimelineApi;
  /** ウェブ版だけ: 区間の色で塗った波形（MusicPanel の TimelineWave） */
  Wave?: (p: { media: Media; width: number }) => JSX.Element | null;
  lights: PatchedLight[];
  selected: string[];
  /** いま選んでいるライトの見た目（キーに写す元） */
  currentLook: Look | undefined;
  groupName: (ids: string[]) => string;
  /** トラックの名前を押したとき、そのトラックの照明を天井図で目立たせる（null で解除） */
  onHighlight?: (ids: string[] | null) => void;
  /** トラック名を押したとき、天井図の選択をそのトラックの照明にする */
  onSelectLights?: (ids: string[]) => void;
}

const fmt = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;
const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

function Waveform({ peaks, width }: { peaks: number[]; width: number }) {
  if (peaks.length === 0) return null;
  const h = 40;
  const d = peaks.map((p, i) => `M${(i / peaks.length) * width},${h / 2 - p * h * 0.48}V${h / 2 + p * h * 0.48}`).join('');
  return (
    <svg className="wave" width={width} height={h}>
      <path d={d} stroke="currentColor" strokeWidth={Math.max(1, width / peaks.length)} />
    </svg>
  );
}

/** "1:23.4"・"83.4"・"83" を秒に。読めなければ null */
function parseTime(text: string): number | null {
  const m = text.trim().match(/^(?:(\d+):)?(\d+(?:\.\d*)?)$/);
  if (!m) return null;
  return (m[1] ? Number(m[1]) * 60 : 0) + Number(m[2]);
}

/** 時刻の表示。クリックすると数字を入れられる（Enter で決定、Esc でやめる） */
const FPS = 30;

// Timeline の再生・キー移動のアイコン（Premiere・Resolve の形に合わせる）。どれも高さ 12 の箱で、上下の真ん中は 6
const TICONS: Record<string, { w: number; d: React.ReactNode }> = {
  start: { w: 14, d: <><rect x="1" y="1" width="1.8" height="10" /><path d="M8 1 L3 6 L8 11Z M13 1 L8 6 L13 11Z" /></> },
  prevFrame: { w: 12, d: <><rect x="1.5" y="1" width="1.8" height="10" /><path d="M10.5 1 L4.5 6 L10.5 11Z" /></> },
  play: { w: 11, d: <path d="M1 0.5 L10.5 6 L1 11.5Z" /> },
  pause: { w: 11, d: <><rect x="1.5" y="1" width="2.6" height="10" /><rect x="6.9" y="1" width="2.6" height="10" /></> },
  stop: { w: 11, d: <rect x="1" y="1" width="9" height="10" rx="0.6" /> },
  nextFrame: { w: 12, d: <><path d="M1.5 1 L7.5 6 L1.5 11Z" /><rect x="8.7" y="1" width="1.8" height="10" /></> },
  prevKey: { w: 20, d: <><path d="M6 2 L1 6 L6 10Z" /><path d="M13 1 L18 6 L13 11 L8 6Z" /></> },
  nextKey: { w: 20, d: <><path d="M7 1 L12 6 L7 11 L2 6Z" /><path d="M14 2 L19 6 L14 10Z" /></> },
  playToKey: { w: 22, d: <><path d="M1 1 L9 6 L1 11Z" /><path d="M16 1 L21 6 L16 11 L11 6Z" /></> },
};
const HELP_ROWS: [keyof typeof TICONS | null, string, string][] = [
  ['start', 'Jump to Start', ''],
  ['prevFrame', 'Previous Frame (1/30 s)', '←'],
  ['play', 'Play / Pause', ''],
  ['nextFrame', 'Next Frame (1/30 s)', '→'],
  ['prevKey', 'Previous Keyframe', '↑'],
  ['nextKey', 'Next Keyframe', '↓'],
  ['playToKey', 'Play to Next Keyframe', ''],
  [null, 'Delete selected keyframe or tracks', 'Delete / Backspace'],
  [null, 'Select more tracks', 'Shift / ⌘ + click name'],
  [null, 'Rename track', 'Double-click name'],
  [null, 'Undo / Redo', '⌘Z / ⇧⌘Z'],
  [null, 'Zoom In / Out', '= / −'],
  [null, 'Zoom to whole timeline', '\\'],
  [null, 'Zoom with the mouse wheel', '⌥ + scroll'],
  [null, 'Zoom with the bar under the timeline', 'Drag its ends'],
];
export function TIcon({ name }: { name: keyof typeof TICONS }) {
  const ic = TICONS[name];
  return (
    <svg width={ic.w} height="12" viewBox={`0 0 ${ic.w} 12`} fill="currentColor" aria-hidden="true">
      {ic.d}
    </svg>
  );
}

function TimeField({ value, label, onCommit }: { value: number; label: string; onCommit: (t: number) => void }) {
  const [text, setText] = useState<string | null>(null);
  const done = (ok: boolean) => {
    if (ok && text !== null) {
      const t = parseTime(text);
      if (t !== null) onCommit(t);
    }
    setText(null);
  };
  if (text === null)
    return (
      <button className="tl-timefield" onClick={() => setText(fmt(value))} aria-label={`${label}: ${fmt(value)} (click to edit)`} title="Click to type a time (m:ss.s or seconds)">
        {fmt(value)}
      </button>
    );
  return (
    <input
      className="tl-timeinput"
      autoFocus
      value={text}
      aria-label={label}
      onChange={(e) => setText(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={() => done(true)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') done(true);
        if (e.key === 'Escape') done(false);
      }}
    />
  );
}

/** 演出の印（キーの◆の上に出す） */
const FX_MARKS: Record<string, string> = { strobe: '\u03DF', chase: '\u2192', pulse: '\u223F', flicker: '\u2736', rainbow: '\u25D0', wave: '\u2248' };

export function TimelinePanel({ api, lights, selected, currentLook, groupName, onHighlight, onSelectLights, Wave }: Props) {
  const { tl, setTl, time, playing, media } = api;
  const [pps, setPps] = useState(40);
  // ？ボタンで開く、ボタンとキーの説明（押すか Esc で閉じる）
  const [help, setHelp] = useState(false);
  // HSV の変化カーブを重ねて見せる。この端末に覚えておく
  const [hsv, setHsv] = useState(() => {
    try {
      return localStorage.getItem('miseru.tlHsv') === '1';
    } catch {
      return false;
    }
  });
  const [tlH, setTlH] = useState<number | null>(() => {
    try {
      const v = Number(localStorage.getItem('miseru.tlH'));
      return v > 0 ? v : null;
    } catch {
      return null;
    }
  });
  const resizeTl = (h: number | null) => {
    setTlH(h);
    try {
      if (h) localStorage.setItem('miseru.tlH', String(h));
      else localStorage.removeItem('miseru.tlH');
    } catch {
      // 保存できなくても使える
    }
  };
  const toggleHsv = () =>
    setHsv((v) => {
      try {
        localStorage.setItem('miseru.tlHsv', v ? '0' : '1');
      } catch {
        /* 覚えられなくても動く */
      }
      return !v;
    });
  useEffect(() => {
    if (!help) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setHelp(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [help]);
  const [sel, setSel] = useState<{ track: string; index: number } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // 名前の列の幅: ふだんは一番長いトラック名が入る幅に自動で合わせる。
  // Time の右端の仕切りをドラッグすると手で決めた幅になり（この端末に覚える）、ダブルクリックで自動に戻る
  const [manualW, setManualW] = useState<number | null>(() => {
    try {
      const v = Number(localStorage.getItem(LABEL_KEY));
      return v >= 60 ? v : null;
    } catch {
      return null;
    }
  });
  const autoW = (() => {
    if (typeof document === 'undefined') return LABEL_W;
    const ctx = document.createElement('canvas').getContext('2d');
    if (!ctx) return LABEL_W;
    ctx.font = `13px ${getComputedStyle(document.body).fontFamily}`;
    const widest = Math.max(ctx.measureText('Audio').width, ...tl.tracks.map((t) => ctx.measureText(t.name).width));
    return Math.round(Math.max(LABEL_W, Math.min(260, widest + 20)));
  })();
  const labelW = manualW ?? autoW;
  const saveLabelW = (w: number | null) => {
    const c = w === null ? null : Math.round(Math.max(60, Math.min(260, w)));
    setManualW(c);
    try {
      if (c === null) localStorage.removeItem(LABEL_KEY);
      else localStorage.setItem(LABEL_KEY, String(c));
    } catch {
      /* 覚えられなくても動く */
    }
  };
  const startLabelDrag = (e: React.PointerEvent<HTMLSpanElement>) => {
    e.stopPropagation();
    e.preventDefault();
    const x0 = e.clientX;
    const w0 = labelW;
    const move = (ev: PointerEvent) => saveLabelW(w0 + ev.clientX - x0);
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  // トラックの名前: 押すとそのトラックの照明を天井図で目立たせる。ダブルクリックで名前を変える
  // Shift / ⌘ / Ctrl を押しながら押すと複数選べる（まとめて消せる）
  const [hlTracks, setHlTracks] = useState<string[]>([]);
  const [renaming, setRenaming] = useState<string | null>(null);
  const clickTimer = useRef(0);
  // 目立たせていたトラックが消えたら（キーが無くなって自動で消えたときなど）目立たせも解除
  useEffect(() => {
    const alive = hlTracks.filter((id) => tl.tracks.some((t) => t.id === id));
    if (alive.length !== hlTracks.length) {
      setHlTracks(alive);
      onHighlight?.(alive.length ? tl.tracks.filter((t) => alive.includes(t.id)).flatMap((t) => t.lightIds) : null);
    }
    if (sel && !tl.tracks.some((t) => t.id === sel.track)) setSel(null);
  }, [tl.tracks]); // eslint-disable-line react-hooks/exhaustive-deps
  const hlRef = useRef<string[]>([]);
  hlRef.current = hlTracks;
  /** トラックを丸ごと消す（複数でも。キーが合わせて 2 つ以上あるときは確かめる） */
  const deleteTracks = (ids: string[]) => {
    const trs = tl.tracks.filter((x) => ids.includes(x.id));
    if (trs.length === 0) return;
    const nKeys = trs.reduce((n, t) => n + t.keys.length, 0);
    const what = trs.length === 1 ? `track "${trs[0].name}"` : `${trs.length} tracks`;
    if (nKeys > 1 && !ask(`Delete ${what} and ${nKeys} keyframes?`)) return;
    setTl((c) => ({ ...c, tracks: c.tracks.filter((x) => !ids.includes(x.id)) }));
    if (sel && ids.includes(sel.track)) setSel(null);
    setHlTracks([]);
    onHighlight?.(null);
  };
  const deleteTrack = deleteTracks;
  const deleteTrackRef = useRef(deleteTrack);
  deleteTrackRef.current = deleteTrack;
  // 画面を出入りしたときに天井図の目立たせが残らないよう、出るときと入るときに消す
  const hlOff = useRef(onHighlight);
  hlOff.current = onHighlight;
  useEffect(() => {
    hlOff.current?.(null);
    return () => hlOff.current?.(null);
  }, []);
  const toggleHighlight = (track: Track, add: boolean) => {
    const on = hlTracks.includes(track.id);
    const next = add ? (on ? hlTracks.filter((id) => id !== track.id) : [...hlTracks, track.id]) : on && hlTracks.length === 1 ? [] : [track.id];
    // 名前を押したらキーの選択は外す（Delete Track が出るように）
    setSel(null);
    setHlTracks(next);
    const ids = [...new Set(tl.tracks.filter((t) => next.includes(t.id)).flatMap((t) => t.lightIds))];
    onHighlight?.(next.length ? ids : null);
    // 天井図の選択も、選んだトラックの照明に切り替える
    if (next.length) onSelectLights?.(ids);
  };
  const width = Math.max(300, tl.duration * pps);
  // 明るさだけの照明だけのトラックは、キーの色をいつも Cool White で見せる（天井図と同じ）
  const keyRgb = (track: { lightIds: string[] }, look: Parameters<typeof displayRgb>[0]) =>
    track.lightIds.length > 0 && track.lightIds.every((id) => ((l) => !!l && isWhiteOnly(l.typeId))(lights.find((l) => l.id === id))) ? FIXED_WHITE : displayRgb(look);
  const nameOf = (id: string) => ((l) => (l ? lightLabel(l) : id))(lights.find((l) => l.id === id));

  const selTrack = tl.tracks.find((t) => t.id === sel?.track);
  const selKey = selTrack && sel ? selTrack.keys[sel.index] : undefined;

  // 選んだキーは Delete / Backspace キーでも消せる（入力欄に書いているときは除く）
  const selRef = useRef(sel);
  selRef.current = sel;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const cur = selRef.current;
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (!cur) {
        // キーを選んでいなくて、トラックの名前を押して選んでいるときはトラックを消す
        if (hlRef.current.length) {
          e.preventDefault();
          deleteTrackRef.current(hlRef.current);
        }
        return;
      }
      e.preventDefault();
      setTl((c) => ({ ...c, tracks: c.tracks.map((tr) => (tr.id === cur.track ? removeKey(tr, cur.index) : tr)) }));
      setSel(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setTl]);

  const replaceTrack = (id: string, f: (t: Track) => Track, group?: string) =>
    setTl((cur) => ({ ...cur, tracks: cur.tracks.map((t) => (t.id === id ? f(t) : t)) }), group ? { group } : undefined);

  // 今の位置に、選んでいる照明のキーが既にあるか（あれば Insert は上書きになる）
  const tHere = Math.round(time * 20) / 20;
  const overwrites = !!tl.tracks.find((tr) => sameSet(tr.lightIds, selected))?.keys.some((k) => Math.abs(k.t - tHere) <= 0.02);

  // 新しいトラックの名前: 「Selection」は必ず #1, #2… を付け、ほかの名前も同じ名前があれば #2, #3… を付ける
  const uniqueName = (base: string) => {
    const names = new Set(tl.tracks.map((t) => t.name));
    if (base !== 'Selection' && !names.has(base)) return base;
    let n = 1;
    while (names.has(`${base} #${n}`) || (n === 1 && base !== 'Selection' && names.has(base))) n++;
    return `${base} #${n}`;
  };

  // Insert できないときの警告（数秒で消える）
  const [warn, setWarn] = useState<string | null>(null);
  const warnTimer = useRef(0);
  const showWarn = (text: string) => {
    setWarn(text);
    window.clearTimeout(warnTimer.current);
    warnTimer.current = window.setTimeout(() => setWarn(null), 6000);
  };

  const addKeyHere = () => {
    if (!currentLook || selected.length === 0) return;
    const t = Math.round(time * 20) / 20;
    const existing = tl.tracks.find((tr) => sameSet(tr.lightIds, selected));
    // 同じ照明を 2 つのトラックに入れない（下のトラックが上を丸ごと上書きしてしまうため）。入れようとしたら警告して打たない
    if (!existing) {
      const clash = tl.tracks.filter((tr) => tr.lightIds.some((id) => selected.includes(id)));
      if (clash.length > 0) {
        const ids = [...new Set(clash.flatMap((tr) => tr.lightIds.filter((id) => selected.includes(id))))];
        showWarn(`${ids.map(nameOf).join(', ')} already in ${clash.map((tr) => `"${tr.name}"`).join(', ')}. Select exactly that track's fixtures, or delete it first.`);
        return;
      }
    }
    setWarn(null);
    const track: Track = existing ?? {
      id: `t${Date.now().toString(36)}`,
      name: uniqueName(groupName(selected)),
      lightIds: [...selected],
      keys: [],
    };
    const next = addKey(track, { t, look: { ...currentLook }, curve: 'linear' });
    setTl((cur) => ({ ...cur, tracks: existing ? cur.tracks.map((x) => (x.id === track.id ? next : x)) : [...cur.tracks, next] }));
    setSel({ track: track.id, index: next.keys.findIndex((k) => Math.abs(k.t - t) < 0.03) });
  };

  // キーの◆をダブルクリック（指ではダブルタップ）すると、再生位置をそのキーへ。
  // iPhone は touch-action: none の要素で dblclick が来ないことがあるので、押した時刻で自分で数える
  const lastKeyTap = useRef<{ id: string; at: number } | null>(null);
  const startDrag = (e: React.PointerEvent, track: Track, clicked: number) => {
    e.stopPropagation();
    // 近いキーは押せる範囲が重なるので、押した位置にいちばん近いキーを選ぶ（重なった後ろのキーが取られていた）
    const laneEl = (e.currentTarget as HTMLElement).parentElement;
    let index = clicked;
    if (laneEl) {
      const tp = (e.clientX - laneEl.getBoundingClientRect().left) / pps;
      let best = Infinity;
      track.keys.forEach((k, j) => {
        const d = Math.abs(k.t - tp);
        if (d < best) {
          best = d;
          index = j;
        }
      });
    }
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setSel({ track: track.id, index });
    const x0 = e.clientX;
    const t0 = track.keys[index].t;
    const tapId = `${track.id}#${index}`;
    const now = e.timeStamp;
    if (lastKeyTap.current && lastKeyTap.current.id === tapId && now - lastKeyTap.current.at < 400) {
      lastKeyTap.current = null;
      api.seek(t0);
      return;
    }
    lastKeyTap.current = { id: tapId, at: now };
    // 1 回のドラッグは、取り消し 1 回分にまとめる
    const group = `drag-${track.id}-${Date.now()}`;
    const move = (ev: PointerEvent) => {
      const t = Math.round((t0 + (ev.clientX - x0) / pps) * 20) / 20;
      replaceTrack(track.id, (tr) => moveKey(tr, index, t, tl.duration), group);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // 時間の列を押したらその位置へ。押したまま動かすと再生位置がついてくる（スクラブ）。
  // 動かしている間は画面の再描画 1 回につき 1 回だけ位置を変える（照明への送信も間引かれてカクつかない）
  const scrubRaf = useRef(0);
  const scrubX = useRef(0);
  const seekFromPointer = (e: React.PointerEvent<HTMLDivElement>) => {
    const lane = e.currentTarget;
    const rect = lane.getBoundingClientRect();
    const toTime = (x: number) => Math.max(0, (x - rect.left) / pps);
    api.seek(toTime(e.clientX));
    lane.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      scrubX.current = ev.clientX;
      if (scrubRaf.current) return;
      scrubRaf.current = requestAnimationFrame(() => {
        scrubRaf.current = 0;
        api.seek(toTime(scrubX.current));
      });
    };
    const up = () => {
      lane.removeEventListener('pointermove', move);
      lane.removeEventListener('pointerup', up);
      lane.removeEventListener('pointercancel', up);
      if (scrubRaf.current) {
        cancelAnimationFrame(scrubRaf.current);
        scrubRaf.current = 0;
        api.seek(toTime(scrubX.current));
      }
    };
    scrubX.current = e.clientX;
    lane.addEventListener('pointermove', move);
    lane.addEventListener('pointerup', up);
    lane.addEventListener('pointercancel', up);
  };

  // 保存: 曲を読み込んでいれば曲ごと 1 つの .miseru に、なければ Timeline だけの .miseru.json に。
  // 保存先を選べるブラウザ（Mac の Chrome など）では、Box や iCloud Drive のフォルダを選べる
  const exportJson = async () => {
    const base = (tl.name || 'miseru').replace(/[\\/:*?"<>|]/g, '_');
    let blob: Blob;
    let filename: string;
    if (media) {
      const bytes = new Uint8Array(await media.file.arrayBuffer());
      blob = new Blob([encodeShowFile(tl, { name: media.name, type: media.file.type, bytes }) as BlobPart], { type: 'application/octet-stream' });
      filename = `${base}.miseru`;
    } else {
      blob = new Blob([JSON.stringify(tl, null, 2)], { type: 'application/json' });
      filename = `${base}.miseru.json`;
    }
    const picker = (window as unknown as { showSaveFilePicker?: (o: { suggestedName: string }) => Promise<{ createWritable: () => Promise<{ write: (b: Blob) => Promise<void>; close: () => Promise<void> }> }> }).showSaveFilePicker;
    if (picker) {
      try {
        const handle = await picker({ suggestedName: filename });
        const w = await handle.createWritable();
        await w.write(blob);
        await w.close();
        return;
      } catch (e) {
        if ((e as { name?: string }).name === 'AbortError') return;
        // 選べなければふつうのダウンロードにする
      }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  // 開く: .miseru（曲つき）も .miseru.json（Timeline だけ）も開ける
  const importJson = async (file: File) => {
    const show = decodeShowFile(new Uint8Array(await file.arrayBuffer()));
    if (!show) {
      window.alert('Could not open this file. Choose a .miseru or .miseru.json file.');
      return;
    }
    setTl(show.timeline);
    requestFitAll();
    setSel(null);
    if (show.media) await api.loadMedia(new File([show.media.bytes as BlobPart], show.media.name, { type: show.media.type }));
    api.seek(0);
  };

  // 前・次のキーへ（全トラックのキーの時刻から探す）
  const keyTimes = [...new Set(tl.tracks.flatMap((tr) => tr.keys.map((k) => k.t)))].sort((a, b) => a - b);
  const jumpKey = (dir: -1 | 1) => {
    const t = dir < 0 ? [...keyTimes].reverse().find((k) => k < time - 0.001) : keyTimes.find((k) => k > time + 0.001);
    if (t !== undefined) api.seek(t);
  };

  // 1 フレーム（1/30 秒）ずつ動かす
  const stepFrame = (dir: -1 | 1) => {
    const f = Math.round(time * FPS) + dir;
    api.seek(Math.min(tl.duration, Math.max(0, f / FPS)));
  };

  // ← → で 1 フレーム、↑ ↓ で前・次のキーへ（入力欄・選択欄・スライダーを触っているときは除く）
  const navRef = useRef({ stepFrame, jumpKey });
  navRef.current = { stepFrame, jumpKey };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const dir = e.key === 'ArrowLeft' ? 'f-' : e.key === 'ArrowRight' ? 'f+' : e.key === 'ArrowUp' ? 'k-' : e.key === 'ArrowDown' ? 'k+' : null;
      if (!dir) return;
      // 仕切り（天井図の高さ・横並びの幅）などがキーを使ったときは、再生位置を動かさない
      if (e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t && t.closest('[role="separator"], .splitter, .col-splitter')) return;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      e.preventDefault();
      if (dir === 'f-') navRef.current.stepFrame(-1);
      else if (dir === 'f+') navRef.current.stepFrame(1);
      else navRef.current.jumpKey(dir === 'k-' ? -1 : 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // 一番後ろのキー（キーが無ければ全体の長さ）までがちょうど見える倍率にする
  const fitKeys = () => {
    const el = scrollRef.current;
    if (!el) return;
    const last = keyTimes.length > 0 ? keyTimes[keyTimes.length - 1] : tl.duration;
    const avail = el.clientWidth - labelW - LANE_X0 - 28;
    if (last <= 0 || avail <= 0) return;
    setPps(Math.min(200, Math.max(8, avail / last)));
    el.scrollLeft = 0;
  };
  // 0 から最後のフレーム（タイムラインの長さ）までがちょうど見える倍率にする
  const fitAll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const avail = el.clientWidth - labelW - LANE_X0 - 28;
    if (tl.duration <= 0 || avail <= 0) return;
    setPps(Math.min(200, Math.max(1, avail / tl.duration)));
    el.scrollLeft = 0;
  };

  // キーを作った・開いたあとは全体（All）を見せる。印が立っていて枠に幅があるときだけ 1 回かける
  useEffect(() => {
    if (fitAllWanted && (scrollRef.current?.clientWidth ?? 0) > 0) {
      fitAllWanted = false;
      fitAll();
    }
  });

  // ズームは Premiere にそろえる: 枠の下のズームバーの両端をドラッグして拡大・縮小、
  // 真ん中をドラッグして横に送る。= と - で再生位置を中心に拡大・縮小、\\ で全体、⌥ + ホイールでマウスの位置を中心に。
  const PPS_MIN = 1;
  const PPS_MAX = 400;
  /** 倍率を変えたあとに合わせる横の送り（描き直してから当てる） */
  const pendingScroll = useRef<number | null>(null);
  const [view, setView] = useState({ left: 0, w: 0 });
  const readView = () => {
    const el = scrollRef.current;
    if (!el) return;
    // 端数で毎回少しずつ違う値にならないよう、整数にそろえてから比べる
    const left = Math.round(el.scrollLeft);
    const w = Math.round(el.clientWidth - labelW - LANE_X0);
    // 同じ値なら前のものを返して描き直さない（毎回の描画の後に読むので、新しいオブジェクトにすると止まらなくなる）
    setView((v) => (v.left === left && v.w === w ? v : { left, w }));
  };
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && pendingScroll.current !== null) {
      el.scrollLeft = Math.max(0, pendingScroll.current);
      pendingScroll.current = null;
    }
    readView();
    // 倍率・長さ・名前の列の幅が変わったときだけ（毎回の描画のたびに読むと止まらなくなることがある）。ほかは onScroll と ResizeObserver で読む
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pps, tl.duration, labelW]);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => readView());
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  /** 画面の x（レーンの左端から）にある時刻を動かさずに倍率を変える */
  const zoomAt = (next: number, anchorX: number) => {
    const el = scrollRef.current;
    if (!el) return;
    const p = Math.min(PPS_MAX, Math.max(PPS_MIN, next));
    const t = (el.scrollLeft + anchorX) / pps;
    pendingScroll.current = t * p - anchorX;
    setPps(p);
  };
  const zoomAtPlayhead = (factor: number) => {
    const el = scrollRef.current;
    if (!el) return;
    const vw = el.clientWidth - labelW - LANE_X0;
    const x = time * pps - el.scrollLeft;
    zoomAt(pps * factor, x >= 0 && x <= vw ? x : vw / 2);
  };
  const zoomRef = useRef({ zoomAtPlayhead, fitAll });
  zoomRef.current = { zoomAtPlayhead, fitAll };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (e.key === '=' || e.key === '+') zoomRef.current.zoomAtPlayhead(1.5);
      else if (e.key === '-' || e.key === '_') zoomRef.current.zoomAtPlayhead(1 / 1.5);
      else if (e.key === '\\') zoomRef.current.fitAll();
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const wheelRef = useRef<(e: WheelEvent) => void>(() => {});
  wheelRef.current = (e: WheelEvent) => {
    if (!e.altKey) return;
    const el = scrollRef.current;
    if (!el) return;
    e.preventDefault();
    const x = e.clientX - el.getBoundingClientRect().left - labelW - LANE_X0;
    zoomAt(pps * Math.exp(-(e.deltaY || e.deltaX) * 0.004), Math.max(0, x));
  };
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const h = (e: WheelEvent) => wheelRef.current(e);
    el.addEventListener('wheel', h, { passive: false });
    return () => el.removeEventListener('wheel', h);
  }, []);
  // ズームバー: 0 秒〜全体の長さを横いっぱいに。つまみは今見えている範囲
  const barRef = useRef<HTMLDivElement>(null);
  const dur = Math.max(0.001, tl.duration);
  const vStart = Math.min(dur, view.left / pps);
  const vEnd = Math.min(dur, (view.left + Math.max(0, view.w)) / pps);
  const startBarDrag = (e: React.PointerEvent, part: 'move' | 'start' | 'end') => {
    const bar = barRef.current;
    const el = scrollRef.current;
    if (!bar || !el) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = bar.getBoundingClientRect();
    const x0 = e.clientX;
    const s0 = vStart;
    const e0 = vEnd;
    const vw = el.clientWidth - labelW - LANE_X0;
    const secPerPx = dur / rect.width;
    const minSpan = vw / PPS_MAX;
    const move = (ev: PointerEvent) => {
      const dt = (ev.clientX - x0) * secPerPx;
      if (part === 'move') {
        el.scrollLeft = Math.max(0, (s0 + dt) * pps);
        readView();
        return;
      }
      // 端は指・マウスの位置の時刻にそのまま合わせる（つまみの最小幅で見た目と時刻がずれていても跳ばない）
      const tAt = Math.min(dur, Math.max(0, ((ev.clientX - rect.left) / rect.width) * dur));
      let a = s0;
      let b = e0;
      if (part === 'start') a = Math.max(0, Math.min(b - minSpan, tAt));
      else b = Math.min(dur, Math.max(a + minSpan, tAt));
      const p = Math.min(PPS_MAX, Math.max(PPS_MIN, vw / (b - a)));
      pendingScroll.current = a * p;
      setPps(p);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  const ticks: number[] = [];
  const stepSec = pps >= 60 ? 1 : pps >= 25 ? 2 : pps >= 12 ? 5 : 10;
  for (let s = 0; s <= tl.duration; s += stepSec) ticks.push(s);

  return (
    <div className="timeline">
      {help && createPortal(
        <div className="tl-help" role="dialog" aria-label="Timeline controls" onClick={() => setHelp(false)}>
          <div className="tl-help-box">
            <div className="tl-help-title">Timeline Controls</div>
            <table>
              <tbody>
                {HELP_ROWS.map(([ic, name, key]) => (
                  <tr key={name}>
                    <td className="ic">{ic ? <TIcon name={ic} /> : null}</td>
                    <td>{name}</td>
                    <td className="tl-help-keys">{key}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="tl-help-note">Click anywhere or press Esc to close</div>
          </div>
        </div>,
        document.body,
      )}
      <div className="tl-bar">
        {/* 再生の組（Premiere と同じ並び）: 先頭へ・1 フレーム戻る・再生・1 フレーム進む */}
        <span className="tl-transport" role="group" aria-label="Transport">
          <button className="tl-btn tl-ic" onClick={api.stop} aria-label="Jump to Start" title="Jump to Start">
            <TIcon name="start" />
          </button>
          <button className="tl-btn tl-ic" onClick={() => stepFrame(-1)} disabled={time <= 0} aria-label="Previous Frame" title="Previous Frame (←)">
            <TIcon name="prevFrame" />
          </button>
          <button className="tl-btn tl-ic tl-ic-text play" onClick={playing ? api.pause : api.play} aria-label={playing ? 'Pause' : 'Play'} title={playing ? 'Pause' : 'Play'}>
            <TIcon name={playing ? 'pause' : 'play'} />
            {playing ? 'Pause' : 'Play'}
          </button>
          <button className="tl-btn tl-ic" onClick={() => stepFrame(1)} disabled={time >= tl.duration} aria-label="Next Frame" title="Next Frame (→)">
            <TIcon name="nextFrame" />
          </button>
        </span>
        {/* キーの組: 前のキーへ・次のキーへ・次のキーまで再生 */}
        <span className="tl-transport" role="group" aria-label="Keyframes">
          <button className="tl-btn tl-ic" onClick={() => jumpKey(-1)} disabled={keyTimes.every((t) => t >= time - 0.001)} aria-label="Previous Keyframe" title="Previous Keyframe (↑)">
            <TIcon name="prevKey" />
          </button>
          <button className="tl-btn tl-ic" onClick={() => jumpKey(1)} disabled={keyTimes.every((t) => t <= time + 0.001)} aria-label="Next Keyframe" title="Next Keyframe (↓)">
            <TIcon name="nextKey" />
          </button>
          <button
            className="tl-btn tl-ic tl-ic-text"
            onClick={() => {
              const next = keyTimes.find((k) => k > time + 0.001);
              if (next !== undefined) api.playUntil(next);
            }}
            disabled={playing || keyTimes.every((t) => t <= time + 0.001)}
            aria-label="Play to Next Keyframe"
            title="Play to Next Keyframe"
          >
            <TIcon name="playToKey" />
            Play to Key
          </button>
        </span>
        <button className={hsv ? 'tl-btn tl-hsv-btn on' : 'tl-btn tl-hsv-btn'} onClick={toggleHsv} aria-pressed={hsv} title="Show Hue, Saturation and Value curves in taller rows">
          HSV
        </button>
        <button className="tl-btn tl-ic tl-help-btn" onClick={() => setHelp(true)} aria-label="Timeline controls help" title="Controls and shortcuts">
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1.3" />
            <text x="8" y="11.6" textAnchor="middle" fontSize="10.5" fontWeight="600" fill="currentColor" fontFamily="system-ui, -apple-system, sans-serif">?</text>
          </svg>
        </button>
        <span className="tl-time">
          <TimeField value={time} label="Current time" onCommit={(t) => api.seek(Math.min(tl.duration, t))} />
          {' / '}
          <TimeField value={tl.duration} label="Duration" onCommit={(t) => setTl((c) => ({ ...c, duration: Math.min(3600, Math.max(1, t)) }))} />
        </span>
        <label className="tl-check">
          <input type="checkbox" checked={tl.loop} onChange={(e) => setTl((c) => ({ ...c, loop: e.target.checked }))} /> Loop
        </label>
        <span className="tl-zoom">
          <button className="tl-btn small" onClick={fitKeys} data-fit="" title="Zoom to fit the keyframes, from 0 to the last keyframe" aria-label="Zoom to fit the keyframes">
            Fit
          </button>
          <button className="tl-btn small" onClick={fitAll} data-fit="" title="Zoom to show the whole timeline, from 0 to the last frame" aria-label="Zoom to show the whole timeline">
            All
          </button>
        </span>
      </div>

      {/* キーの追加とファイルの段は Play の段のすぐ下 */}
      <div className="tl-bar">
        <button className="tl-btn primary-ish" disabled={selected.length === 0} onClick={addKeyHere}>
          {overwrites ? <><span className="ico redo">{'\u21BB'}</span> Overwrite Keyframe</> : <><span className="ico diamond">{'\u25C6'}</span> Insert Keyframe</>}
        </button>
        {warn && (
          <span className="tl-warn" role="alert">
            {warn}
          </span>
        )}
        {hlTracks.length > 0 && !selKey && (
          <button className="tl-btn danger" onClick={() => deleteTracks(hlTracks)} title="Delete the selected tracks (Delete key)">
            {hlTracks.length > 1 ? `Delete ${hlTracks.length} Tracks` : 'Delete Track'}
          </button>
        )}
        {selKey && sel && (
          <>
            <label className="tl-check">
              Interpolation
              <select
                value={curveKey(selKey.curve)}
                onChange={(e) => replaceTrack(sel.track, (tr) => updateKey(tr, sel.index, { curve: e.target.value as Curve }))}
              >
                {curveNames.map((c) => (
                  <option key={c} value={c}>{curveLabel[c]}</option>
                ))}
                {curveKey(selKey.curve) === 'custom' && <option value="custom">Custom</option>}
              </select>
            </label>
            <button className="tl-btn" onClick={() => api.seek(selKey.t)}>Jump to Keyframe</button>
            <button className="tl-btn danger" onClick={() => { replaceTrack(sel.track, (tr) => removeKey(tr, sel.index)); setSel(null); }}>
              Delete Keyframe
            </button>
          </>
        )}
      </div>

      <div className="tl-bar subtle">
        <button className="tl-btn" onClick={() => fileRef.current?.click()}><span className="ico note">♪</span> Load Audio/Video…</button>
        {media && (
          <>
            <span className="tl-time">{media.name}</span>
            <button className="tl-btn small" onClick={api.clearMedia}>Remove</button>
          </>
        )}
        <input ref={fileRef} type="file" accept="audio/*,video/*" hidden onChange={(e) => e.target.files?.[0] && api.loadMedia(e.target.files[0])} />
        <button className="tl-btn" onClick={() => void exportJson()} title={media ? 'Save the timeline and the audio as one .miseru file' : 'Save the timeline as .miseru.json'}>Save As…</button>
        <button className="tl-btn" onClick={() => importRef.current?.click()}>Open…</button>
        {!isBox && <Presets hasKeys={tl.tracks.length > 0} open={importJson} />}
        <input ref={importRef} type="file" hidden onChange={(e) => e.target.files?.[0] && importJson(e.target.files[0])} />
        <button className="tl-btn danger" onClick={() => { if (ask('Delete all keyframes in this timeline?')) { setTl({ ...tl, tracks: [] }); setSel(null); } }}>
          Clear All
        </button>
      </div>

      <div className="tl-scroll" ref={scrollRef} onScroll={readView} style={tlH ? { maxHeight: tlH, overflowY: 'auto' } : undefined}>
        <div className="tl-inner" style={{ width: width + labelW + LANE_X0, '--tl-label-w': `${labelW}px` } as React.CSSProperties}>
          <div className="tl-row ruler">
            <div className="tl-label">
              Time
              <span
                className="tl-label-grip"
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize track names"
                title="Drag to resize · double-click to reset"
                onPointerDown={startLabelDrag}
                onDoubleClick={() => saveLabelW(null)}
              />
            </div>
            <div className="tl-lane" style={{ width }} onPointerDown={seekFromPointer}>
              {ticks.map((s) => (
                <span key={s} className="tick" style={{ left: s * pps }}>{s}</span>
              ))}
            </div>
          </div>
          {media && (
            <div className="tl-row">
              <div className="tl-label">{media.isVideo ? 'Video' : 'Audio'}</div>
              <div className="tl-lane" style={{ width }} onPointerDown={seekFromPointer}>
                {/* ウェブ版は Music Analysis と同じ区間の色で塗った波形（App から渡す。箱には入れない） */}
                {import.meta.env.MODE !== 'box' && Wave ? (
                  <Wave media={media} width={Math.min(width, tl.duration * pps)} />
                ) : (
                  <Waveform peaks={media.peaks} width={Math.min(width, (tl.duration * pps))} />
                )}
              </div>
            </div>
          )}
          {tl.tracks.map((track) => (
            <div className={hsv ? 'tl-row tl-row-hsv' : 'tl-row'} key={track.id}>
              {renaming === track.id ? (
                <div className="tl-label editing">
                  <input
                    className="tl-rename"
                    defaultValue={track.name}
                    autoFocus
                    aria-label="Track name"
                    onFocus={(e) => e.currentTarget.select()}
                    onBlur={(e) => {
                      const name = e.currentTarget.value.trim();
                      if (name) replaceTrack(track.id, (tr) => ({ ...tr, name }));
                      setRenaming(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') e.currentTarget.blur();
                      if (e.key === 'Escape') setRenaming(null);
                    }}
                  />
                </div>
              ) : (
                <div
                  className={hlTracks.includes(track.id) ? 'tl-label hl' : 'tl-label'}
                  title={`${track.lightIds.map(nameOf).join(', ')} — click to select, Shift/⌘-click to add, double-click to rename`}
                  onClick={(e) => {
                    // ダブルクリックの 1 回目で目立たせが切り替わらないよう、少し待ってから
                    const add = e.shiftKey || e.metaKey || e.ctrlKey;
                    window.clearTimeout(clickTimer.current);
                    clickTimer.current = window.setTimeout(() => toggleHighlight(track, add), 220);
                  }}
                  onDoubleClick={() => {
                    window.clearTimeout(clickTimer.current);
                    setRenaming(track.id);
                  }}
                >
                  <span className="tl-name">{track.name}</span>
                  {hsv && (
                    <span className="tl-hsv-bands" aria-hidden="true">
                      <span>Hue</span>
                      <span>Sat</span>
                      <span>Value</span>
                    </span>
                  )}
                </div>
              )}
              <div className="tl-lane" style={{ width }} onPointerDown={seekFromPointer}>
                {hsv && track.keys.length > 1 && (() => {
                  // H・S・V を 4px おきに計る。H は 0〜360° を下から上、その点の色で描く。S は破線、V は白い線
                  const t0 = track.keys[0].t;
                  const t1 = track.keys[track.keys.length - 1].t;
                  const n = Math.max(2, Math.ceil(((t1 - t0) * pps) / 4));
                  const pts = Array.from({ length: n + 1 }, (_, i) => {
                    const t = t0 + ((t1 - t0) * i) / n;
                    return { x: t * pps, look: evaluateTrack(track, t)! };
                  });
                  // トラックの行を高くし、キーの段の下に Hue・Sat・Value を 1 段ずつ分けて描く
                  const BAND = 22;
                  const y = (band: number, v: number) => band * BAND + 3 + (1 - v) * (BAND - 6);
                  return (
                    <svg className="curve-hsv" width={width} height={BAND * 3} aria-hidden="true">
                      {[0, 1, 2].map((band) => (
                        <rect key={band} className="curve-hsv-band" x={0} y={band * BAND + 1} width={width} height={BAND - 2} />
                      ))}
                      {pts.slice(0, -1).map((p, i) => {
                        const q = pts[i + 1];
                        if (Math.abs(q.look.hue - p.look.hue) > 180) return null;
                        return <line key={i} className="curve-hsv-h" x1={p.x} y1={y(0, p.look.hue / 360)} x2={q.x} y2={y(0, q.look.hue / 360)} stroke={`hsl(${p.look.hue} 90% 60%)`} />;
                      })}
                      <polyline className="curve-hsv-s" points={pts.map((p) => `${p.x},${y(1, p.look.sat)}`).join(' ')} />
                      <polyline className="curve-hsv-v" points={pts.map((p) => `${p.x},${y(2, p.look.intensity)}`).join(' ')} />
                    </svg>
                  );
                })()}
                <svg className="curve-line" width={width} height={36}>
                  {track.keys.slice(0, -1).map((a, i) => {
                    const b = track.keys[i + 1];
                    const pts: string[] = [];
                    for (let s = 0; s <= 16; s++) {
                      const u = s / 16;
                      // キーの間の線は、変わり方（Ease In など）の形を見せる: 前のキーの高さから次のキーの高さへ。
                      // 明るさが同じでも形が分かるよう、差が小さいときは下から上への形で描く
                      const ya = 33 - a.look.intensity * 30;
                      const yb = 33 - b.look.intensity * 30;
                      const [y0, y1] = Math.abs(yb - ya) < 8 ? [30, 6] : [ya, yb];
                      const v = applyCurve(a.curve, u);
                      pts.push(`${(a.t + (b.t - a.t) * u) * pps},${y0 + (y1 - y0) * v}`);
                    }
                    return <polyline key={i} points={pts.join(' ')} />;
                  })}
                </svg>
                {track.keys.map((k, i) => (
                  <button
                    key={i}
                    // 明るさ 0 のキーは、黒の中に色の縁で「色は入っているが消えている」と見せる
                    className={`${sel?.track === track.id && sel.index === i ? 'key on' : 'key'}${k.look.intensity < 0.005 ? ' key-off' : ''}`}
                    style={
                      k.look.intensity < 0.005
                        ? { left: k.t * pps, background: '#000', borderColor: cssColor(keyRgb(track, k.look), 1) }
                        : { left: k.t * pps, background: cssColor(keyRgb(track, k.look), Math.max(0.3, k.look.intensity)) }
                    }
                    onPointerDown={(e) => startDrag(e, track, i)}
                    aria-label={`Keyframe at ${k.t.toFixed(1)} s${k.look.fx ? `, ${k.look.fx.kind}` : ''}`}
                  />
                ))}
                {/* 演出の入ったキー: ◆の上に演出の印、次のキーまでの区間の下に演出ごとの模様 */}
                {track.keys.map((k, i) =>
                  k.look.fx ? (
                    <span key={`fx${i}`} className="tl-fx-mark" style={{ left: k.t * pps }} aria-hidden="true" title={k.look.fx.kind}>
                      {FX_MARKS[k.look.fx.kind]}
                    </span>
                  ) : null,
                )}
                {track.keys.map((k, i) =>
                  k.look.fx ? (
                    <span
                      key={`fxb${i}`}
                      className={`tl-fx-band fx-${k.look.fx.kind}`}
                      style={{ left: k.t * pps, width: Math.max(2, ((track.keys[i + 1]?.t ?? tl.duration) - k.t) * pps) }}
                      aria-hidden="true"
                    />
                  ) : null,
                )}
              </div>
            </div>
          ))}
          {ticks.map((s) => (
            <span key={`g${s}`} className="tl-gridline" style={{ left: labelW + LANE_X0 + s * pps }} />
          ))}
          <div className="playhead" style={{ left: labelW + LANE_X0 + time * pps }} />
        </div>
      </div>

      <div className="tl-zoombar" ref={barRef} role="scrollbar" aria-orientation="horizontal" aria-label="Zoom and scroll the timeline" aria-valuenow={Math.round(vStart * 10) / 10} aria-valuemin={0} aria-valuemax={dur} style={{ marginLeft: labelW + LANE_X0 }}>
        <div
          className="tl-zoombar-thumb"
          style={{ left: `${(vStart / dur) * 100}%`, width: `${Math.max(0, ((vEnd - vStart) / dur) * 100)}%` }}
          onPointerDown={(e) => {
            // 端か真ん中かは押した位置で決める。つまみが細いとき（指で最小の幅）でも真ん中の 1/2 は必ず送りに残す
            const r = e.currentTarget.getBoundingClientRect();
            const zone = Math.min(e.pointerType === 'touch' ? 22 : 12, r.width / 4);
            const x = e.clientX - r.left;
            startBarDrag(e, x < zone ? 'start' : x > r.width - zone ? 'end' : 'move');
          }}
          title="Drag to scroll · drag the ends to zoom"
        >
          <span className="tl-zoombar-end start" />
          <span className="tl-zoombar-end end" />
        </div>
      </div>
      {/* タイムラインの枠の高さを上下のドラッグで変える。ダブルクリックで中身に合わせた高さに戻す */}
      <Splitter label="Resize timeline height" min={70} measure={() => scrollRef.current?.getBoundingClientRect().height ?? 200} onResize={resizeTl} onReset={() => resizeTl(null)} />
    </div>
  );
}

// キーを作った・開いたあとに Timeline を All 表示にする印（Music の Apply からも立てる）
let fitAllWanted = false;
export function requestFitAll() {
  fitAllWanted = true;
}

// Timeline のプリセット。
// presets/presets.json と .miseru をこの画面と同じ場所に置く。無ければ出さない。箱の画面には入れない
interface Preset {
  title: string;
  file: string;
  duration?: number;
}
function Presets({ hasKeys, open }: { hasKeys: boolean; open: (f: File) => Promise<void> }) {
  const [list, setList] = useState<Preset[] | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let off = false;
    fetch('presets/presets.json')
      .then((r) => (r.ok ? r.json() : null))
      .then((j: unknown) => {
        const a = Array.isArray(j) ? (j as Preset[]).filter((p) => p && typeof p.title === 'string' && typeof p.file === 'string') : [];
        if (!off && a.length) setList(a);
      })
      .catch(() => {});
    return () => {
      off = true;
    };
  }, []);
  if (!list) return null;
  const pick = async (i: number) => {
    const p = list[i];
    if (!p || busy) return;
    if (hasKeys && !ask(`Replace the current timeline with "${p.title}"?`)) return;
    setBusy(true);
    try {
      const r = await fetch(`presets/${p.file}`);
      if (!r.ok) throw new Error(String(r.status));
      await open(new File([await r.arrayBuffer()], p.file));
    } catch {
      window.alert(`Could not load "${p.title}".`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <select className="tl-btn tl-presets" value="" disabled={busy} aria-label="Presets: a song with keyframes" title="Presets: load a song with its keyframes" onChange={(e) => void pick(Number(e.target.value))}>
      <option value="" disabled>
        {busy ? 'Loading…' : 'Presets…'}
      </option>
      {list.map((p, i) => (
        <option key={p.file} value={i}>
          {p.title}
        </option>
      ))}
    </select>
  );
}

// タイムラインの再生。時計は、音や映像を読み込んでいればそれの再生位置、なければ画面の時計。

import { useCallback, useEffect, useRef, useState } from 'react';
import { evaluateTimeline, parseTimeline, emptyTimeline, type Timeline } from '../engine/index.js';
import type { ShowCommand } from '../engine/index.js';

const KEY = 'miseru.timeline';
const SEND_INTERVAL_MS = 33;

function load(): Timeline {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return parseTimeline(JSON.parse(raw)) ?? emptyTimeline();
  } catch {
    // 読めなければ新しく始める
  }
  return emptyTimeline();
}

export interface Media {
  name: string;
  url: string;
  isVideo: boolean;
  /** 波形（0..1 の最大値の列） */
  peaks: number[];
  /** 読み込んだファイルそのもの（曲ごと保存するため） */
  file: File;
}

async function peaksOf(file: File): Promise<number[]> {
  try {
    const ctx = new AudioContext();
    const buf = await ctx.decodeAudioData(await file.arrayBuffer());
    void ctx.close();
    const data = buf.getChannelData(0);
    const n = 1200;
    const step = Math.max(1, Math.floor(data.length / n));
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      let max = 0;
      for (let j = i * step; j < Math.min(data.length, (i + 1) * step); j += 8) max = Math.max(max, Math.abs(data[j]));
      out.push(max);
    }
    return out;
  } catch {
    return [];
  }
}

export function useTimeline(send: (cmd: ShowCommand) => void) {
  const [tl, setTlState] = useState<Timeline>(load);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [media, setMedia] = useState<Media | null>(null);
  const mediaEl = useRef<HTMLVideoElement | null>(null);
  const tlRef = useRef(tl);
  tlRef.current = tl;
  const timeRef = useRef(0);
  const clock = useRef({ startedAt: 0, from: 0 });
  /** ここまで来たら止める時刻（次のキーフレームまで再生のとき）。null なら最後まで */
  const stopAt = useRef<number | null>(null);

  // 取り消し・やり直し。操作 1 回が 1 回分。
  // キーのドラッグのように続けて変わるものは、同じ group を渡した変更を 1 回分にまとめる
  const past = useRef<Timeline[]>([]);
  const future = useRef<Timeline[]>([]);
  const lastGroup = useRef<string | null>(null);
  const [, setHist] = useState(0);
  const apply = (value: Timeline) => {
    tlRef.current = value;
    try {
      localStorage.setItem(KEY, JSON.stringify(value));
    } catch {
      // 保存できなくても使える
    }
    setTlState(value);
  };
  const setTl = useCallback((next: Timeline | ((t: Timeline) => Timeline), opts?: { group?: string }) => {
    const prev = tlRef.current;
    const raw = typeof next === 'function' ? next(prev) : next;
    // キーがなくなったトラックは自動で消す
    const value = raw.tracks.some((t) => t.keys.length === 0) ? { ...raw, tracks: raw.tracks.filter((t) => t.keys.length > 0) } : raw;
    if (value === prev) return;
    const group = opts?.group ?? null;
    if (group === null || group !== lastGroup.current) {
      past.current.push(prev);
      if (past.current.length > 100) past.current.shift();
    }
    lastGroup.current = group;
    future.current = [];
    apply(value);
    setHist((n) => n + 1);
  }, []);
  const emitRef = useRef<(t: number) => void>(() => {});
  const undo = useCallback(() => {
    const v = past.current.pop();
    if (!v) return;
    future.current.push(tlRef.current);
    lastGroup.current = null;
    apply(v);
    setHist((n) => n + 1);
    emitRef.current(timeRef.current);
  }, []);
  const redo = useCallback(() => {
    const v = future.current.pop();
    if (!v) return;
    past.current.push(tlRef.current);
    lastGroup.current = null;
    apply(v);
    setHist((n) => n + 1);
    emitRef.current(timeRef.current);
  }, []);

  const emit = useCallback(
    (t: number) => {
      const looks = evaluateTimeline(tlRef.current, t);
      if (Object.keys(looks).length > 0) send({ type: 'looks', looks });
    },
    [send],
  );

  const seek = useCallback(
    (t: number) => {
      const clamped = Math.min(tlRef.current.duration, Math.max(0, t));
      timeRef.current = clamped;
      setTime(clamped);
      clock.current = { startedAt: performance.now(), from: clamped };
      if (mediaEl.current && media) mediaEl.current.currentTime = clamped;
      emit(clamped);
    },
    [emit, media],
  );

  const play = useCallback(() => {
    stopAt.current = null;
    if (timeRef.current >= tlRef.current.duration) timeRef.current = 0;
    clock.current = { startedAt: performance.now(), from: timeRef.current };
    if (mediaEl.current && media) {
      mediaEl.current.currentTime = timeRef.current;
      void mediaEl.current.play();
    }
    setPlaying(true);
  }, [media]);

  /** 今の位置から指定の時刻まで再生して止める（次のキーフレームまで再生） */
  const playUntil = useCallback(
    (t: number) => {
      play();
      stopAt.current = t;
    },
    [play],
  );

  const pause = useCallback(() => {
    mediaEl.current?.pause();
    setPlaying(false);
  }, []);

  const stop = useCallback(() => {
    pause();
    seek(0);
  }, [pause, seek]);

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let lastSent = 0;
    const tick = (now: number) => {
      const el = mediaEl.current;
      let t = media && el && !el.paused ? el.currentTime : clock.current.from + (now - clock.current.startedAt) / 1000;
      const dur = tlRef.current.duration;
      if (stopAt.current !== null && t >= stopAt.current) {
        const end = stopAt.current;
        stopAt.current = null;
        timeRef.current = end;
        setTime(end);
        clock.current = { startedAt: now, from: end };
        if (el && media) el.currentTime = end;
        emit(end);
        pause();
        return;
      }
      if (t >= dur) {
        if (tlRef.current.loop) {
          t = 0;
          clock.current = { startedAt: now, from: 0 };
          if (el && media) el.currentTime = 0;
        } else {
          timeRef.current = dur;
          setTime(dur);
          emit(dur);
          pause();
          return;
        }
      }
      timeRef.current = t;
      setTime(t);
      if (now - lastSent >= SEND_INTERVAL_MS) {
        lastSent = now;
        emit(t);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, media, emit, pause]);

  // 画面を閉じるとき・ページを離れるときに音を止める
  useEffect(() => () => mediaEl.current?.pause(), []);

  const loadMedia = useCallback(
    async (file: File) => {
      pause();
      // 読み込み直したら 0 フレームに戻す
      seek(0);
      if (media) URL.revokeObjectURL(media.url);
      const peaks = await peaksOf(file);
      setMedia({ name: file.name, url: URL.createObjectURL(file), isVideo: file.type.startsWith('video/'), peaks, file });
    },
    [media, pause, seek],
  );

  const clearMedia = useCallback(() => {
    pause();
    if (media) URL.revokeObjectURL(media.url);
    setMedia(null);
  }, [media, pause]);

  /** 読み込んだ音・映像の長さに全体の長さを合わせる */
  const onMediaDuration = useCallback(
    (sec: number) => {
      if (Number.isFinite(sec) && sec > 0) setTl((t) => ({ ...t, duration: Math.min(3600, Math.ceil(sec)) }));
    },
    [setTl],
  );

  emitRef.current = emit;
  return { tl, setTl, undo, redo, canUndo: past.current.length > 0, canRedo: future.current.length > 0, time, playing, play, playUntil, pause, stop, seek, media, loadMedia, clearMedia, mediaEl, onMediaDuration };
}

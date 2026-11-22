// 常駐アプリとの WebSocket 接続。状態を受け取り、操作を送る。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { applyCommand, defaultLook, fixtureTypes, fxNow, hasFx, initialState, renderUniverse, tmuPhotoStudio, tmuPhotoStudioWithFloor } from '../engine/index.js';
import type { FixtureType, Patch, ShowCommand, ShowState } from '../engine/index.js';
import type { DenyReason } from '../box/protocol.js';
import { BoxLink, tabId, type BoxStatus, type LinkState } from './boxLink';
import { applyEdits, loadEdits, saveEdits, type LightEdit, type PatchEdits } from './patchEdits';

/** デモ版（vite build --mode demo）は常駐アプリなしで、ブラウザの中だけで動く */
// ウェブ体験版（lecture.nakayasu.com/miseru/app/ に置く 1 枚の HTML）。デモ版と同じく照明にはつながず、
// 箱・USB への送り口を出さない（2026-11-22 Akira さん: 3D・操作・タイムライン・Music を試せるもの）
export const isWeb = import.meta.env.MODE === 'web';
export const isDemo = import.meta.env.MODE === 'demo' || isWeb;
/** 箱版（vite build --mode box）は箱から配られ、ブラウザで計算した DMX を箱へ WebSocket で送る */
export const isBox = import.meta.env.MODE === 'box';

/** 箱への出口の状態と操作（箱版だけ） */
export interface BoxApi {
  link: LinkState;
  status: BoxStatus | null;
  /** このタブがロックを持っていて、照明を動かしている */
  mine: boolean;
  /** 箱の名前（例 ODE-DIY）。古い箱は知らせないので null */
  name: string | null;
  /** つないでいる箱のアドレス（例 192.0.2.223） */
  host: string;
  denied: boolean;
  /** claim が断られた理由（busy: ほかの人が使用中、not_allowed: 箱の許可リストに無い機器）。断られていなければ null */
  deniedReason: DenyReason | (string & {}) | null;
  lost: boolean;
  teacher: boolean;
  pinFailed: boolean;
  claim: () => void;
  release: () => void;
  pin: (pin: string) => void;
  forceRelease: () => void;
  setShowMode: (on: boolean) => void;
}

/** 箱のアドレス。箱から配られた画面なら自分のホスト。開発中は ?box=192.0.2.230 で指定できる。 */
function boxHost(): string {
  return new URLSearchParams(location.search).get('box') ?? location.host;
}

function boxUrl(): string {
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${boxHost()}/ws`;
}

const TOKEN_KEY = 'miseru.token';

export function loadToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function saveToken(token: string | null) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // 保存できなくても、この画面を開いている間は使える
  }
}

export interface SourceInfo {
  id: string;
  label: string;
  alive: boolean;
}

export type Connection = 'connecting' | 'open' | 'unpaired' | 'closed';

type ClientMessage = ShowCommand | { type: 'teacher'; pin: string } | { type: 'source'; id: string };

/** デモ版: エンジンをブラウザで直接動かす。照明には何も送らない。 */
function useLocalShow(_token: string | null) {
  // 照明の ch と機種は、この端末で変えたものを元のパッチに重ねる
  const [edits, setEdits] = useState<PatchEdits>(loadEdits);
  // 床置きの白 4 灯（四隅）を足すかどうか。Admin で切り替え、この端末に覚えておく
  const [floor, setFloorState] = useState(() => {
    try {
      return localStorage.getItem('miseru.floorPars') === '1';
    } catch {
      return false;
    }
  });
  const setFloor = useCallback((on: boolean) => {
    try {
      localStorage.setItem('miseru.floorPars', on ? '1' : '0');
    } catch {
      /* 覚えられなくても動く */
    }
    setFloorState(on);
  }, []);
  const basePatch = floor ? tmuPhotoStudioWithFloor : tmuPhotoStudio;
  const patch = useMemo(() => applyEdits(basePatch, edits), [basePatch, edits]);
  const editLight = useCallback((id: string, edit: LightEdit | null) => {
    setEdits((prev) => {
      const next = { ...prev };
      if (edit === null) delete next[id];
      else next[id] = { ...next[id], ...edit };
      saveEdits(next);
      return next;
    });
  }, []);
  const replaceEdits = useCallback((next: PatchEdits) => {
    saveEdits(next);
    setEdits(next);
  }, []);
  const [rawState, setState] = useState<ShowState>(() => initialState(patch));
  // 灯体が増えたとき（床置き 4 灯を入れたとき）は、増えた灯体の色を初めの値で足す
  const state = useMemo<ShowState>(
    () => (patch.lights.every((l) => rawState.looks[l.id]) ? rawState : { ...rawState, looks: Object.fromEntries(patch.lights.map((l) => [l.id, rawState.looks[l.id] ?? { ...defaultLook }])) }),
    [rawState, patch],
  );
  const send = useCallback(
    (cmd: ClientMessage) => {
      if (cmd.type === 'teacher' || cmd.type === 'source') return;
      setState((s) => applyCommand(patch, { ...s, looks: Object.fromEntries(patch.lights.map((l) => [l.id, s.looks[l.id] ?? { ...defaultLook }])) }, cmd));
    },
    [patch],
  );
  return {
    patch,
    types: fixtureTypes,
    state,
    connection: 'open' as Connection,
    send,
    sources: { active: 'app', list: [] as SourceInfo[] },
    teacherAvailable: false,
    teacher: null as boolean | null,
    box: null as BoxApi | null,
    defaultPatch: basePatch as Patch | null,
    floor,
    setFloor: setFloor as ((on: boolean) => void) | null,
    editLight: editLight as ((id: string, edit: LightEdit | null) => void) | null,
    replaceEdits: replaceEdits as ((edits: PatchEdits) => void) | null,
  };
}

/** 箱版: エンジンはブラウザの中で動かし、できた 512 スロットを箱へ送る。 */
function useBoxShow(_token: string | null) {
  const base = useLocalShow(null);
  const { patch, state } = base;
  const link = useRef<BoxLink | null>(null);
  const [linkState, setLinkState] = useState<LinkState>('connecting');
  const [status, setStatus] = useState<BoxStatus | null>(null);
  const [deniedReason, setDeniedReason] = useState<string | null>(null);
  const denied = deniedReason !== null;
  const [lost, setLost] = useState(false);
  const [pinFailed, setPinFailed] = useState(false);
  const stateRef = useRef(state);
  stateRef.current = state;
  const patchRef = useRef(patch);
  patchRef.current = patch;

  useEffect(() => {
    const l = new BoxLink({
      url: boxUrl(),
      id: tabId(),
      onState: setLinkState,
      onStatus: (s) => {
        setStatus(s);
        // 誰も持っていなくなったら、断られた知らせは消す（ほかの端末が Release したあと、押す前から残っていた）
        if (!s.holder) setDeniedReason(null);
        if (s.holder?.kind === 'ws' && s.holder.you) {
          setDeniedReason(null);
          setLost(false);
        }
      },
      onDenied: (reason) => setDeniedReason(reason),
      onLost: () => setLost(true),
      onPin: (ok) => setPinFailed(!ok),
    });
    link.current = l;
    l.setFrame(renderUniverse(patchRef.current, stateRef.current));
    l.connect();
    return () => {
      l.close();
      link.current = null;
    };
  }, []);

  useEffect(() => {
    link.current?.setFrame(renderUniverse(patch, state, fxNow()));
    // 演出（ストロボなど）があるあいだは、30 回/秒で今の時刻の見た目を作って送り続ける
    if (!hasFx(state.looks)) return;
    const timer = setInterval(() => link.current?.setFrame(renderUniverse(patch, state, fxNow())), 33);
    return () => clearInterval(timer);
  }, [patch, state]);

  const mine = status?.holder?.kind === 'ws' && status.holder.you;
  const box: BoxApi = {
    link: linkState,
    status,
    mine,
    name: status?.name ?? null,
    host: boxHost(),
    denied,
    deniedReason,
    lost,
    teacher: status?.teacher ?? false,
    pinFailed,
    claim: () => {
      setDeniedReason(null);
      setLost(false);
      link.current?.claim();
    },
    release: () => link.current?.release(),
    pin: (pin) => link.current?.pin(pin),
    forceRelease: () => link.current?.forceRelease(),
    setShowMode: (on) => link.current?.setShowMode(on),
  };
  return { ...base, connection: linkState === 'closed' ? ('closed' as Connection) : ('open' as Connection), box };
}

export const useShow = isDemo ? useLocalShow : isBox ? useBoxShow : useRemoteShow;

function useRemoteShow(token: string | null) {
  const [patch, setPatch] = useState<Patch | null>(null);
  const [types, setTypes] = useState<FixtureType[]>([]);
  const [state, setState] = useState<ShowState | null>(null);
  const [connection, setConnection] = useState<Connection>('connecting');
  const [sources, setSources] = useState<{ active: string; list: SourceInfo[] }>({ active: 'app', list: [] });
  const [teacherAvailable, setTeacherAvailable] = useState(false);
  const [teacher, setTeacher] = useState<boolean | null>(null);
  const ws = useRef<WebSocket | null>(null);

  useEffect(() => {
    let stopped = false;
    let retry: ReturnType<typeof setTimeout>;
    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const socket = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(token ?? '')}`);
      ws.current = socket;
      setConnection('connecting');
      socket.onopen = () => setConnection('open');
      socket.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'hello') {
          setPatch(msg.patch);
          setTypes(msg.fixtureTypes);
          setState(msg.state);
          setTeacherAvailable(!!msg.teacherAvailable);
        } else if (msg.type === 'state') {
          setState(msg.state);
        } else if (msg.type === 'sources') {
          setSources({ active: msg.active, list: msg.list });
        } else if (msg.type === 'teacher') {
          setTeacher(msg.ok);
        }
      };
      socket.onclose = (ev) => {
        if (stopped) return;
        if (ev.code === 4401) {
          setConnection('unpaired');
          return;
        }
        setConnection('closed');
        retry = setTimeout(connect, 1500);
      };
    };
    connect();
    return () => {
      stopped = true;
      clearTimeout(retry);
      ws.current?.close();
    };
  }, [token]);

  const send = useCallback((cmd: ClientMessage) => {
    if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify(cmd));
  }, []);

  return { patch, types, state, connection, send, sources, teacherAvailable, teacher, box: null as BoxApi | null, defaultPatch: null as Patch | null, editLight: null as ((id: string, edit: LightEdit | null) => void) | null, replaceEdits: null as ((edits: PatchEdits) => void) | null, floor: false, setFloor: null as ((on: boolean) => void) | null };
}

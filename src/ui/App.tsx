import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { isWhiteOnly } from './components/colors';
import type { Look } from '../engine/color.js';
import { lightLabel } from '../engine/show.js';
import { BigButtons } from './components/BigButtons';
import { ColorPanel } from './components/ColorPanel';
import { BoxAdmin, BoxBar, boxNote } from './components/BoxBar';
import { UsbBar } from './components/UsbBar';
import { PairScreen } from './components/PairScreen';
import { TeacherPanel } from './components/TeacherPanel';
import { VirtualStudio } from './components/VirtualStudio';
import { Splitter } from './components/Splitter';
import { isBox, isDemo, isWeb, loadToken, saveToken, useShow } from './useShow';
import { TimelinePanel } from './components/TimelinePanel';
import { MusicPanel, TimelineWave } from './components/MusicPanel';
import { SettingsDialog } from './components/SettingsDialog';
import { RecBadge } from './components/Recorder';
import { Studio3D, StudioSetup } from './components/Studio3D';
import { sceneStore, useSceneStore } from './sceneStore';
import { useTimeline } from './useTimeline';
import { useWakeLock } from './useWakeLock';
import logoUrl from './miseru-logo.svg';

/** グループに当たらない選び方のトラック名: 照明の番号を小さい順に「Fixtures 1·3·5」。4 台以上は「Fixtures 1·3·5 +2」 */
function fixturesName(lights: { id: string; number?: number }[], ids: string[]): string {
  const nums = ids
    .map((id) => lights.find((l) => l.id === id)?.number)
    .filter((n): n is number => n !== undefined)
    .sort((a, b) => a - b);
  if (nums.length === 0) return 'Selection';
  const head = nums.slice(0, 3).join('·');
  return nums.length > 3 ? `Fixtures ${head} +${nums.length - 3}` : `Fixtures ${head}`;
}

/** メディアクエリが当たっているか（ウィンドウ幅が変わると更新） */
function useMedia(query: string): boolean {
  const [on, setOn] = useState(() => typeof window === 'undefined' || window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const f = () => setOn(mq.matches);
    f();
    mq.addEventListener('change', f);
    return () => mq.removeEventListener('change', f);
  }, [query]);
  return on;
}

export function App() {
  const [token, setToken] = useState<string | null>(() => loadToken());
  const { patch, state, connection, send, sources, teacherAvailable, teacher, box, defaultPatch, editLight, replaceEdits, floor, setFloor } = useShow(token);
  // 箱を動かしている間は画面を消さない（消えると送り手が止まって、5 秒後に全消灯になる）
  useWakeLock(!!box?.mine);
  const [selected, setSelected] = useState<string[]>([]);
  // Timeline のトラックの名前を押したときに天井図で目立たせる照明
  const [highlight, setHighlight] = useState<string[] | null>(null);
  const [showTeacher, setShowTeacher] = useState(false);
  // Lock を押したら、もう一度パスワードを入れるまで Admin の操作を隠す（画面の中だけの錠）
  const [adminLocked, setAdminLocked] = useState(false);
  // 照明の ch と機種を変えられるのは、Admin の枠を開いてパスワードで開けている間だけ（2026-11-20 Akira さんの指示）。
  // それ以外（デモ版を含む）は i の枠は見るだけ
  const canEditPatch = !!editLight && !!replaceEdits && !!defaultPatch && showTeacher && !!box?.teacher && !adminLocked;
  const studioEdit = canEditPatch ? { defaults: defaultPatch!, onEdit: editLight!, onReplace: replaceEdits! } : null;
  const [mode, setMode] = useState<'light' | 'timeline' | 'music'>('light');
  // 右上の Settings（Claude API のキーとモデル。2026-11-22 Akira さんの指示）
  const [showSettings, setShowSettings] = useState(false);
  // Music タブ（曲から Claude で演出を作る）は誰でも使える（2026-11-21 Akira さん: 料金は各自のキーに付き、
  // 学生は自分の端末で使う。スタジオに共用の端末は置かない）
  // タブを切り替えたら、色パネルのスクロールを一番上に戻す（Intensity が隠れたまま出ないように）
  useEffect(() => {
    document.querySelectorAll<HTMLElement>('.controls, .main.stacked').forEach((el) => (el.scrollTop = 0));
  }, [mode]);
  // 天井図の高さ（仕切りのドラッグで変える）。この端末にだけ覚えておく
  const [studioH, setStudioH] = useState<number | null>(() => {
    try {
      const v = Number(localStorage.getItem('miseru.studioH'));
      return v > 0 ? v : null;
    } catch {
      return null;
    }
  });
  const resizeStudio = (h: number | null) => {
    setStudioH(h);
    try {
      if (h) localStorage.setItem('miseru.studioH', String(h));
      else localStorage.removeItem('miseru.studioH');
    } catch {
      /* 覚えられなくても動く */
    }
  };
  const timeline = useTimeline(send);
  // 箱版で操作権が無い間は、色パネル・タイムライン・下の 3 ボタンを薄くして押せなくする（押しても照明に届かないため）。理由は上に出す
  const noControl = !!box && box.link === 'open' && !box.mine;
  // 取り消し・やり直し: ⌘Z（Ctrl+Z）で取り消し、⇧⌘Z（Ctrl+Shift+Z・Ctrl+Y）でやり直し。対象は Timeline の編集。
  // 文字を打つ欄の中ではブラウザの取り消しに任せる
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || mode !== 'timeline') return;
      const k = e.key.toLowerCase();
      if (k !== 'z' && k !== 'y') return;
      const t = e.target as HTMLElement | null;
      const typing = t && ((t.tagName === 'INPUT' && !['range', 'checkbox', 'radio', 'button', 'file'].includes((t as HTMLInputElement).type)) || t.tagName === 'TEXTAREA' || t.isContentEditable);
      if (typing) return;
      e.preventDefault();
      if (k === 'y' || e.shiftKey) timeline.redo();
      else timeline.undo();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode, timeline.undo, timeline.redo]);
  // Timeline を再生したまま Manual に移ると、裏の再生が Manual の操作を上書きする。移る前に止めるか聞く（2026-11-20 Akira さん決定）
  const [stopAsk, setStopAsk] = useState(false);
  // Reset All は確かめてから（2026-11-21 Akira さんの指示）
  const [resetAsk, setResetAsk] = useState(false);
  // Admin の枠は Esc でも閉じる（2026-11-21 ダブルチェックの指摘。確かめる枠が出ている間はそちらを先に閉じる）
  useEffect(() => {
    if (!showTeacher) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || resetAsk || stopAsk || e.defaultPrevented || document.querySelector('.studio-infobox')) return;
      setShowTeacher(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showTeacher, resetAsk, stopAsk]);

  // 確かめる枠が出ている間は、枠の中の文を押してフォーカスが外れても、キー（← → Enter Esc）が効くようにする
  useEffect(() => {
    if (!resetAsk && !stopAsk) return;
    const onKey = (e: KeyboardEvent) => {
      const box = document.querySelector<HTMLElement>('.tl-stop-ask');
      if (!box) return;
      const buttons = [...box.querySelectorAll<HTMLButtonElement>('.tl-stop-ask-actions button')];
      if (buttons.length === 0) return;
      let i = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (e.key === 'Escape') {
        setResetAsk(false);
        setStopAsk(false);
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        if (i < 0) i = 0;
        buttons[(i + (e.key === 'ArrowLeft' ? buttons.length - 1 : 1)) % buttons.length].focus();
      } else if (e.key === 'Enter') {
        (i >= 0 ? buttons[i] : buttons[0]).click();
      } else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [resetAsk, stopAsk]);
  const stopAndManual = () => {
    timeline.pause();
    setStopAsk(false);
    setMode('light');
  };
  useEffect(() => {
    if (!stopAsk) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setStopAsk(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [stopAsk]);
  // Timeline のときの並べ方: 横 1 段（タイムラインと色パネルを左右）か横 2 段（上下）。広い画面だけ選べ、この端末に覚える
  const [tlStack, setTlStack] = useState(() => {
    try {
      return localStorage.getItem('miseru.tlLayout') === 'stack';
    } catch {
      return false;
    }
  });
  const setTlLayout = (stack: boolean) => {
    setTlStack(stack);
    try {
      localStorage.setItem('miseru.tlLayout', stack ? 'stack' : 'row');
    } catch {
      /* 覚えられなくても動く */
    }
  };
  const wideWork = useMedia('(min-width: 761px)');
  // 3D ビュー: 広い画面では天井図の右に並べ、狭い画面では Top / 3D で切り替える（2026-11-21 Akira さんがカードで B を選択）
  const wideScreen = useMedia('(min-width: 1100px)');
  // 広い画面でも 1 画面（Fixtures / 3D の切り替え）を選べる（2026-11-22 Akira さん）。この端末に覚える
  const [onePane, setOnePaneState] = useState(() => {
    try {
      return localStorage.getItem('miseru.studioPanes') === '1';
    } catch {
      return false;
    }
  });
  const setOnePane = (one: boolean) => {
    setOnePaneState(one);
    try {
      localStorage.setItem('miseru.studioPanes', one ? '1' : '2');
    } catch {
      /* 覚えられなくても動く */
    }
  };
  const [view3d, setView3d] = useState(false);
  const panes = wideScreen && (
    <div className="tl-layout v3d-panes" role="group" aria-label="Studio panes">
      <button className={onePane ? '' : 'on'} aria-pressed={!onePane} onClick={() => setOnePane(false)} title="Two panes" aria-label="Two panes">
        <svg viewBox="0 0 13 10" width="13" height="10" aria-hidden="true">
          <rect width="6" height="10" rx="1.5" fill="currentColor" />
          <rect x="7" width="6" height="10" rx="1.5" fill="currentColor" />
        </svg>
      </button>
      <button className={onePane ? 'on' : ''} aria-pressed={onePane} onClick={() => setOnePane(true)} title="One pane" aria-label="One pane">
        <svg viewBox="0 0 13 10" width="13" height="10" aria-hidden="true">
          <rect width="13" height="10" rx="1.5" fill="currentColor" />
        </svg>
      </button>
    </div>
  );
  const { setup } = useSceneStore();
  // 箱は前のまま: 1 画面でも Setup の間は 2 画面にする
  const wide3d = wideScreen && (!onePane || (import.meta.env.MODE === 'box' && setup));
  // 1 画面と狭い画面では、Fixtures / 3D / Setup のタブで切り替える（2026-11-22 Akira さん）。箱の画面は容量のため前のまま（3D の Setup ボタン）
  const pick = (v3: boolean, su: boolean) => {
    setView3d(v3);
    sceneStore.setSetup(su);
  };
  // 箱のビルドから外す所は import.meta.env.MODE を使う所ごとに直接書く（isBox を経由すると定数として畳まれず、コードが残った）
  // Timeline の横 1 段で、タイムラインと色パネルのあいだの仕切りで決めたタイムラインの幅。
  // 一番狭いのは最初の並び（色パネルが最大 420px）のときの幅。この端末に覚える
  const mainRef = useRef<HTMLDivElement>(null);
  const [tlW, setTlW] = useState<number | null>(() => {
    try {
      const v = Number(localStorage.getItem('miseru.tlW'));
      return v > 0 ? v : null;
    } catch {
      return null;
    }
  });
  const saveTlW = (w: number | null) => {
    setTlW(w);
    try {
      if (w) localStorage.setItem('miseru.tlW', String(w));
      else localStorage.removeItem('miseru.tlW');
    } catch {
      /* 覚えられなくても動く */
    }
  };
  const tlDrag = useRef<{ x: number; w: number } | null>(null);
  // 覚えた幅は、描くときは CSS の clamp で今の枠の幅に収める（JS で枠の幅を読むと、Manual の狭い枠の幅で決めてしまい、
  // Timeline に切り替えてから 1〜2 秒後の描き直しで幅が変わっていた。2026-11-21 Akira さんの指摘）。ここはドラッグ用
  const clampTl = (w: number) => {
    const total = mainRef.current?.clientWidth ?? 1200;
    const min = total - 12 - 420;
    const max = total - 12 - 320;
    return Math.round(Math.max(min, Math.min(w, max)));
  };
  const tlNow = () => (mainRef.current?.querySelector('.lights') as HTMLElement | null)?.offsetWidth ?? 600;

  // はじめは全部選んでおく
  useEffect(() => {
    if (patch && selected.length === 0) setSelected(patch.lights.map((l) => l.id));
  }, [patch]); // eslint-disable-line react-hooks/exhaustive-deps

  const groups = useMemo(() => {
    const g = new Map<string, string[]>();
    for (const l of patch?.lights ?? []) {
      const key = l.group ?? 'Other';
      g.set(key, [...(g.get(key) ?? []), l.id]);
    }
    return [...g.entries()];
  }, [patch]);

  if (connection === 'unpaired') {
    return (
      <PairScreen
        onPaired={(t) => {
          saveToken(t);
          setToken(t);
        }}
      />
    );
  }

  if (!patch || !state) {
    return <div className="loading">{connection === 'closed' ? 'Waiting for connection…' : 'Loading…'}</div>;
  }

  const first = state.looks[selected[0]];
  // 明るさだけの照明（床置き PAR）が選択に入っているか。色の操作は色が変わる照明だけに効く（2026-11-21）
  const whiteOnlySel = patch.lights.filter((l) => selected.includes(l.id) && isWhiteOnly(l.typeId));
  const colorScope: 'all' | 'mixed' | 'none' = whiteOnlySel.length === 0 ? 'all' : whiteOnlySel.length === selected.length ? 'none' : 'mixed';
  const whiteOnlyName = [...new Set(whiteOnlySel.map((l) => l.group ?? l.name))].join(', ');
  const set = (look: Partial<Look>) => send({ type: 'set', ids: selected, look });
  const toggle = (id: string) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  return (
    <div className={`${box ? 'app with-box' : 'app'}${state.blackout || state.fullOn ? ' app-blackout-on' : ''}${state.fullOn && !state.blackout ? ' app-worklight-on' : ''}${noControl ? ' app-no-control' : ''}${showTeacher ? ' app-admin-open' : ''}`} style={studioH ? ({ '--studio-h': `${studioH}px` } as CSSProperties) : undefined}>
      <header className="top">
        <div className="brand">
          <h1 className="brand-logo">
            {/* ロゴ: LED の粒で描いた miseru（B1 案、2026-11-20 Akira さん決定）。文字は読み上げ用に残す */}
            <img src={logoUrl} alt="" width={109} height={27} />
            <span className="brand-logo-text">miseru</span>
          </h1>
          <span className="brand-sub">
            Show and Captivate with Light <span className="brand-rev">rev {__APP_VERSION__}{__APP_COMMIT__ ? ` (${__APP_COMMIT__})` : ''}</span>
          </span>
        </div>
        <span className="place" aria-hidden="true" />
        {box && <BoxBar box={box} />}
        {isDemo && <span className="badge-demo">{isWeb ? 'Web trial — not connected to fixtures' : 'Demo — not connected to fixtures'}</span>}
        {sources.active !== 'app' && <span className="badge-source">External source active</span>}
        {!isBox && <RecBadge onOpen={() => setMode('music')} />}
        {/* 右上の Settings ボタンは外した（2026-11-22 Akira さん）。設定画面は Music の Claude API の欄から開く */}
      </header>
      {showSettings && <SettingsDialog onClose={() => setShowSettings(false)} />}

      {isDemo && !isWeb && (
        <div className="out-bar">
          <UsbBar patch={patch} state={state} />
        </div>
      )}
      {noControl && (
        <p className={box?.denied ? 'control-note control-note-denied' : 'control-note'} role="status">
          {/* Take Control が断られたら、理由をここ（目に入る所）に出す。下のデバッグ行だけだと気づかれなかった（2026-11-21 現地準備で Akira さん） */}
          {box?.denied
            ? box.deniedReason === 'not_allowed'
              ? 'This device is not on the node’s allow list. Ask the admin to add it.'
              : 'Another device is in control. Press Release on that device, then press Take Control.'
            : box?.status?.holder
              ? 'Another device is in control. Press Take Control to operate the lights.'
              : 'Press Take Control to operate the lights.'}
          {/* 右上の Take Control を指す矢印（2026-11-21 Akira さんの指示） */}
          <svg className="control-note-arrow" viewBox="0 0 12 12" width="13" height="13" aria-hidden="true">
            <path d="M3 9 9 3M4.5 3H9v4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </p>
      )}

      {/* 狭い画面の 3D は天井図の上に重ねる（天井図は見えなくするだけで、高さはそのまま使う） */}
      {wide3d && <div className="v3d-panes-row">{panes}</div>}
      <div className={(wide3d ? 'v3d-pair v3d-pair-wide' : view3d ? 'v3d-pair v3d-on' : 'v3d-pair') + (wideScreen && onePane && !(import.meta.env.MODE === 'box' && setup) ? ' v3d-one' : '')}>
        <VirtualStudio patch={patch} state={state} selected={selected} onToggle={noControl ? () => {} : toggle} groups={groups} onSelect={noControl ? () => {} : setSelected} edit={studioEdit} highlight={mode === 'timeline' ? highlight : null} cover={setup && ((import.meta.env.MODE === 'box' && wide3d) || (import.meta.env.MODE !== 'box' && !wide3d && wideScreen && !view3d)) ? <StudioSetup patch={patch} /> : null} />
        {(wide3d || view3d) && (
          <div className={import.meta.env.MODE !== 'box' && !wide3d ? 'v3d-frame v3d-tabs' : 'v3d-frame'}>
            {/* タブで Setup を選べる所では、3D の Setup ボタンを CSS で隠す（Studio3D に引数を足すと箱のビルドが大きくなった） */}
            {/* 2 画面（横に 2 つ並ぶ）では、Setup は 3D と入れ替わる（2026-11-22 Akira さん）。天井図はそのまま見える。箱は容量のため前のまま */}
            {import.meta.env.MODE !== 'box' && wide3d && setup ? (
              <div className="studio-cover v3d-setup-pane">
                <StudioSetup patch={patch} onClose={() => sceneStore.setSetup(false)} />
              </div>
            ) : (
              <Studio3D patch={patch} state={state} />
            )}
          </div>
        )}
        {!wide3d && (
          <div className="v3d-switch" role="tablist" aria-label="Studio view">
            <button role="tab" aria-selected={!view3d && !(import.meta.env.MODE !== 'box' && !wide3d && setup)} className={view3d || (import.meta.env.MODE !== 'box' && !wide3d && setup) ? '' : 'on'} onClick={() => (import.meta.env.MODE !== 'box' && !wide3d ? pick(false, false) : setView3d(false))}>
              {/* 天井図のタブ名は Fixtures（2026-11-22 Akira さん） */}
              Fixtures
            </button>
            <button role="tab" aria-selected={view3d && !(import.meta.env.MODE !== 'box' && !wide3d && setup)} className={view3d && !(import.meta.env.MODE !== 'box' && !wide3d && setup) ? 'on' : ''} onClick={() => (import.meta.env.MODE !== 'box' && !wide3d ? pick(true, false) : setView3d(true))}>
              3D
            </button>
            {import.meta.env.MODE !== 'box' && !wide3d && (
              // 広い画面の 1 画面は設定を枠いっぱいに、狭い画面は 3D の下に出す
              <button role="tab" aria-selected={setup} className={setup ? 'on' : ''} onClick={() => pick(!wideScreen, true)}>
                Setup
              </button>
            )}
          </div>
        )}
        {!wide3d && panes}
      </div>
      {/* 狭い画面で Solid のときは、設定の欄を 3D の下に出す */}
      {setup && !wide3d && view3d && (
        <div className="sc-below">
          <StudioSetup patch={patch} />
        </div>
      )}
      <Splitter
        measure={() => document.querySelector('.studio')?.getBoundingClientRect().height ?? 300}
        onResize={resizeStudio}
        onReset={() => resizeStudio(null)}
      />

      <div className={mode === 'timeline' ? 'work' : 'work single'}>
        <div className="panel-tabs" role="tablist" aria-label="Mode">
          <button role="tab" aria-selected={mode === 'light'} className={mode === 'light' ? 'on' : ''} onClick={() => (mode !== 'light' && timeline.playing ? setStopAsk(true) : setMode('light'))}>
            Manual
          </button>
          <button role="tab" aria-selected={mode === 'timeline'} className={mode === 'timeline' ? 'on' : ''} onClick={() => setMode('timeline')}>
            Timeline
          </button>
          <button role="tab" aria-selected={mode === 'music'} className={mode === 'music' ? 'on' : ''} onClick={() => setMode('music')} title="Make a timeline from music with Claude">
            {/* タブ名は Music Analysis（2026-11-22 Akira さんがカードで選択）。箱も同じ（ロゴの絵と使わない CSS を削って容量を空けた） */}
            Music Analysis
          </button>
          {/* 並べ方のアイコンは線ではなく塗りつぶしの矩形（2026-11-21 Akira さんの指示） */}
          {mode === 'timeline' && wideWork && (
            <div className="tl-layout" role="group" aria-label="Timeline layout">
              <button className={tlStack ? '' : 'on'} aria-pressed={!tlStack} onClick={() => setTlLayout(false)} title="Side by side" aria-label="Side by side">
                <svg viewBox="0 0 13 10" width="13" height="10" aria-hidden="true">
                  <rect x="0" y="0" width="8" height="10" rx="1.5" fill="currentColor" />
                  <rect x="9" y="0" width="4" height="10" rx="1.5" fill="currentColor" />
                </svg>
              </button>
              <button className={tlStack ? 'on' : ''} aria-pressed={tlStack} onClick={() => setTlLayout(true)} title="Stacked" aria-label="Stacked">
                <svg viewBox="0 0 13 10" width="13" height="10" aria-hidden="true">
                  <rect x="0" y="0" width="13" height="4" rx="1.5" fill="currentColor" />
                  <rect x="0" y="6" width="13" height="4" rx="1.5" fill="currentColor" />
                </svg>
              </button>
            </div>
          )}
        </div>
        <div
          ref={mainRef}
          className={mode === 'timeline' ? (tlStack && wideWork ? 'main stacked' : wideWork ? 'main tl-side' : 'main') : 'main single'}
          style={mode === 'timeline' && !tlStack && wideWork && tlW ? { gridTemplateColumns: `clamp(calc(100% - 432px), ${tlW}px, calc(100% - 332px)) 12px minmax(320px, 1fr)` } : undefined}
        >
          {mode === 'music' && (
            <section className="lights mu-host">
              <MusicPanel api={timeline} lights={patch.lights} onApplied={() => setMode('timeline')} onSettings={() => setShowSettings(true)} />
            </section>
          )}
          {mode === 'timeline' && (
            <section className="lights">
              <TimelinePanel
                api={timeline}
                {...(import.meta.env.MODE !== 'box' && { Wave: TimelineWave })}
                lights={patch.lights}
                selected={selected}
                currentLook={first}
                onHighlight={setHighlight}
                onSelectLights={setSelected}
                groupName={(ids) => groups.find(([, g]) => g.length === ids.length && g.every((x) => ids.includes(x)))?.[0] ?? (ids.length > 1 && patch.lights.length > 1 && patch.lights.every((l) => ids.includes(l.id)) ? 'All' : ids.length === 1 ? ((l) => (l ? lightLabel(l) : 'Fixture'))(patch.lights.find((l) => l.id === ids[0])) : fixturesName(patch.lights, ids))}
              />
            </section>
          )}
          {mode === 'timeline' && !tlStack && wideWork && (
            <div
              className="col-splitter"
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize timeline"
              tabIndex={0}
              title="Drag to resize · double-click to reset"
              onPointerDown={(e) => {
                tlDrag.current = { x: e.clientX, w: tlNow() };
                e.currentTarget.setPointerCapture(e.pointerId);
              }}
              onPointerMove={(e) => {
                if (tlDrag.current) saveTlW(clampTl(tlDrag.current.w + e.clientX - tlDrag.current.x));
              }}
              onPointerUp={() => (tlDrag.current = null)}
              onPointerCancel={() => (tlDrag.current = null)}
              onDoubleClick={() => saveTlW(null)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                  e.preventDefault();
                  saveTlW(clampTl(tlNow() + (e.key === 'ArrowLeft' ? -20 : 20)));
                }
              }}
            >
              <span className="col-splitter-grip" />
            </div>
          )}

          {mode !== 'music' && (
          <section className="controls">
            {first ? (
              <ColorPanel look={first} onChange={set} colorScope={colorScope} whiteOnlyName={whiteOnlyName} split={mode !== 'timeline' || (tlStack && wideWork)} />
            ) : (
              <p className="hint">Select one or more fixtures.</p>
            )}
          </section>
          )}
        </div>
      </div>

      {timeline.media && (
        <video
          ref={timeline.mediaEl}
          src={timeline.media.url}
          className={timeline.media.isVideo && mode === 'timeline' ? 'tl-video' : 'tl-hidden'}
          playsInline
          onLoadedMetadata={(e) => timeline.onMediaDuration(e.currentTarget.duration)}
        />
      )}

      {state.fullOn && !state.blackout && (
        // Work Light 中も Blackout と同じく、画面の真ん中で点滅させ、ほかの操作は止める（押すと押す前に戻す。2026-11-21 Akira さんの指示）
        <div className="blackout-overlay" role="alertdialog" aria-label="Work Light">
          <button className="blackout-center worklight-center" onClick={() => send({ type: 'allOn' })} autoFocus>
            <span className="blackout-title">Work Light</span>
            <span className="blackout-sub">Click to release</span>
          </button>
        </div>
      )}
      {state.blackout && (
        // 全消灯中は画面の真ん中で点滅させ、ほかの操作は止める（押すと解除）
        <div className="blackout-overlay" role="alertdialog" aria-label="Blackout">
          <button className="blackout-center" onClick={() => send({ type: 'blackout', on: false })} autoFocus>
            <span className="blackout-title">Blackout</span>
            <span className="blackout-sub">Click to release</span>
          </button>
        </div>
      )}

      {stopAsk && (
        <div className="tl-stop-ask" role="alertdialog" aria-label="Stop the timeline" onClick={() => setStopAsk(false)}>
          <div className="tl-stop-ask-box" onClick={(e) => e.stopPropagation()}>
            <div className="tl-stop-ask-title">The timeline is playing</div>
            <p className="tl-stop-ask-text">Stop playback to switch to Manual? While it plays, the timeline overrides manual changes.</p>
            <div className="tl-stop-ask-actions">
              <button className="tl-stop-ask-cancel" onClick={() => setStopAsk(false)}>Cancel</button>
              <button className="tl-stop-ask-ok" onClick={stopAndManual} autoFocus>Stop and Switch</button>
            </div>
          </div>
        </div>
      )}

      {resetAsk && (
        <div className="tl-stop-ask reset-ask" role="alertdialog" aria-label="Reset all lights" onClick={() => setResetAsk(false)}>
          <div className="tl-stop-ask-box" onClick={(e) => e.stopPropagation()}>
            <div className="tl-stop-ask-title">Reset all lights?</div>
            <p className="tl-stop-ask-text">Every light goes back to the start: off, with the default color. Blackout and Work Light are cleared. This cannot be undone. The timeline and your custom swatches are kept.</p>
            <div className="tl-stop-ask-actions">
              <button className="tl-stop-ask-cancel" onClick={() => setResetAsk(false)} autoFocus>Cancel</button>
              <button className="tl-stop-ask-ok" onClick={() => { setResetAsk(false); send({ type: 'reset' }); }}>Reset All</button>
            </div>
          </div>
        </div>
      )}

      <footer className="app-footer">
        <BigButtons
          blackout={state.blackout}
          fullOn={!!state.fullOn}
          onBlackout={() => send({ type: 'blackout', on: !state.blackout })}
          onReset={() => setResetAsk(true)}
          onAllOn={() => send({ type: 'allOn' })}
        />

        {showTeacher && !box && (
          <TeacherPanel
            unlocked={teacher === true && !adminLocked}
            failed={teacher === false}
            sources={sources}
            onUnlock={(pin) => { setAdminLocked(false); send({ type: 'teacher', pin }); }}
            onLock={() => setAdminLocked(true)}
            onSelect={(id) => send({ type: 'source', id })}
            onClose={() => setShowTeacher(false)}
          />
        )}

        {showTeacher && box && <BoxAdmin box={box} locked={adminLocked} onLock={() => setAdminLocked(true)} onUnlock={() => setAdminLocked(false)} onClose={() => setShowTeacher(false)} floor={floor} onFloor={setFloor} />}

        <div className="debugline" role="status" aria-live="polite">
          <span>Master: {Math.round(state.master * 100)}%</span>
          <span>Blackout: {state.blackout ? 'on' : 'off'}</span>
          <span>Source: {sources.active}</span>
          <span>Link: {isDemo ? 'none (trial)' : connection}</span>
          <span>{isBox ? 'Node' : isWeb ? 'Web trial' : isDemo ? 'Demo' : 'Server'}</span>
          {box && boxNote(box) && <span className="debug-note">{boxNote(box)}</span>}
          {(box || teacherAvailable) && (
            <button
              className={showTeacher ? 'gear-button on' : 'gear-button'}
              onClick={() => setShowTeacher((v) => !v)}
              aria-label="Admin"
              aria-expanded={showTeacher}
              title="Admin"
            >
              <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                <path
                  fill="currentColor"
                  d="M19.14 12.94c.04-.31.06-.62.06-.94s-.02-.63-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96a7.03 7.03 0 0 0-1.62-.94l-.36-2.54A.48.48 0 0 0 13.92 2h-3.84a.48.48 0 0 0-.48.41l-.36 2.54c-.59.24-1.13.56-1.62.94l-2.39-.96a.49.49 0 0 0-.59.22L2.72 8.47a.48.48 0 0 0 .12.61l2.03 1.58c-.05.31-.07.63-.07.94s.02.63.06.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32a.49.49 0 0 0-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 1 1 12 8.4a3.6 3.6 0 0 1 0 7.2z"
                />
              </svg>
            </button>
          )}
        </div>
      </footer>
    </div>
  );
}


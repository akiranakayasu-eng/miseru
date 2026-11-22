interface Props {
  blackout: boolean;
  /** Full On（作業灯）中か。もう一度押すと元に戻る */
  fullOn?: boolean;
  onBlackout: () => void;
  onReset: () => void;
  onAllOn: () => void;
}

export function BigButtons({ blackout, fullOn, onBlackout, onReset, onAllOn }: Props) {
  return (
    <footer className="big-buttons">
      <button className="big reset" onClick={onReset}>
        Reset All
      </button>
      <button className={blackout ? 'big danger on' : 'big danger'} onClick={onBlackout}>
        {blackout ? <span className="big-restore">Restore</span> : 'Blackout'}
      </button>
      <button className={fullOn ? 'big full-on on' : 'big full-on'} aria-pressed={!!fullOn} onClick={onAllOn} title={fullOn ? 'Press again to return to the lights before Full On' : 'All lights to 100% white (5600 K)'}>
        {/* 作業灯だと分かる名前に（2026-11-21 Akira さんが B 案を選択） */}
        {/* 押している間は Blackout と同じく Restore に（2026-11-21 Akira さんの指示） */}
        {fullOn ? <span className="big-restore">Restore</span> : (
          <>
            Work Light
            <span className="big-sub">All 100% · 5600{'\u00a0'}K</span>
          </>
        )}
      </button>
    </footer>
  );
}

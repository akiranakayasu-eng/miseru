import { useState } from 'react';
import type { BoxApi } from '../useShow';

/** 箱版の上の帯: どの箱か、照明を動かしているか、ほかの送り手が使っているか。Release。（Admin は画面の下の歯車から） */
export function BoxBar({ box }: { box: BoxApi }) {
  const holder = box.status?.holder ?? null;
  const other = holder && !box.mine;
  const show = box.status?.show_mode ?? false;

  const node = box.name ? `${box.name} · ${box.host}` : box.host;
  let text: string;
  if (box.link === 'closed') text = 'Node not found — check the network';
  else if (box.link !== 'open') text = 'Searching for node…';
  else if (box.mine) text = 'In control';
  else if (other && holder.kind === 'artnet') text = `Controlled by Art-Net (${holder.ip})`;
  else if (other && holder.kind === 'sacn') text = `Controlled by sACN (${holder.ip})`;
  else if (other) text = 'Controlled by another client';
  else text = box.lost ? 'Control released' : 'Idle';

  return (
    <>
      <div className={box.mine ? 'boxbar mine' : 'boxbar'} role="status">
        <span className={box.link === 'closed' ? 'boxbar-text lost-node' : text === 'Control released' ? 'boxbar-text released' : 'boxbar-text'}>
          {box.mine && box.link !== 'closed' && <span className="boxbar-check" aria-hidden="true">✓</span>}
          {text}
        </span>
        <span className="boxbar-node">{node}</span>
        {show && <span className="badge-show">Show Mode</span>}
        <span className="boxbar-spacer" />
        {box.mine ? (
          <button className="boxbar-button" onClick={box.release}>
            <OpenLockIcon />
            Release
          </button>
        ) : (
          <button className="boxbar-button primary-ish" onClick={box.claim} disabled={box.link !== 'open'}>
            <LockIcon />
            Take Control
          </button>
        )}
      </div>
    </>
  );
}

/** 箱の Admin の枠（画面の下の歯車で開く） */
export function BoxAdmin({ box, locked, onLock, onUnlock, onClose, floor, onFloor }: { box: BoxApi; locked: boolean; onLock: () => void; onUnlock: () => void; onClose: () => void; floor?: boolean; onFloor?: ((on: boolean) => void) | null }) {
  const [pin, setPin] = useState('');
  const show = box.status?.show_mode ?? false;
  return (
    <div className="teacher" role="dialog" aria-label="Admin settings">
      <div className="teacher-head">
        <strong>Admin</strong>
        <button className="link" onClick={onClose}>
          Close
        </button>
      </div>
      {!box.teacher || locked ? (
        <div className="teacher-pin">
          <input type="password" autoComplete="off" autoCapitalize="none" spellCheck={false} value={pin} onChange={(e) => setPin(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { onUnlock(); box.pin(pin); } }} placeholder="Password" aria-label="Admin password" />
          <button className="primary small" onClick={() => { onUnlock(); box.pin(pin); }}>
            <OpenLockIcon />
            Unlock
          </button>
          {box.pinFailed && <span className="error">Incorrect password</span>}
        </div>
      ) : (
        <div className="teacher-actions">
          <button className="small lock-button" onClick={() => { setPin(''); onLock(); }}>
            <LockIcon />
            Lock
          </button>
          <button className="big" onClick={box.forceRelease}>
            Release Current Control (Blackout)
          </button>
          <button className={show ? 'big danger on' : 'big'} onClick={() => box.setShowMode(!show)}>
            {show ? 'Exit Show Mode' : 'Enter Show Mode'}
          </button>
          <p className="muted">In Show Mode the node holds the last frame even if the sender stops. Only this panel or the node’s button can release it.</p>
          {/* 床置きの白 4 灯（四隅、DMX 101〜104）を天井図に足す。学生には使わせないので Admin だけ（2026-11-21 Akira さんの指示） */}
          {onFloor && (
            <>
              <button className={floor ? 'big on' : 'big'} aria-pressed={!!floor} onClick={() => onFloor(!floor)}>
                {floor ? 'Remove Floor Lights' : 'Add Floor Lights (4 Corners)'}
              </button>
              <p className="muted">Four white PAR100CW lights on the floor, one in each corner (DMX 101–104, intensity only). They appear on the ceiling map as 8–11.</p>
            </>
          )}
          {/* 箱の設定画面（PIN の変更だけ。画面の差し替えは本体ボタンの長押しで受け付ける。2026-11-20 の方針）を別のタブで開く */}
          <a className="big admin-setup-link" href={`http://${box.host}/setup`} target="_blank" rel="noreferrer">
            Node Setup
          </a>
          <p className="muted">Change the admin password. Saving restarts the node, and the lights go off for a few seconds.</p>
        </div>
      )}
    </div>
  );
}

/** 箱の補足の説明（断られた理由・ロックが外れた理由）。画面のいちばん下のデバッグ行に出す */
export function boxNote(box: BoxApi): string | null {
  if (box.denied && !box.mine)
    return box.deniedReason === 'not_allowed' ? 'This device is not on the node’s allow list.' : 'Another source is in control. Try again when it is released.';
  if (box.mine === false && !box.denied && box.lost) return 'Control was released by an admin or by the node’s button.';
  return null;
}

/** 開いた錠（Release・Unlock に付ける） */
export function OpenLockIcon() {
  return (
    <svg className="boxbar-icon" viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
      <rect x="6" y="8" width="9" height="7" rx="1.5" fill="currentColor" />
      <path d="M2 8.5V5a3 3 0 0 1 6 0v0.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

/** 閉じた錠（Take Control・Lock に付ける） */
export function LockIcon() {
  return (
    <svg className="boxbar-icon boxbar-icon-closed" viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
      <rect x="3" y="7" width="10" height="8" rx="1.5" fill="currentColor" />
      <path d="M5.5 7V4.5a2.5 2.5 0 0 1 5 0V7" fill="none" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

import { useState } from 'react';
import type { SourceInfo } from '../useShow';
import { LockIcon, OpenLockIcon } from './BoxBar';

interface Props {
  unlocked: boolean;
  failed: boolean;
  sources: { active: string; list: SourceInfo[] };
  onUnlock: (pin: string) => void;
  /** Admin の操作を閉じ、もう一度パスワードを求める */
  onLock: () => void;
  onSelect: (id: string) => void;
  onClose: () => void;
}

/** 先生用: ODE に流す出どころを 1 つ選ぶ */
export function TeacherPanel({ unlocked, failed, sources, onUnlock, onLock, onSelect, onClose }: Props) {
  const [pin, setPin] = useState('');
  return (
    <div className="teacher" role="dialog" aria-label="Admin settings">
      <div className="teacher-head">
        <strong>Admin</strong>
        <button className="link" onClick={onClose}>
          Close
        </button>
      </div>
      {!unlocked ? (
        <div className="teacher-pin">
          <input type="password" autoComplete="off" autoCapitalize="none" spellCheck={false} value={pin} onChange={(e) => setPin(e.target.value)} placeholder="Password" aria-label="Admin password" />
          <button className="primary small" onClick={() => onUnlock(pin)}>
            <OpenLockIcon />
            Unlock
          </button>
          {failed && <span className="error">Incorrect password</span>}
        </div>
      ) : (
        <>
        <button className="small lock-button" onClick={() => { setPin(''); onLock(); }}>
          <LockIcon />
          Lock
        </button>
        <fieldset className="sources">
          <legend>Output source (one at a time)</legend>
          {sources.list.map((s) => (
            <label key={s.id} className={s.alive ? 'source' : 'source dead'}>
              <input type="radio" name="source" checked={sources.active === s.id} onChange={() => onSelect(s.id)} />
              {s.label}
              {!s.alive && <span className="muted">(no signal)</span>}
            </label>
          ))}
          {sources.list.length === 1 && <p className="muted">Art-Net sources received on the Wi-Fi side are listed here.</p>}
        </fieldset>
        </>
      )}
    </div>
  );
}

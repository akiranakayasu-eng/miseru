import { useEffect } from 'react';
import { showModels, type ShowModelId } from '../claudeShow';
import { claudeSettings, useClaudeSettings } from '../claudeSettings';
import { isWeb } from '../useShow';

/** 右上の Settings で開く設定画面。いまは Claude API だけ（2026-11-22 Akira さんの指示） */
export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const { key, remember, model } = useClaudeSettings();
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="tl-stop-ask settings-ask" role="dialog" aria-modal="true" aria-label="Settings" onClick={onClose}>
      <div className="tl-stop-ask-box settings-box" onClick={(e) => e.stopPropagation()}>
        <div className="settings-head">
          <div className="tl-stop-ask-title">Settings</div>
          <button className="tl-btn" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="mu-section">
          <div className="mu-heading">Claude API (for Music)</div>
          <div className="mu-key-row">
            <input
              className="mu-key-input"
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="API key (sk-ant-…)"
              value={key}
              onChange={(e) => claudeSettings.set({ key: e.target.value })}
              aria-label="Claude API key"
            />
            {key && (
              <button className="tl-btn" onClick={() => claudeSettings.forget()}>
                Forget
              </button>
            )}
          </div>
          <div className="mu-key-row">
            <label className="mu-check">
              <input type="checkbox" checked={remember} onChange={(e) => claudeSettings.set({ remember: e.target.checked })} /> Remember on this device
            </label>
            {/* ウェブ体験版は lecture.nakayasu.com の中に置くので、覚えたキーはそのサイトの保存場所に入る（2026-11-22 チェックの指摘） */}
            {isWeb && <span className="mu-note-shared">Don’t tick this on a shared computer.</span>}
          </div>
          <div className="mu-key-row">
            <span className="mu-check">Model</span>
            <select className="mu-select" value={model} onChange={(e) => claudeSettings.set({ model: e.target.value as ShowModelId })} aria-label="Model">
              {showModels.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>
          {/* キーが入っているか・どこまで残るかを、欄の下にはっきり出す（2026-11-21 Akira さん）。末尾 4 文字だけ見せる */}
          {key.trim() ? (
            <p className="mu-key-status" role="status">
              <span aria-hidden="true">✓</span> {remember ? 'Key saved on this device' : 'Key set for this tab only (cleared when the tab closes)'} <span className="mu-key-tail">· ••••{key.trim().slice(-4)}</span>
            </p>
          ) : (
            <p className="mu-note">No key yet. Your own Claude API key; usage is charged to it.</p>
          )}
          <p className="mu-note">The key stays only in this browser. This device needs an internet connection.</p>
        </div>
      </div>
    </div>
  );
}

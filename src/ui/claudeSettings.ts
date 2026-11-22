import { useSyncExternalStore } from 'react';
import { loadApiKey, saveApiKey, showModels, type ShowModelId } from './claudeShow';

/**
 * Claude API の設定（キー・覚えるか・モデル）。設定画面と Music タブの両方から読むので、画面の外に置く。
 * 2026-11-22 Akira さんの指示で、キーを入れる場所を Music から右上の設定画面へ移した。
 */
const MODEL_KEY = 'miseru.musicModel';

export interface ClaudeSettings {
  key: string;
  remember: boolean;
  model: ShowModelId;
}

function readModel(): ShowModelId {
  try {
    const m = localStorage.getItem(MODEL_KEY);
    if (m && showModels.some((x) => x.id === m)) return m as ShowModelId;
  } catch {
    /* 読めなければ既定 */
  }
  return showModels[0].id;
}

let state: ClaudeSettings = { ...loadApiKey(), model: readModel() };
const subs = new Set<() => void>();

export const claudeSettings = {
  get: () => state,
  set(p: Partial<ClaudeSettings>) {
    state = { ...state, ...p };
    saveApiKey(state.key.trim(), state.remember);
    try {
      localStorage.setItem(MODEL_KEY, state.model);
    } catch {
      /* 覚えられなくても動く */
    }
    subs.forEach((f) => f());
  },
  forget() {
    claudeSettings.set({ key: '', remember: false });
  },
  subscribe(f: () => void) {
    subs.add(f);
    return () => subs.delete(f);
  },
};

export function useClaudeSettings(): ClaudeSettings {
  return useSyncExternalStore(claudeSettings.subscribe, claudeSettings.get);
}

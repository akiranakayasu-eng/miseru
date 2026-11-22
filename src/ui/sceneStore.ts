// 3D ビューのスタジオの設定（部屋・照明の置き方・人）と Solid 表示の入り切り。
// 3D の枠と、天井図の場所に出す設定の欄の両方から使うので、ここに置く（2026-11-22）。
import { useSyncExternalStore } from 'react';
import { defaultScene, type Scene } from './studio3d';

const KEY = 'miseru.scene3d.v1';
function load(): Scene {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const sc = JSON.parse(raw) as Scene;
      if (sc && sc.room && Array.isArray(sc.people) && sc.lights) return sc;
    }
  } catch {
    // 読めなければ既定
  }
  return defaultScene();
}

interface S {
  scene: Scene;
  solid: boolean;
  // Setup: 天井図の場所にスタジオの設定を出す（3D の Setup ボタン。2026-11-22 Akira さん、Solid とは別に）
  setup: boolean;
  sel: string | null; // 'L:<照明の id>' か 'P:<人の番号>'
}
let s: S = { scene: load(), solid: false, setup: false, sel: null };
const subs = new Set<() => void>();
const set = (p: Partial<S>) => {
  s = { ...s, ...p };
  subs.forEach((f) => f());
};

export const sceneStore = {
  get: () => s,
  setScene(scene: Scene) {
    try {
      localStorage.setItem(KEY, JSON.stringify(scene));
    } catch {
      // 覚えられなくても、この画面の間は効く
    }
    set({ scene });
  },
  setSolid: (solid: boolean) => set({ solid }),
  setSetup: (setup: boolean) => set({ setup }),
  setSel: (sel: string | null) => set({ sel }),
  reset() {
    sceneStore.setScene(defaultScene());
    set({ sel: null });
  },
};
const sub = (f: () => void) => {
  subs.add(f);
  return () => subs.delete(f);
};
export const useSceneStore = () => useSyncExternalStore(sub, sceneStore.get);

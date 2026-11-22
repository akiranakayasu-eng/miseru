import { useEffect } from 'react';

/** active の間、画面を消さない。公演中に iPad がスリープして照明が止まるのを防ぐ。非対応でも動く。 */
export function useWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    let sentinel: WakeLockSentinel | null = null;
    let cancelled = false;
    const request = async () => {
      try {
        const s = await navigator.wakeLock?.request('screen');
        if (cancelled) await s?.release();
        else sentinel = s ?? null;
      } catch {
        // 許されない端末では何もしない（ルールで「公演中は画面を消さない」を決めておく）
      }
    };
    void request();
    // 別のタブから戻ると外れているので、取り直す
    const onVisible = () => {
      if (document.visibilityState === 'visible' && (!sentinel || sentinel.released)) void request();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      void sentinel?.release();
    };
  }, [active]);
}

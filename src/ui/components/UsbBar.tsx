import { useEffect, useRef, useState } from 'react';
import { fxNow, hasFx, renderUniverse, type Patch, type ShowState } from '../../engine/index.js';
import { UsbProLink, usbProSupported } from '../usbPro';

/** DMX USB Pro を直接つなぐ（デモ版・箱なしのとき）。つないだあとは画面の変化をそのまま送る。 */
export function UsbBar({ patch, state }: { patch: Patch; state: ShowState }) {
  const link = useRef(new UsbProLink());
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!connected) return;
    link.current.send(renderUniverse(patch, state, fxNow()));
    // 演出があるあいだは 30 回/秒で送り続ける
    if (!hasFx(state.looks)) return;
    const timer = setInterval(() => link.current.send(renderUniverse(patch, state, fxNow())), 33);
    return () => clearInterval(timer);
  }, [connected, patch, state]);

  useEffect(() => {
    const l = link.current;
    return () => void l.close();
  }, []);

  if (!usbProSupported()) return null;

  return (
    <div className="usb-bar">
      {connected ? (
        <>
          <span>DMX USB Pro connected</span>
          <button className="tl-btn small" onClick={() => void link.current.close().then(() => setConnected(false))}>Disconnect</button>
        </>
      ) : (
        <button
          className="tl-btn small"
          onClick={() =>
            link.current
              .connect()
              .then(() => { setError(''); setConnected(true); })
              .catch((e: Error) => setError(e.name === 'NotFoundError' ? '' : 'Could not open the port'))
          }
        >
          Connect DMX USB Pro…
        </button>
      )}
      {error && <span className="error">{error}</span>}
    </div>
  );
}

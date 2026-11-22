import { useEffect, useState, useSyncExternalStore } from 'react';

/**
 * 録音。Mac の「サウンド」の入力と同じ一覧（マイク、オーディオインターフェース、仮想の入力など）から選んで録り、Music に読み込む。
 * ほかのタブの音は録らない。録ったものはファイルに保存できる。何を録って何に使うかは使う人の責任とし、その一文を画面に出す。
 * 録音の状態は画面の外に置く。Manual や Timeline のタブへ移っても録音は続き、録った分は消えない。
 */
interface RecState {
  rec: boolean;
  t0: number;
  err: string | null;
  last: { file: File; url: string } | null;
}
let st: RecState = { rec: false, t0: 0, err: null, last: null };
let mr: MediaRecorder | null = null;
let onDoneNow: ((f: File) => void) | null = null;
const subs = new Set<() => void>();
const put = (p: Partial<RecState>) => {
  st = { ...st, ...p };
  subs.forEach((f) => f());
};
const sub = (f: () => void) => {
  subs.add(f);
  return () => subs.delete(f);
};

function pickType(): string {
  for (const t of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']) if (MediaRecorder.isTypeSupported(t)) return t;
  return '';
}

async function startRec(dev: string) {
  put({ err: null });
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: dev ? { exact: dev } : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    const type = pickType();
    const r = new MediaRecorder(s, type ? { mimeType: type } : undefined);
    const chunks: Blob[] = [];
    r.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
    };
    r.onstop = () => {
      s.getTracks().forEach((t) => t.stop());
      mr = null;
      if (!chunks.length) return put({ rec: false });
      const mime = r.mimeType || type || 'audio/webm';
      const d = new Date();
      const p2 = (n: number) => String(n).padStart(2, '0');
      const name = `Recording ${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}.${mime.includes('mp4') ? 'm4a' : 'webm'}`;
      const file = new File(chunks, name, { type: mime.split(';')[0] });
      if (st.last) URL.revokeObjectURL(st.last.url);
      put({ rec: false, last: { file, url: URL.createObjectURL(file) } });
      onDoneNow?.(file);
    };
    // 機器が抜かれたときも録音を終える
    s.getAudioTracks()[0]?.addEventListener('ended', () => r.state !== 'inactive' && r.stop());
    r.start(1000);
    mr = r;
    put({ rec: true, t0: performance.now() });
  } catch (e) {
    put({ err: (e as Error)?.name === 'NotAllowedError' ? 'Recording was not allowed.' : 'Could not start recording on this browser.' });
  }
}

export function Recorder({ onDone }: { onDone: (f: File) => void }) {
  const { rec, t0, err, last } = useSyncExternalStore(sub, () => st);
  const [dev, setDev] = useState('');
  const [devs, setDevs] = useState<MediaDeviceInfo[]>([]);
  const [, tick] = useState(0);
  // 録り終えたときに読み込む先は、いちばん新しい画面のものにする（画面を離れていても読み込める）
  onDoneNow = onDone;

  useEffect(() => {
    if (!rec) return;
    const id = setInterval(() => tick((n) => n + 1), 250);
    return () => clearInterval(id);
  }, [rec]);

  // 入力の一覧。名前は一度録音を許可したあとでないとブラウザが教えないので、許可のあとと機器の抜き差しで読み直す
  const listDevs = () =>
    navigator.mediaDevices
      ?.enumerateDevices()
      .then((d) => setDevs(d.filter((x) => x.kind === 'audioinput' && x.deviceId !== 'default' && x.deviceId !== 'communications')))
      .catch(() => undefined);
  useEffect(() => {
    void listDevs();
    navigator.mediaDevices?.addEventListener?.('devicechange', listDevs);
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', listDevs);
  }, [rec]);

  if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) return null;

  const secs = rec ? (performance.now() - t0) / 1000 : 0;
  const save = () => {
    if (!last) return;
    const a = document.createElement('a');
    a.href = last.url;
    a.download = last.file.name;
    a.click();
  };

  return (
    <div className="mu-rec">
      <div className="mu-key-row">
        <span className="mu-check">Record</span>
        {!rec && (
          <select className="mu-select mu-rec-dev" value={dev} onChange={(e) => setDev(e.target.value)} aria-label="Record from (sound input)">
            <option value="">Default input (as in Sound settings)</option>
            {devs.map((d, i) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || `Input ${i + 1}`}
              </option>
            ))}
          </select>
        )}
        {rec ? (
          <button className="tl-btn mu-rec-on" onClick={() => mr && mr.state !== 'inactive' && mr.stop()}>
            ■ Stop {Math.floor(secs / 60)}:{String(Math.floor(secs % 60)).padStart(2, '0')}
          </button>
        ) : (
          <button className="tl-btn" onClick={() => void startRec(dev)}>
            ● Start
          </button>
        )}
        {last && !rec && (
          <button className="tl-btn" onClick={save} title={last.file.name}>
            Save recording
          </button>
        )}
      </div>
      {!rec && devs.every((d) => !d.label) && <p className="mu-note">Input names appear after you allow recording once.</p>}
      {rec && <p className="mu-note">Recording keeps going if you switch to Manual or Timeline.</p>}
      {err && <p className="mu-error" role="alert">{err}</p>}
      <p className="mu-note">Record only what you have the right to use. You are responsible for what you record, save and share.</p>
    </div>
  );
}

/** 録音中の印。ほかのタブにいても上に出し、押すと Music を開く */
export function RecBadge({ onOpen }: { onOpen: () => void }) {
  const { rec, t0 } = useSyncExternalStore(sub, () => st);
  const [, tick] = useState(0);
  useEffect(() => {
    if (!rec) return;
    const id = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(id);
  }, [rec]);
  if (!rec) return null;
  const secs = (performance.now() - t0) / 1000;
  return (
    <button className="rec-badge" onClick={onOpen} title="Recording. Open Music to stop it.">
      ● REC {Math.floor(secs / 60)}:{String(Math.floor(secs % 60)).padStart(2, '0')}
    </button>
  );
}

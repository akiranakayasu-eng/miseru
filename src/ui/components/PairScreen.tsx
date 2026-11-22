import { useState } from 'react';

export function PairScreen({ onPaired }: { onPaired: (token: string) => void }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState('');

  const submit = async () => {
    setError('');
    const res = await fetch('/api/pair', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    const body = await res.json();
    if (body.token) onPaired(body.token);
    else setError(body.error ?? 'Connection failed');
  };

  return (
    <div className="pair">
      <h1>miseru</h1>
      <p>Enter the 6-digit pairing code shown on the host computer.</p>
      <input
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={6}
        value={code}
        onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
        onKeyDown={(e) => e.key === 'Enter' && code.length === 6 && submit()}
        aria-label="Pairing code"
      />
      <button className="primary" disabled={code.length !== 6} onClick={submit}>
        Connect
      </button>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

import { useState } from 'react';
import { ApiError, complaintStatus as apiStatus, type StatusResult } from '../api';
import { formatDate, speak } from '../lib';

export function StatusLookup({ lookup = apiStatus }: { lookup?: typeof apiStatus }) {
  const [code, setCode] = useState('');
  const [contact, setContact] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<StatusResult | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    const c = contact.trim();
    try {
      setResult(await lookup(code.trim().toUpperCase(), c.includes('@') ? { email: c } : { phone: c }));
    } catch (err) {
      setError(err instanceof ApiError && err.status === 404 ? 'No complaint matches that code and contact detail.' : err instanceof ApiError ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="status">
      <form onSubmit={onSubmit} className="complaint-form">
        <label>
          Complaint code
          <input required value={code} onChange={(e) => setCode(e.target.value)} placeholder="CMP-ABC123" pattern="[Cc][Mm][Pp]-[A-Za-z0-9]{6}" autoComplete="off" />
        </label>
        <label>
          Email or phone you used
          <input required value={contact} onChange={(e) => setContact(e.target.value)} placeholder="you@example.com or +92 300 1234567" />
        </label>
        <button className="btn btn-block" disabled={busy}>
          {busy ? 'Checking…' : 'Check status'}
        </button>
      </form>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {result && (
        <div className="card status-card" role="status">
          <p className="code">{result.complaint_code}</p>
          <p>
            <span className={`badge status-${result.status.replace(' ', '-').toLowerCase()}`}>{result.status}</span> with {result.department_name}
          </p>
          <p className="muted small">Filed {formatDate(result.submitted_at)} · Priority {result.priority}</p>
          <button className="btn btn-outline" type="button" onClick={() => speak(result.spoken_message)}>
            🔊 Read aloud
          </button>
        </div>
      )}
    </div>
  );
}

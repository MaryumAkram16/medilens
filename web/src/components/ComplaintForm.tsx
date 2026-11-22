import { useState } from 'react';
import { ApiError, submitComplaint as apiSubmit, type ComplaintResult, type Priority } from '../api';
import { speak, stopSpeaking } from '../lib';
import { CopyButton } from './CopyButton';
import { Recorder } from './Recorder';

const TYPES = ['Medical Care Issues', 'Billing Problems', 'Staff Behavior', 'Appointments', 'Pharmacy', 'Lab Reports', 'Cleanliness & Facilities', 'Other'];
const PRIORITIES: Priority[] = ['Low', 'Medium', 'High'];

export interface ComplaintFormProps {
  submit?: typeof apiSubmit;
  transcribe?: React.ComponentProps<typeof Recorder>['transcribe'];
}

export function ComplaintForm({ submit = apiSubmit, transcribe }: ComplaintFormProps) {
  const [form, setForm] = useState({ name: '', phone: '', email: '', type: TYPES[0]!, details: '' });
  const [priority, setPriority] = useState<Priority | null>(null);
  const [spoken, setSpoken] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ComplaintResult | null>(null);

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await submit({
        name: form.name.trim(),
        phone: form.phone.trim(),
        email: form.email.trim(),
        details: form.details.trim(),
        type: form.type,
        ...(priority ? { priority } : {}),
        channel: spoken ? 'voice' : 'web',
      });
      setResult(r);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    return (
      <div className="result" role="status">
        {result.emergency_notice && (
          <div className="emergency" role="alert">
            <strong>Emergency?</strong> {result.emergency_notice}
          </div>
        )}
        <div className="result-head">
          <span className="tick" aria-hidden="true">
            ✓
          </span>
          <div>
            <h3>Complaint received</h3>
            <p className="muted">Sent to {result.department_name}</p>
          </div>
        </div>
        <dl className="facts">
          <div>
            <dt>Your code</dt>
            <dd className="code">
              {result.complaint_code} <CopyButton label="Copy" text={result.complaint_code} />
            </dd>
          </div>
          <div>
            <dt>Priority</dt>
            <dd>
              <span className={`badge ${result.priority.toLowerCase()}`}>{result.priority}</span>
            </dd>
          </div>
          <div>
            <dt>Response within</dt>
            <dd>{result.expected_response_hours} hours</dd>
          </div>
        </dl>
        <p className="answer">{result.spoken_message}</p>
        {result.needs_review && <p className="muted small">A member of staff will check where this goes, so it reaches the right team.</p>}
        <p className="muted small">Keep your code to track the complaint. {form.email ? 'A copy has been emailed to you.' : ''}</p>
        <div className="row">
          <button className="btn btn-outline" type="button" onClick={() => speak(result.spoken_message)}>
            🔊 Read aloud
          </button>
          <CopyButton label="📋 Copy answer" text={`${result.spoken_message}\nComplaint code: ${result.complaint_code}`} />
          <button
            className="btn"
            type="button"
            onClick={() => {
              stopSpeaking();
              setResult(null);
              setSpoken(false);
              setPriority(null);
              setForm((f) => ({ ...f, details: '' }));
            }}
          >
            File another
          </button>
        </div>
      </div>
    );
  }

  return (
    <form className="complaint-form" onSubmit={onSubmit}>
      <label>
        Name
        <input required value={form.name} onChange={set('name')} placeholder="Your name" autoComplete="name" maxLength={100} />
      </label>
      <div className="two">
        <label>
          Phone
          <input required value={form.phone} onChange={set('phone')} placeholder="+92 300 1234567" autoComplete="tel" inputMode="tel" />
        </label>
        <label>
          Email
          <input required type="email" value={form.email} onChange={set('email')} placeholder="you@example.com" autoComplete="email" />
        </label>
      </div>
      <label>
        Type
        <select value={form.type} onChange={set('type')}>
          {TYPES.map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
      </label>
      <fieldset className="priority">
        <legend>How urgent does it feel? (optional)</legend>
        <div className="chips">
          {PRIORITIES.map((p) => (
            <button key={p} type="button" className={`chip ${priority === p ? 'on' : ''}`} aria-pressed={priority === p} onClick={() => setPriority(priority === p ? null : p)}>
              {p}
            </button>
          ))}
        </div>
        <p className="muted small">Our AI decides the final priority and the right department. In an emergency, call 1122.</p>
      </fieldset>
      <label>
        Details
        <textarea required minLength={10} maxLength={4000} rows={5} value={form.details} onChange={set('details')} placeholder="Describe the issue…" />
      </label>
      <Recorder
        transcribe={transcribe}
        onTranscript={(text) => {
          setSpoken(true);
          setForm((f) => ({ ...f, details: f.details ? `${f.details} ${text}` : text }));
        }}
      />
      {spoken && <p className="muted small">Check the text above and fix anything the recording got wrong before you submit.</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <button className="btn btn-block" type="submit" disabled={busy}>
        {busy ? 'Sending…' : 'Submit Complaint'}
      </button>
    </form>
  );
}

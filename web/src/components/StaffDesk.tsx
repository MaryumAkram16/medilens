import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ApiError,
  DEPARTMENTS,
  complaintsSummary as apiSummary,
  triageAccuracy as apiAccuracy,
  updateComplaint as apiUpdate,
  type Accuracy,
  type ComplaintRow,
  type Priority,
  type Summary,
} from '../api';
import { formatDate, tabStore } from '../lib';

const KEY_STORE = 'medilens.staffKey';
const STATUSES = ['Pending', 'In Review', 'Resolved'] as const;
const PRIORITIES: Priority[] = ['High', 'Medium', 'Low'];

export interface StaffDeskProps {
  summary?: typeof apiSummary;
  accuracy?: typeof apiAccuracy;
  update?: typeof apiUpdate;
}

export function StaffDesk({ summary = apiSummary, accuracy = apiAccuracy, update = apiUpdate }: StaffDeskProps) {
  const [key, setKey] = useState<string | null>(() => tabStore.get(KEY_STORE));
  const [draftKey, setDraftKey] = useState('');
  const [data, setData] = useState<Summary | null>(null);
  const [acc, setAcc] = useState<Accuracy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'review' | (typeof STATUSES)[number]>('all');
  const [search, setSearch] = useState('');

  const load = useCallback(
    async (k: string) => {
      setError(null);
      try {
        const [s, a] = await Promise.all([summary(k), accuracy(k)]);
        setData(s);
        setAcc(a);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          tabStore.set(KEY_STORE, null);
          setKey(null);
          setError('That staff key was not accepted.');
          return;
        }
        setError(err instanceof ApiError ? err.message : 'Could not load complaints.');
      }
    },
    [summary, accuracy],
  );

  useEffect(() => {
    if (key) void load(key);
  }, [key, load]);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (data?.data ?? []).filter(
      (r) =>
        (filter === 'all' || (filter === 'review' ? r.needs_review : r.status === filter)) &&
        (!q || `${r.complaint_code} ${r.patient_name} ${r.details} ${r.category}`.toLowerCase().includes(q)),
    );
  }, [data, filter, search]);

  if (!key) {
    return (
      <form
        className="card staff-login"
        onSubmit={(e) => {
          e.preventDefault();
          const k = draftKey.trim();
          tabStore.set(KEY_STORE, k);
          setKey(k);
        }}
      >
        <h2>Staff desk</h2>
        <p className="muted">Enter the staff key (the API's ADMIN_API_KEY). It is kept only for this browser tab.</p>
        <input type="password" value={draftKey} onChange={(e) => setDraftKey(e.target.value)} placeholder="Staff key" autoComplete="off" aria-label="Staff key" />
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button className="btn" disabled={!draftKey.trim()}>
          Open desk
        </button>
      </form>
    );
  }

  async function save(row: ComplaintRow, change: Parameters<typeof apiUpdate>[1]) {
    setNotice(null);
    try {
      const r = await update(key!, change);
      setNotice(
        `${row.complaint_code}: ${r.review === 'corrected' ? 'corrected' : r.review === 'confirmed' ? 'confirmed' : 'updated'}${r.notified.length ? ` · notified ${r.notified.join(' and ')}` : ''}.`,
      );
      await load(key!);
    } catch (err) {
      setNotice(err instanceof ApiError ? err.message : 'Could not save.');
    }
  }

  const s = data?.summary;
  const ai = acc?.by_source.ai;

  return (
    <div className="desk">
      <div className="desk-head">
        <div>
          <h2>Complaint Management</h2>
          <p className="muted">Review the AI's routing and resolve patient feedback</p>
        </div>
        <div className="row">
          <button className="btn btn-outline" onClick={() => void load(key)}>
            ↻ Refresh
          </button>
          <button
            className="link"
            onClick={() => {
              tabStore.set(KEY_STORE, null);
              setKey(null);
              setData(null);
            }}
          >
            Sign out
          </button>
        </div>
      </div>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {s && (
        <div className="kpis">
          <Kpi label="Total" value={s.total} tone="teal" />
          <Kpi label="Pending" value={s.pending} tone="blue" />
          <Kpi label="Needs review" value={s.needsReview} tone="amber" />
          <Kpi label="High priority" value={s.highPriority} tone="red" />
          <Kpi label="Emergencies" value={s.emergency} tone="red" />
          <Kpi label="AI accuracy (reviewed)" value={ai?.accuracy == null ? '—' : `${Math.round(ai.accuracy * 100)}%`} tone="teal" hint={ai ? `${ai.both_correct}/${ai.reviewed} confirmed` : 'no reviews yet'} />
        </div>
      )}

      {notice && <p className="notice">{notice}</p>}

      <div className="toolbar">
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search complaints…" aria-label="Search complaints" />
        <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)} aria-label="Filter">
          <option value="all">All statuses</option>
          <option value="review">Needs review</option>
          {STATUSES.map((st) => (
            <option key={st} value={st}>
              {st}
            </option>
          ))}
        </select>
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Code</th>
              <th>Received</th>
              <th>Patient</th>
              <th>Complaint</th>
              <th>Department</th>
              <th>Priority</th>
              <th>Status</th>
              <th>Triage</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={9} className="muted center">
                  {data ? 'No complaints match.' : 'Loading…'}
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <Row key={r.complaint_code} row={r} onSave={save} />
            ))}
          </tbody>
        </table>
      </div>

      {acc && acc.recent_corrections.length > 0 && (
        <section className="card corrections">
          <h3>Recent corrections</h3>
          <p className="muted small">Each correction is a case the AI got wrong. They feed the evaluation set.</p>
          <ul>
            {acc.recent_corrections.map((c) => (
              <li key={c.complaint_code}>
                <span className="code">{c.complaint_code}</span> {c.from} → <strong>{c.to}</strong> <span className="muted">({c.triage_source})</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function Kpi({ label, value, tone, hint }: { label: string; value: number | string; tone: string; hint?: string }) {
  return (
    <div className={`kpi ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      {hint && <small>{hint}</small>}
    </div>
  );
}

function Row({ row, onSave }: { row: ComplaintRow; onSave: (row: ComplaintRow, change: Parameters<typeof apiUpdate>[1]) => Promise<void> }) {
  const [dept, setDept] = useState(row.department_code);
  const [prio, setPrio] = useState<Priority>(row.priority);
  const [status, setStatus] = useState(row.status);
  const changed = dept !== row.department_code || prio !== row.priority || status !== row.status;

  return (
    <tr className={row.emergency ? 'emergency-row' : row.needs_review ? 'review-row' : ''}>
      <td className="code">{row.complaint_code}</td>
      <td className="muted small">{formatDate(row.created_at)}</td>
      <td>
        <strong>{row.patient_name}</strong>
        <div className="muted small">{row.channel === 'voice' ? '🎤 voice' : 'web'}</div>
      </td>
      <td className="details" title={row.details}>
        {row.details}
        <div className="muted small">{row.suggested_action}</div>
      </td>
      <td>
        <select value={dept} onChange={(e) => setDept(e.target.value)} aria-label={`Department for ${row.complaint_code}`}>
          {Object.entries(DEPARTMENTS).map(([code, name]) => (
            <option key={code} value={code}>
              {name}
            </option>
          ))}
        </select>
      </td>
      <td>
        <select value={prio} onChange={(e) => setPrio(e.target.value as Priority)} aria-label={`Priority for ${row.complaint_code}`}>
          {PRIORITIES.map((p) => (
            <option key={p}>{p}</option>
          ))}
        </select>
      </td>
      <td>
        <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)} aria-label={`Status for ${row.complaint_code}`}>
          {STATUSES.map((st) => (
            <option key={st}>{st}</option>
          ))}
        </select>
      </td>
      <td className="small">
        {row.emergency ? <span className="badge high">EMERGENCY</span> : row.needs_review ? <span className="badge medium">REVIEW</span> : null}
        <div className="muted">
          {row.triage_source} · {Math.round(row.confidence * 100)}%
        </div>
      </td>
      <td>
        {changed ? (
          <button
            className="btn btn-small"
            onClick={() =>
              void onSave(row, {
                complaint_code: row.complaint_code,
                ...(dept !== row.department_code ? { department: dept } : {}),
                ...(prio !== row.priority ? { priority: prio } : {}),
                ...(status !== row.status ? { status } : {}),
              })
            }
          >
            Save
          </button>
        ) : (
          <button className="btn btn-small btn-outline" title="The AI got this right" onClick={() => void onSave(row, { complaint_code: row.complaint_code, confirm: true })}>
            Confirm
          </button>
        )}
      </td>
    </tr>
  );
}

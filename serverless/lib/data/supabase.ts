/**
 * Supabase (PostgREST) repository. Uses the service-role key, server side
 * only; RLS denies every other role. Bodies are built with JSON.stringify and
 * filters are URL-encoded, so patient text is never spliced into a query.
 */
import type { DepartmentCode } from '../complaints/catalog.js';
import {
  DataSourceError,
  type AuditEntry,
  type ComplaintRecord,
  type ComplaintRepository,
  type InsertResult,
  type NewComplaint,
  type ComplaintPatch,
  type NewReview,
  type ReviewedComplaint,
} from './types.js';

export interface SupabaseOptions {
  url: string;
  serviceKey: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

const COLUMNS =
  'id,complaint_code,patient_name,email,phone,details,details_hash,channel,call_id,category_hint,priority_hint,priority,department_code,category,sentiment,suggested_action,confidence,triage_source,emergency,needs_review,status,created_at';

export class SupabaseRepository implements ComplaintRepository {
  private readonly base: string;
  private readonly doFetch: typeof fetch;

  constructor(private readonly opts: SupabaseOptions) {
    this.base = `${opts.url.replace(/\/+$/, '')}/rest/v1`;
    this.doFetch = opts.fetch ?? fetch;
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    try {
      return await this.doFetch(`${this.base}/${path}`, {
        ...init,
        headers: {
          apikey: this.opts.serviceKey,
          authorization: `Bearer ${this.opts.serviceKey}`,
          'content-type': 'application/json',
          ...(init.headers as Record<string, string> | undefined),
        },
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 8_000),
      });
    } catch (err) {
      throw new DataSourceError(err instanceof Error && err.name === 'TimeoutError' ? 'supabase_timeout' : 'supabase_unreachable');
    }
  }

  private async rows<T>(res: Response): Promise<T[]> {
    if (!res.ok) throw new DataSourceError(`supabase_http_${res.status}`);
    return (await res.json()) as T[];
  }

  async isDuplicate(contactKey: string, detailsHash: string): Promise<boolean> {
    const q = new URLSearchParams({
      select: 'id',
      contact_key: `eq.${contactKey}`,
      details_hash: `eq.${detailsHash}`,
      limit: '1',
    });
    return (await this.rows(await this.request(`complaints?${q}`))).length > 0;
  }

  async insert(complaint: NewComplaint): Promise<InsertResult> {
    const res = await this.request(`complaints?select=${COLUMNS}`, {
      method: 'POST',
      headers: { prefer: 'return=representation' },
      body: JSON.stringify(complaint),
    });
    if (res.status === 409) {
      const body = (await res.json().catch(() => ({}))) as { code?: string; message?: string };
      if (body.code === '23505' && /complaints_no_duplicate/.test(body.message ?? '')) {
        return { ok: false, reason: 'duplicate' };
      }
      throw new DataSourceError('supabase_conflict');
    }
    const [record] = await this.rows<ComplaintRecord>(res);
    if (!record) throw new DataSourceError('supabase_empty_insert');
    return { ok: true, record: { ...record, confidence: Number(record.confidence) } };
  }

  async findByCode(code: string): Promise<ComplaintRecord | null> {
    const q = new URLSearchParams({ select: COLUMNS, complaint_code: `eq.${code}`, limit: '1' });
    const [row] = await this.rows<ComplaintRecord>(await this.request(`complaints?${q}`));
    return row ? { ...row, confidence: Number(row.confidence) } : null;
  }

  async list(limit: number): Promise<ComplaintRecord[]> {
    const q = new URLSearchParams({ select: COLUMNS, order: 'created_at.desc', limit: String(limit) });
    return (await this.rows<ComplaintRecord>(await this.request(`complaints?${q}`))).map((r) => ({
      ...r,
      confidence: Number(r.confidence),
    }));
  }

  async departmentEmail(code: DepartmentCode): Promise<string | null> {
    const q = new URLSearchParams({ select: 'contact_email', code: `eq.${code}`, limit: '1' });
    const [row] = await this.rows<{ contact_email: string }>(await this.request(`departments?${q}`));
    return row?.contact_email ?? null;
  }

  async audit(entry: AuditEntry): Promise<void> {
    const res = await this.request('complaint_audit', {
      method: 'POST',
      headers: { prefer: 'return=minimal' },
      body: JSON.stringify({ ...entry, actor: 'system' }),
    });
    if (!res.ok) throw new DataSourceError(`supabase_http_${res.status}`);
  }

  async updateComplaint(id: number, patch: ComplaintPatch): Promise<ComplaintRecord> {
    const res = await this.request(`complaints?id=eq.${Number(id)}&select=${COLUMNS}`, {
      method: 'PATCH',
      headers: { prefer: 'return=representation' },
      body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
    });
    const [row] = await this.rows<ComplaintRecord>(res);
    if (!row) throw new DataSourceError('supabase_complaint_missing');
    return { ...row, confidence: Number(row.confidence) };
  }

  async hasReview(complaintId: number): Promise<boolean> {
    const q = new URLSearchParams({ select: 'id', complaint_id: `eq.${Number(complaintId)}`, limit: '1' });
    return (await this.rows(await this.request(`complaint_reviews?${q}`))).length > 0;
  }

  async addReview(review: NewReview): Promise<boolean> {
    const res = await this.request('complaint_reviews', { method: 'POST', headers: { prefer: 'return=minimal' }, body: JSON.stringify(review) });
    if (res.status === 409) return false; // the one-first-review index
    if (!res.ok) throw new DataSourceError(`supabase_http_${res.status}`);
    return true;
  }

  async firstReviews(limit: number): Promise<ReviewedComplaint[]> {
    const q = new URLSearchParams({
      select: 'complaint_id,action,from_priority,from_department,to_priority,to_department,triage_source,first_review,note,created_at,complaints(complaint_code,details)',
      first_review: 'is.true',
      order: 'created_at.desc',
      limit: String(limit),
    });
    type Row = Omit<ReviewedComplaint, 'complaint_code' | 'details'> & { complaints: { complaint_code: string; details: string } | null };
    const rows = await this.rows<Row>(await this.request(`complaint_reviews?${q}`));
    return rows
      .filter((r) => r.complaints)
      .map(({ complaints, ...r }) => ({ ...r, complaint_code: complaints!.complaint_code, details: complaints!.details }));
  }
}

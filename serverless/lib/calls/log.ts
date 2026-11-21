/**
 * What each voice call did (db/003 call_actions), for the after-call summary.
 * Only structured facts are stored (codes, doctor, date, department), never
 * free text from the caller.
 */
import { DataSourceError } from '../data/types.js';

export type CallActionKind = 'booked' | 'rescheduled' | 'cancelled' | 'complaint_filed';

export interface CallAction {
  call_id: string;
  action: CallActionKind;
  /** APT-XXXXXX or CMP-XXXXXX */
  reference: string;
  details: Record<string, string | number | boolean | null>;
  email: string | null;
  created_at: string;
}

export interface CallLog {
  record(entry: Omit<CallAction, 'created_at'>): Promise<void>;
  list(callId: string): Promise<CallAction[]>;
  /** True the first time for a call, false after: one summary email per call. */
  claimSummary(callId: string): Promise<boolean>;
}

export class MemoryCallLog implements CallLog {
  readonly actions: CallAction[] = [];
  private readonly summarized = new Set<string>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  async record(entry: Omit<CallAction, 'created_at'>): Promise<void> {
    this.actions.push({ ...entry, created_at: this.now().toISOString() });
  }

  async list(callId: string): Promise<CallAction[]> {
    return this.actions.filter((a) => a.call_id === callId);
  }

  async claimSummary(callId: string): Promise<boolean> {
    if (this.summarized.has(callId)) return false;
    this.summarized.add(callId);
    return true;
  }
}

export class SupabaseCallLog implements CallLog {
  private readonly base: string;
  private readonly doFetch: typeof fetch;

  constructor(private readonly opts: { url: string; serviceKey: string; fetch?: typeof fetch; timeoutMs?: number }) {
    this.base = `${opts.url.replace(/\/+$/, '')}/rest/v1/call_actions`;
    this.doFetch = opts.fetch ?? fetch;
  }

  private async request(query: string, init: RequestInit = {}): Promise<Response> {
    try {
      return await this.doFetch(`${this.base}${query}`, {
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

  async record(entry: Omit<CallAction, 'created_at'>): Promise<void> {
    const res = await this.request('', { method: 'POST', headers: { prefer: 'return=minimal' }, body: JSON.stringify(entry) });
    if (!res.ok) throw new DataSourceError(`supabase_http_${res.status}`);
  }

  async list(callId: string): Promise<CallAction[]> {
    const q = new URLSearchParams({
      select: 'call_id,action,reference,details,email,created_at',
      call_id: `eq.${callId}`,
      action: 'neq.summary_sent',
      order: 'created_at.asc',
    });
    const res = await this.request(`?${q}`);
    if (!res.ok) throw new DataSourceError(`supabase_http_${res.status}`);
    return (await res.json()) as CallAction[];
  }

  async claimSummary(callId: string): Promise<boolean> {
    const res = await this.request('', {
      method: 'POST',
      headers: { prefer: 'return=minimal' },
      body: JSON.stringify({ call_id: callId, action: 'summary_sent', reference: callId }),
    });
    if (res.status === 409) return false; // unique index: already sent
    if (!res.ok) throw new DataSourceError(`supabase_http_${res.status}`);
    return true;
  }
}

import { describe, expect, it } from 'vitest';
import { SupabaseRepository } from '../lib/data/supabase.js';
import { DataSourceError, contactKey, type NewComplaint } from '../lib/data/types.js';

const row = {
  id: 1,
  complaint_code: 'CMP-ABC234',
  patient_name: 'Test Patient',
  email: 'patient@example.test',
  phone: '+923001234567',
  details: 'Charged twice',
  details_hash: 'h',
  channel: 'web',
  category_hint: null,
  priority_hint: null,
  priority: 'Medium',
  department_code: 'billing',
  category: 'Duplicate charge',
  sentiment: 'Negative',
  suggested_action: 'Refund',
  confidence: '0.90',
  triage_source: 'ai',
  emergency: false,
  needs_review: false,
  status: 'Pending',
  created_at: '2026-11-21T10:00:00Z',
};

function repo(respond: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const r = new SupabaseRepository({
    url: 'https://abc.supabase.co/',
    serviceKey: 'service-key',
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return respond(String(url), init ?? {});
    }) as typeof fetch,
  });
  return { r, calls };
}

const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('SupabaseRepository', () => {
  it('authenticates with the service key and URL-encodes patient values in filters', async () => {
    const { r, calls } = repo(() => ok([]));
    await r.isDuplicate(contactKey(' Odd+Name&x=1@Example.test ', '0300'), 'abc');
    const url = new URL(calls[0]!.url);
    expect(url.origin + url.pathname).toBe('https://abc.supabase.co/rest/v1/complaints');
    expect(url.searchParams.get('contact_key')).toBe('eq.odd+name&x=1@example.test');
    expect(url.searchParams.get('details_hash')).toBe('eq.abc');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.apikey).toBe('service-key');
    expect(headers.authorization).toBe('Bearer service-key');
  });

  it('inserts with JSON.stringify and converts numeric confidence', async () => {
    const { r, calls } = repo(() => ok([row], 201));
    const result = await r.insert({ ...row, confidence: 0.9 } as unknown as NewComplaint);
    expect(result).toMatchObject({ ok: true, record: { confidence: 0.9 } });
    expect(calls[0]!.init.method).toBe('POST');
    expect(JSON.parse(String(calls[0]!.init.body)).details).toBe('Charged twice');
    expect((calls[0]!.init.headers as Record<string, string>).prefer).toBe('return=representation');
  });

  it('maps the duplicate constraint to a duplicate result, and other conflicts to an error', async () => {
    const dup = repo(() => ok({ code: '23505', message: 'duplicate key value violates unique constraint "complaints_no_duplicate_contact"' }, 409));
    await expect(dup.r.insert(row as unknown as NewComplaint)).resolves.toEqual({ ok: false, reason: 'duplicate' });
    const other = repo(() => ok({ code: '23505', message: 'complaints_complaint_code_key' }, 409));
    await expect(other.r.insert(row as unknown as NewComplaint)).rejects.toBeInstanceOf(DataSourceError);
  });

  it('turns HTTP errors and timeouts into DataSourceError', async () => {
    const down = repo(() => new Response('', { status: 500 }));
    await expect(down.r.list(10)).rejects.toThrow('supabase_http_500');
    const slow = new SupabaseRepository({
      url: 'https://abc.supabase.co',
      serviceKey: 'k',
      timeoutMs: 20,
      fetch: ((_u: unknown, init?: RequestInit) =>
        new Promise((_res, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)))) as typeof fetch,
    });
    await expect(slow.findByCode('CMP-ABC234')).rejects.toThrow('supabase_timeout');
  });

  it('reads department emails and writes audit entries', async () => {
    const { r, calls } = repo((url) => (url.includes('departments') ? ok([{ contact_email: 'billing@medilens.test' }]) : new Response(null, { status: 201 })));
    await expect(r.departmentEmail('billing')).resolves.toBe('billing@medilens.test');
    await r.audit({ complaint_id: 1, action: 'CREATED', details: { priority: 'Medium' } });
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({ complaint_id: 1, action: 'CREATED', details: { priority: 'Medium' }, actor: 'system' });
  });
});

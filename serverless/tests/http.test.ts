import { describe, expect, it } from 'vitest';
import { createApp } from '../lib/http.js';
import { DataSourceError } from '../lib/data/types.js';
import { LogEmailSender, MemoryRepository, VALID, fakeClassifier, post, testConfig } from './helpers.js';

const ORIGIN = 'https://medilens-demo.example';

function app(over: Parameters<typeof testConfig>[0] = {}) {
  const repository = new MemoryRepository();
  const email = new LogEmailSender();
  const a = createApp({ config: testConfig(over), repository, email, classifier: fakeClassifier().classify });
  return { a, repository, email };
}

describe('POST /api/complaints', () => {
  it('creates a complaint and returns the triage, with security headers', async () => {
    const { a } = app();
    const res = await a.submitComplaint(post('/api/complaints', VALID, { origin: ORIGIN }));
    expect(res.status).toBe(201);
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    const body = await res.json();
    expect(body).toMatchObject({ success: true, department: 'billing', priority: 'Medium' });
    expect(body.message).toMatch(/^Your complaint has been submitted\. Your complaint code is CMP-[A-Z0-9]{6}$/);
  });

  it('accepts field names in any case, like the n8n workflow', async () => {
    const { a } = app();
    const res = await a.submitComplaint(
      post('/api/complaints', { Name: VALID.name, EMAIL: VALID.email, Phone: VALID.phone, Details: VALID.details }),
    );
    expect(res.status).toBe(201);
  });

  it('returns 409 with the n8n duplicate body', async () => {
    const { a } = app();
    await a.submitComplaint(post('/api/complaints', VALID));
    const res = await a.submitComplaint(post('/api/complaints', VALID));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ success: false, error_code: 'DUPLICATE_COMPLAINT' });
  });

  it.each([
    [{ ...VALID, email: undefined }, 'email is required'],
    [{ ...VALID, email: 'not-an-email' }, 'email:'],
    [{ ...VALID, phone: 'call me' }, 'phone:'],
    [{ ...VALID, details: 'too short' }, 'details: details must be at least 10 characters'],
    [{ ...VALID, priority: 'Urgent' }, 'priority:'],
  ])('rejects invalid input with a 400 that names the field', async (body, message) => {
    const { a } = app();
    const res = await a.submitComplaint(post('/api/complaints', body));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error_code).toBe('VALIDATION_ERROR');
    expect(json.error).toContain(message);
    expect(JSON.stringify(json)).not.toContain('call me');
  });

  it('rejects non-JSON, oversized and malformed bodies', async () => {
    const { a } = app();
    const text = new Request('https://api.example/api/complaints', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'hi' });
    expect((await a.submitComplaint(text)).status).toBe(415);
    expect((await a.submitComplaint(post('/api/complaints', { ...VALID, details: 'x'.repeat(20_000) }))).status).toBe(413);
    expect((await a.submitComplaint(post('/api/complaints', '{"name":'))).status).toBe(400);
  });

  it('answers wrong methods with 405 and an Allow header', async () => {
    const { a } = app();
    const res = await a.submitComplaint(new Request('https://api.example/api/complaints'));
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST, OPTIONS');
  });

  it('allows configured origins, answers their preflight, and blocks others', async () => {
    const { a } = app();
    const pre = await a.submitComplaint(new Request('https://api.example/api/complaints', { method: 'OPTIONS', headers: { origin: ORIGIN } }));
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-methods')).toContain('POST');
    const evil = await a.submitComplaint(post('/api/complaints', VALID, { origin: 'https://evil.example' }));
    expect(evil.status).toBe(403);
    expect(evil.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('rate-limits each IP to 10 requests a minute', async () => {
    const { a } = app();
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      statuses.push((await a.submitComplaint(post('/api/complaints', { ...VALID, email: `p${i}@example.test` }))).status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 201)).toBe(true);
    const last = await a.submitComplaint(post('/api/complaints', VALID));
    expect(last.status).toBe(429);
    expect(Number(last.headers.get('retry-after'))).toBeGreaterThan(0);
    const otherIp = await a.submitComplaint(post('/api/complaints', { ...VALID, email: 'z@example.test' }, { 'x-real-ip': '198.51.100.1' }));
    expect(otherIp.status).toBe(201);
  });

  it('returns 503 without leaking details when the database is down', async () => {
    const repository = new MemoryRepository();
    repository.isDuplicate = async () => {
      throw new DataSourceError('supabase_timeout');
    };
    const a = createApp({ config: testConfig(), repository, email: new LogEmailSender(), classifier: null });
    const res = await a.submitComplaint(post('/api/complaints', VALID));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toMatchObject({ success: false, error_code: 'SERVER_ERROR' });
    expect(JSON.stringify(body)).not.toContain('supabase');
  });
});

describe('POST /api/complaint-status', () => {
  it('returns the status for the right code and contact, 404 otherwise', async () => {
    const { a } = app();
    const created = await (await a.submitComplaint(post('/api/complaints', VALID))).json();
    const ok = await a.complaintStatus(post('/api/complaint-status', { complaint_code: created.complaint_code.toLowerCase(), email: VALID.email }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ success: true, status: 'Pending', department_name: 'Billing & Insurance' });

    const wrong = await a.complaintStatus(post('/api/complaint-status', { complaint_code: created.complaint_code, email: 'x@example.test' }));
    expect(wrong.status).toBe(404);
    expect((await wrong.json()).spoken_message).toMatch(/couldn't find/);
  });

  it('requires an email or phone', async () => {
    const { a } = app();
    const res = await a.complaintStatus(post('/api/complaint-status', { complaint_code: 'CMP-ABC123' }));
    expect(res.status).toBe(400);
  });
});

describe('GET /api/complaints-summary', () => {
  const get = (headers: Record<string, string> = {}) =>
    new Request('https://api.example/api/complaints-summary', { headers: { 'x-real-ip': '203.0.113.9', ...headers } });

  it('needs the admin key', async () => {
    const { a } = app();
    expect((await a.complaintsSummary(get())).status).toBe(401);
    expect((await a.complaintsSummary(get({ 'x-admin-key': 'wrong' }))).status).toBe(401);
    const ok = await a.complaintsSummary(get({ 'x-admin-key': 'admin-test-key' }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ summary: { total: 0 }, recordCount: 0 });
  });

  it('is switched off when no admin key is configured', async () => {
    const { a } = app({ adminApiKey: null });
    expect((await a.complaintsSummary(get({ 'x-admin-key': '' }))).status).toBe(401);
  });
});

describe('GET /api/health', () => {
  it('reports how the service is configured, without secrets', async () => {
    const { a } = app();
    const res = await a.health(new Request('https://api.example/api/health'));
    expect(await res.json()).toMatchObject({ status: 'ok', data_source: 'demo', ai_triage: 'gemini', email: 'log' });
  });
});

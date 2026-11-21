import { describe, expect, it } from 'vitest';
import { ComplaintService } from '../lib/complaints/service.js';
import { slaSweep } from '../lib/complaints/sla.js';
import { SupabaseRepository } from '../lib/data/supabase.js';
import { createApp } from '../lib/http.js';
import { FailingEmailSender, LogEmailSender, MemoryRepository, VALID, fakeClassifier, testConfig } from './helpers.js';
import type { AiTriage } from '../lib/complaints/triage.js';

const START = new Date('2026-11-23T05:00:00Z');

async function setup<E extends LogEmailSender | FailingEmailSender = LogEmailSender>(email: E = new LogEmailSender() as E) {
  let now = START;
  const repository = new MemoryRepository(() => now);
  const file = async (details: string, ai: AiTriage, contact = `${Math.random().toString(36).slice(2)}@example.test`) => {
    const svc = new ComplaintService({ repository, email: new LogEmailSender(), classifier: fakeClassifier(ai).classify });
    const r = await svc.submit({ ...VALID, email: contact, details, channel: 'web' });
    if (r.status !== 201) throw new Error('setup');
    return r.body.complaint_code;
  };
  const deps = { repository, email, now: () => now };
  const advanceHours = (h: number) => (now = new Date(START.getTime() + h * 3_600_000));
  return { repository, email, deps, file, advanceHours };
}

const billing: AiTriage = { priority: 'Medium', department: 'billing', category: 'Billing', sentiment: 'Negative', suggested_action: 'Refund within 72 hours.', confidence: 0.9 };
const nursing: AiTriage = { ...billing, department: 'nursing', priority: 'High', suggested_action: 'Ward manager to call today.' };

describe('slaSweep', () => {
  it("escalates only unresolved complaints past their department's target, once", async () => {
    const { deps, file, advanceHours, repository } = await setup();
    const nurseCode = await file('Nobody answered the call bell all night on the ward', nursing); // 24 h target
    const billCode = await file('I was charged twice for the same blood test', billing); // 72 h target

    advanceHours(23);
    expect((await slaSweep(deps)).escalated).toBe(0);

    advanceHours(25);
    const first = await slaSweep(deps);
    expect(first.complaints.map((c) => c.complaint_code)).toEqual([nurseCode]);
    expect(first.complaints[0]).toMatchObject({ department: 'nursing', hours_open: 25, alerted: true, patient_told: true });
    expect((await slaSweep(deps)).escalated).toBe(0); // never twice

    // Resolved before its deadline: never escalated.
    repository.complaints.find((c) => c.complaint_code === billCode)!.status = 'Resolved';
    advanceHours(100);
    expect((await slaSweep(deps)).escalated).toBe(0);
  });

  it('alerts the department, tells the patient, and audits it', async () => {
    const { deps, file, advanceHours, email, repository } = await setup();
    const code = await file('Nobody answered the call bell all night on the ward', nursing);
    advanceHours(30);
    await slaSweep(deps);
    const [alert, patient] = email.sent;
    expect(alert!.subject).toBe(`[OVERDUE] Complaint ${code} (High) open 30 h, target 24 h`);
    expect(alert!.to).toBe('nursing@medilens.test');
    expect(patient!.subject).toBe(`Your MediLens complaint ${code} has been escalated`);
    expect(repository.auditLog.at(-1)).toMatchObject({ action: 'SLA_ESCALATED', details: { hours_open: 30, target_hours: 24, alerted: true, patient_told: true } });
  });

  it('records failed emails instead of retrying, so nothing is escalated twice', async () => {
    const { deps, file, advanceHours, repository } = await setup(new FailingEmailSender());
    await file('Nobody answered the call bell all night on the ward', nursing);
    advanceHours(30);
    const r = await slaSweep(deps);
    expect(r.complaints[0]).toMatchObject({ alerted: false, patient_told: false });
    expect(repository.auditLog.map((a) => a.action)).toEqual(expect.arrayContaining(['SLA_ALERT_FAILED', 'SLA_PATIENT_EMAIL_FAILED', 'SLA_ESCALATED']));
    expect((await slaSweep(deps)).escalated).toBe(0);
  });
});

describe('POST /api/sla-sweep', () => {
  const call = (app: ReturnType<typeof createApp>, auth?: string, method = 'POST') =>
    app.slaSweep(new Request('https://api.example/api/sla-sweep', { method, headers: auth ? { authorization: auth } : {} }));

  it('is off without CRON_SECRET and needs the right bearer token', async () => {
    const off = createApp({ config: testConfig(), repository: new MemoryRepository(), email: new LogEmailSender(), classifier: null });
    expect((await call(off, 'Bearer anything')).status).toBe(503);

    const app = createApp({ config: testConfig({ cronSecret: 'cron-test-secret' }), repository: new MemoryRepository(), email: new LogEmailSender(), classifier: null });
    expect((await call(app)).status).toBe(401);
    expect((await call(app, 'Bearer wrong')).status).toBe(401);
    expect((await call(app, 'cron-test-secret')).status).toBe(401);
    expect((await call(app, 'Bearer cron-test-secret', 'GET')).status).toBe(405);
    const ok = await call(app, 'Bearer cron-test-secret');
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ success: true, escalated: 0, complaints: [] });
  });

  it('shows in health', async () => {
    const app = createApp({ config: testConfig({ cronSecret: 's' }), repository: new MemoryRepository(), email: new LogEmailSender(), classifier: null });
    const body = await (await app.health(new Request('https://api.example/api/health'))).json();
    expect(body.sla_monitor).toBe('on');
  });
});

describe('SupabaseRepository.claimOverdue', () => {
  it('calls the claim function', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const repo = new SupabaseRepository({
      url: 'https://abc.supabase.co',
      serviceKey: 'k',
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init: init ?? {} });
        return new Response(JSON.stringify([{ id: 1, complaint_code: 'CMP-ABC234', confidence: '0.80' }]), { status: 200 });
      }) as typeof fetch,
    });
    const rows = await repo.claimOverdue(50);
    expect(calls[0]!.url).toBe('https://abc.supabase.co/rest/v1/rpc/claim_overdue_complaints');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ p_limit: 50 });
    expect(rows[0]!.confidence).toBe(0.8);
  });
});

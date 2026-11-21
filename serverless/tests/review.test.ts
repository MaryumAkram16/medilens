import { describe, expect, it } from 'vitest';
import { ComplaintService } from '../lib/complaints/service.js';
import { reviewComplaint, triageAccuracy } from '../lib/complaints/review.js';
import { createApp } from '../lib/http.js';
import { SupabaseRepository } from '../lib/data/supabase.js';
import { LogEmailSender, MemoryRepository, VALID, fakeClassifier, post, testConfig } from './helpers.js';

const NOW = new Date('2026-11-23T05:00:00Z');

async function setup() {
  const repository = new MemoryRepository(() => NOW);
  const email = new LogEmailSender();
  const service = new ComplaintService({ repository, email, classifier: fakeClassifier().classify });
  const filed = await service.submit({ ...VALID, channel: 'web' });
  if (filed.status !== 201) throw new Error('setup failed');
  const deps = { repository, email, now: () => NOW };
  return { repository, email, deps, code: filed.body.complaint_code, service };
}

describe('reviewComplaint', () => {
  it('confirms a correct triage as the first review', async () => {
    const { deps, code, repository } = await setup();
    const r = await reviewComplaint(deps, { complaint_code: code, confirm: true });
    expect(r).toMatchObject({ status: 200, body: { review: 'confirmed', first_review: true, department: 'billing' } });
    expect(repository.reviews[0]).toMatchObject({ action: 'confirmed', from_department: 'billing', to_department: 'billing', first_review: true, triage_source: 'ai' });
    expect(repository.complaints[0]!.needs_review).toBe(false);
  });

  it('records a correction, reroutes, and alerts the new department', async () => {
    const { deps, code, repository, email } = await setup();
    const before = email.sent.length;
    const r = await reviewComplaint(deps, { complaint_code: code, department: 'laboratory', priority: 'High', note: 'It is about a lost sample' });
    expect(r.body).toMatchObject({ review: 'corrected', department: 'laboratory', priority: 'High', notified: ['department'] });
    expect(repository.reviews[0]).toMatchObject({ action: 'corrected', from_priority: 'Medium', from_department: 'billing', to_priority: 'High', to_department: 'laboratory' });
    expect(email.sent.slice(before)[0]!.subject).toBe(`Complaint ${code} reassigned to Laboratory & Diagnostics (High)`);
    expect(repository.auditLog.at(-1)).toMatchObject({ action: 'CORRECTED' });
  });

  it('emails the patient when the status changes, and counts it as a review the first time', async () => {
    const { deps, code, repository, email } = await setup();
    const before = email.sent.length;
    const r = await reviewComplaint(deps, { complaint_code: code, status: 'In Review' });
    expect(r.body).toMatchObject({ status: 'In Review', review: 'confirmed', notified: ['patient'] });
    expect(email.sent.slice(before)[0]).toMatchObject({ to: VALID.email, subject: `Update on your MediLens complaint ${code}: In Review` });

    const resolved = await reviewComplaint(deps, { complaint_code: code, status: 'Resolved' });
    expect(resolved.body).toMatchObject({ status: 'Resolved', review: 'none' }); // later status changes aren't reviews
    expect(repository.reviews).toHaveLength(1);
  });

  it('keeps only the first review for accuracy; later corrections are history', async () => {
    const { deps, code, repository } = await setup();
    await reviewComplaint(deps, { complaint_code: code, confirm: true });
    const later = await reviewComplaint(deps, { complaint_code: code, department: 'facilities' });
    expect(later.body).toMatchObject({ review: 'corrected', first_review: false });
    expect(repository.reviews.map((r) => r.first_review)).toEqual([true, false]);
  });

  it('returns 404 for an unknown code', async () => {
    const { deps } = await setup();
    expect((await reviewComplaint(deps, { complaint_code: 'CMP-NOPE99', confirm: true })).status).toBe(404);
  });
});

describe('triageAccuracy', () => {
  it('scores first reviews per source and exports corrected labels as cases', async () => {
    const { deps, repository, service, code } = await setup();
    await reviewComplaint(deps, { complaint_code: code, confirm: true });
    const second = await service.submit({ ...VALID, email: 'b@example.test', details: 'Nobody answered the call bell on the night ward', channel: 'web' });
    if (second.status !== 201) throw new Error('setup');
    await reviewComplaint(deps, { complaint_code: second.body.complaint_code, department: 'nursing', priority: 'High' });

    const a = triageAccuracy(await repository.firstReviews(100));
    expect(a.reviewed).toBe(2);
    expect(a.by_source.ai).toEqual({ reviewed: 2, both_correct: 1, department_correct: 1, priority_correct: 1, accuracy: 0.5 });
    expect(a.by_source.keywords.accuracy).toBeNull();
    expect(a.recent_corrections).toEqual([{ complaint_code: second.body.complaint_code, triage_source: 'ai', from: 'Medium billing', to: 'High nursing' }]);
    expect(a.cases).toContainEqual({
      id: second.body.complaint_code,
      text: 'Nobody answered the call bell on the night ward',
      expected_priority: 'High',
      expected_department: 'nursing',
    });
  });
});

describe('staff endpoints', () => {
  const admin = { 'x-admin-key': 'admin-test-key' };

  it('need the admin key', async () => {
    const app = createApp({ config: testConfig(), repository: new MemoryRepository(), email: new LogEmailSender(), classifier: null });
    expect((await app.complaintUpdate(post('/api/complaint-update', { complaint_code: 'CMP-ABC234', confirm: true }))).status).toBe(401);
    expect((await app.triageAccuracy(new Request('https://api.example/api/triage-accuracy'))).status).toBe(401);
    const off = createApp({ config: testConfig({ adminApiKey: null }), repository: new MemoryRepository(), email: new LogEmailSender(), classifier: null });
    expect((await off.triageAccuracy(new Request('https://api.example/api/triage-accuracy', { headers: admin }))).status).toBe(401);
  });

  it('review a complaint and report live accuracy', async () => {
    const app = createApp({ config: testConfig(), repository: new MemoryRepository(), email: new LogEmailSender(), classifier: fakeClassifier().classify });
    const { complaint_code } = await (await app.submitComplaint(post('/api/complaints', VALID))).json();
    const res = await app.complaintUpdate(post('/api/complaint-update', { complaint_code, department: 'pharmacy' }, admin));
    expect(res.status).toBe(200);
    const acc = await (await app.triageAccuracy(new Request('https://api.example/api/triage-accuracy', { headers: admin }))).json();
    expect(acc).toMatchObject({ success: true, reviewed: 1, by_source: { ai: { accuracy: 0 } } });
  });

  it('validate the request', async () => {
    const app = createApp({ config: testConfig(), repository: new MemoryRepository(), email: new LogEmailSender(), classifier: null });
    const empty = await app.complaintUpdate(post('/api/complaint-update', { complaint_code: 'CMP-ABC234' }, admin));
    expect(empty.status).toBe(400);
    const badDept = await app.complaintUpdate(post('/api/complaint-update', { complaint_code: 'CMP-ABC234', department: 'finance' }, admin));
    expect(badDept.status).toBe(400);
  });
});

describe('SupabaseRepository review methods', () => {
  it('patches by id, maps the one-first-review index to false, and embeds the complaint', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    let reviewStatus = 201;
    const repo = new SupabaseRepository({
      url: 'https://abc.supabase.co',
      serviceKey: 'k',
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init: init ?? {} });
        if (init?.method === 'PATCH') return new Response(JSON.stringify([{ id: 1, confidence: '0.90', department_code: 'billing' }]), { status: 200 });
        if (init?.method === 'POST') return new Response(null, { status: reviewStatus });
        return new Response(JSON.stringify([{ complaint_id: 1, first_review: true, complaints: { complaint_code: 'CMP-ABC234', details: 'x' } }]), { status: 200 });
      }) as typeof fetch,
    });
    await repo.updateComplaint(1, { status: 'Resolved' });
    expect(calls[0]!.url).toContain('/complaints?id=eq.1');
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({ status: 'Resolved' });
    const review = { complaint_id: 1, action: 'confirmed', from_priority: 'Medium', from_department: 'billing', to_priority: 'Medium', to_department: 'billing', triage_source: 'ai', first_review: true, note: null } as const;
    expect(await repo.addReview(review)).toBe(true);
    reviewStatus = 409;
    expect(await repo.addReview(review)).toBe(false);
    const [first] = await repo.firstReviews(10);
    expect(first).toMatchObject({ complaint_code: 'CMP-ABC234', details: 'x' });
    expect(new URL(calls.at(-1)!.url).searchParams.get('first_review')).toBe('is.true');
  });
});

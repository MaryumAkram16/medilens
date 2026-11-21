import { describe, expect, it } from 'vitest';
import { EMERGENCY_NOTICE } from '../lib/complaints/catalog.js';
import { ComplaintService, detailsHash, newComplaintCode, spellCode, summarize } from '../lib/complaints/service.js';
import type { SubmitComplaintInput } from '../lib/complaints/schema.js';
import { FailingEmailSender, LogEmailSender, MemoryRepository, VALID, billingAi, fakeClassifier } from './helpers.js';

const input = (over: Partial<SubmitComplaintInput> = {}): SubmitComplaintInput => ({ ...VALID, channel: 'web', ...over });

function setup(opts: { classifier?: ReturnType<typeof fakeClassifier>['classify'] | null; override?: string } = {}) {
  const repository = new MemoryRepository(() => new Date('2026-11-21T10:00:00Z'));
  const email = new LogEmailSender();
  const ai = fakeClassifier();
  let n = 0;
  const service = new ComplaintService({
    repository,
    email,
    classifier: opts.classifier === undefined ? ai.classify : opts.classifier,
    alertEmailOverride: opts.override ?? null,
    newCode: () => `CMP-TEST${String(++n).padStart(2, '0')}`,
  });
  return { repository, email, ai, service };
}

describe('ComplaintService.submit', () => {
  it('saves the complaint with the AI triage and routes it to that department', async () => {
    const { service, repository, email } = setup();
    const result = await service.submit(input());

    expect(result.status).toBe(201);
    expect(result.body).toMatchObject({
      success: true,
      message: 'Your complaint has been submitted. Your complaint code is CMP-TEST01',
      complaint_code: 'CMP-TEST01',
      priority: 'Medium',
      department: 'billing',
      department_name: 'Billing & Insurance',
      expected_response_hours: 72,
      needs_review: false,
      emergency: false,
      emergency_notice: null,
    });
    expect(repository.complaints[0]).toMatchObject({ triage_source: 'ai', confidence: 0.9, category: 'Duplicate charge' });

    const [alert, confirmation] = email.sent;
    expect(alert!.to).toBe('billing@medilens.test');
    expect(alert!.subject).toBe('New Medium complaint CMP-TEST01 for Billing & Insurance');
    expect(alert!.text).toContain('Suggested action: Remove the duplicate charge');
    expect(confirmation!.to).toBe(VALID.email);
    expect(confirmation!.text).toContain('CMP-TEST01');
  });

  it("keeps the patient's chosen priority as a hint and records when triage disagrees", async () => {
    const { service, repository } = setup();
    await service.submit(input({ priority: 'High', type: 'Billing' }));
    expect(repository.complaints[0]).toMatchObject({ priority: 'Medium', priority_hint: 'High', category_hint: 'Billing' });
    expect(repository.auditLog[0]!.details).toMatchObject({ priority_hint: 'High', hint_overridden: true });
  });

  it('rejects a duplicate before calling the AI, ignoring case and spacing', async () => {
    const { service, ai } = setup();
    await service.submit(input());
    const again = await service.submit(input({ email: 'PATIENT@example.test', details: `  ${VALID.details.toUpperCase()}  ` }));
    expect(again).toEqual({
      status: 409,
      body: { success: false, error_code: 'DUPLICATE_COMPLAINT', error: 'You have already filed this complaint before.' },
    });
    expect(ai.calls).toHaveLength(1);
  });

  it('flags an emergency, tags the alert and puts the notice first in every answer', async () => {
    const { service, email } = setup();
    const result = await service.submit(input({ details: 'My father has chest pain and nobody is attending him in the ward' }));
    if (result.status !== 201) throw new Error('expected 201');
    expect(result.body).toMatchObject({ emergency: true, priority: 'High', department: 'emergency', needs_review: true });
    expect(result.body.emergency_notice).toBe(EMERGENCY_NOTICE);
    expect(result.body.spoken_message.startsWith(EMERGENCY_NOTICE)).toBe(true);
    expect(email.sent[0]!.subject.startsWith('[EMERGENCY] ')).toBe(true);
    expect(email.sent[1]!.text).toContain(EMERGENCY_NOTICE);
  });

  it('triages with keyword rules and asks for review when no AI is configured', async () => {
    const { service, repository } = setup({ classifier: null });
    await service.submit(input({ details: 'My blood test report has been missing for a week now' }));
    expect(repository.complaints[0]).toMatchObject({ triage_source: 'keywords', department_code: 'laboratory', needs_review: true });
  });

  it('sends department alerts to the override inbox in demo mode', async () => {
    const { service, email } = setup({ override: 'owner@example.test' });
    await service.submit(input());
    expect(email.sent[0]!.to).toBe('owner@example.test');
  });

  it('still saves and answers when email fails, and audits the failure', async () => {
    const repository = new MemoryRepository();
    const service = new ComplaintService({ repository, email: new FailingEmailSender(), classifier: fakeClassifier().classify });
    const result = await service.submit(input());
    expect(result.status).toBe(201);
    expect(repository.complaints).toHaveLength(1);
    expect(repository.auditLog.map((a) => a.action)).toEqual(['CREATED', 'DEPARTMENT_ALERT_FAILED', 'PATIENT_EMAIL_FAILED']);
  });

  it('gives a spoken answer that spells the code', async () => {
    const { service } = setup();
    const result = await service.submit(input());
    if (result.status !== 201) throw new Error('expected 201');
    expect(result.body.spoken_message).toBe(
      'Your complaint has been submitted and sent to Billing & Insurance. Your complaint code is C M P, T E S T 0 1. They aim to respond within 72 hours.',
    );
  });
});

describe('ComplaintService.status', () => {
  it('needs the code plus the matching email or phone', async () => {
    const { service } = setup();
    await service.submit(input());
    await expect(service.status('CMP-TEST01', { email: VALID.email })).resolves.toMatchObject({
      found: true,
      status: 'Pending',
      department_name: 'Billing & Insurance',
    });
    await expect(service.status('CMP-TEST01', { phone: '03001234567+92' })).resolves.toMatchObject({ found: false });
    await expect(service.status('CMP-TEST01', { phone: '+92-300-1234567' })).resolves.toMatchObject({ found: true });
  });

  it('answers the same for a wrong contact and an unknown code', async () => {
    const { service } = setup();
    await service.submit(input());
    await expect(service.status('CMP-TEST01', { email: 'someone@example.test' })).resolves.toEqual({ found: false });
    await expect(service.status('CMP-NOPE99', { email: VALID.email })).resolves.toEqual({ found: false });
  });
});

describe('helpers', () => {
  it('makes readable codes without 0/O or 1/I', () => {
    for (let i = 0; i < 200; i++) expect(newComplaintCode()).toMatch(/^CMP-[A-HJ-NP-Z2-9]{6}$/);
  });

  it('hashes normalised text', () => {
    expect(detailsHash('Bill  was WRONG')).toBe(detailsHash(' bill was wrong '));
    expect(detailsHash('bill was wrong')).not.toBe(detailsHash('bill was right'));
  });

  it('spells codes for speech', () => {
    expect(spellCode('CMP-47K29X')).toBe('C M P, 4 7 K 2 9 X');
  });

  it('summarises like the n8n node, plus review and emergency counts', async () => {
    const { service, repository } = setup();
    await service.submit(input());
    await service.submit(input({ email: 'b@example.test', details: 'There is chest pain and no doctor is coming to see him' }));
    const s = summarize(repository.complaints, new Date('2026-11-21T10:00:00Z'));
    expect(s.summary).toEqual({
      total: 2,
      pending: 2,
      resolved: 0,
      lowPriority: 0,
      mediumPriority: 1,
      highPriority: 1,
      needsReview: 1,
      emergency: 1,
      byCategory: { 'Duplicate charge': 2 },
      byDepartment: { billing: 1, emergency: 1 },
    });
    expect(s).toMatchObject({ recordCount: 2, timestamp: '2026-11-21T10:00:00.000Z' });
  });

  it('exposes the default AI answer used by these tests', () => {
    expect(billingAi.department).toBe('billing');
  });
});

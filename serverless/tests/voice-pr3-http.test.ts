import { describe, expect, it } from 'vitest';
import { MemoryBookingRepository } from '../lib/booking/memory.js';
import { MemoryCallLog } from '../lib/calls/log.js';
import { summaryKey, summaryToken } from '../lib/calls/summary.js';
import { createApp } from '../lib/http.js';
import { signRetellBody } from '../lib/signature.js';
import type { Transcriber } from '../lib/voice/transcribe.js';
import { LogEmailSender, MemoryRepository, WEBM, fakeClassifier, post, testConfig } from './helpers.js';

const KEY = 'retell-test-key';
const NOW = new Date('2026-11-23T04:10:00Z');
const ORIGIN = 'https://medilens-demo.example';

function setup(over: Parameters<typeof testConfig>[0] = {}, opts: { transcriber?: Transcriber | null; webCallFails?: boolean } = {}) {
  const bookings = new MemoryBookingRepository(() => NOW);
  const repository = new MemoryRepository(() => NOW);
  const callLog = new MemoryCallLog(() => NOW);
  const email = new LogEmailSender();
  const webCalls: string[] = [];
  const app = createApp({
    config: testConfig({ retellApiKey: KEY, retellAgentId: 'agent_123', summarySecret: KEY, ...over }),
    repository,
    bookings,
    email,
    callLog,
    classifier: fakeClassifier().classify,
    transcriber:
      opts.transcriber !== undefined ? opts.transcriber : async () => ({ ok: true, result: { transcript: 'Mujhe bill mein do baar charge kiya gaya', language: 'mixed' } }),
    createWebCall: async (agentId) => {
      webCalls.push(agentId);
      if (opts.webCallFails) throw new Error('retell down');
      return { call_id: `call_web_${webCalls.length}`, access_token: 'short-lived-token', transport: 'gateway' as const, ice_servers: [{ urls: 'turn:turn.example.test:3478', username: 'u', credential: 'c' }] };
    },
    now: () => NOW,
  });
  return { app, bookings, repository, callLog, email, webCalls };
}

async function signed(path: string, payload: unknown) {
  const body = JSON.stringify(payload);
  return post(path, body, { 'x-retell-signature': await signRetellBody(body, KEY) });
}

const audioBody = (buf: Buffer = WEBM, mime = 'audio/webm;codecs=opus') => ({ audio_base64: buf.toString('base64'), mime_type: mime });

describe('POST /api/transcribe', () => {
  it('returns the transcript for the patient to check before submitting', async () => {
    const { app } = setup();
    const res = await app.transcribe(post('/api/transcribe', audioBody(), { origin: ORIGIN }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, transcript: 'Mujhe bill mein do baar charge kiya gaya', language: 'mixed' });
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
  });

  it('refuses types that are not audio, and files that only claim to be audio', async () => {
    const { app } = setup();
    expect((await app.transcribe(post('/api/transcribe', audioBody(WEBM, 'video/mp4')))).status).toBe(415);
    expect((await app.transcribe(post('/api/transcribe', audioBody(Buffer.from('%PDF-1.7 not audio'), 'audio/webm')))).status).toBe(415);
  });

  it('refuses recordings over the size limit', async () => {
    const { app } = setup();
    const big = Buffer.concat([WEBM, Buffer.alloc(3 * 1024 * 1024)]);
    expect((await app.transcribe(post('/api/transcribe', audioBody(big)))).status).toBe(413);
  });

  it('explains silence, failures and a missing AI key', async () => {
    const silent = setup({}, { transcriber: async () => ({ ok: true, result: { transcript: '', language: 'none' } }) });
    expect((await silent.app.transcribe(post('/api/transcribe', audioBody()))).status).toBe(422);
    const failing = setup({}, { transcriber: async () => ({ ok: false, reason: 'http_503' }) });
    expect((await failing.app.transcribe(post('/api/transcribe', audioBody()))).status).toBe(502);
    const off = setup({}, { transcriber: null });
    const res = await off.app.transcribe(post('/api/transcribe', audioBody()));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/type your complaint/);
  });

  it('allows 5 recordings a minute per IP', async () => {
    const { app } = setup({ rateLimit: { windowMs: 60_000, perIp: 100 } });
    const statuses = [];
    for (let i = 0; i < 6; i++) statuses.push((await app.transcribe(post('/api/transcribe', audioBody()))).status);
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
  });
});

describe('submit_complaint (voice tool)', () => {
  const envelope = (args: Record<string, unknown>) => ({ name: 'submit_complaint', call: { call_id: 'call_v1' }, args });

  it('files a voice complaint without an email, through the same triage, and logs it for the summary', async () => {
    const { app, repository, callLog } = setup();
    const res = await app.submitVoiceComplaint(
      await signed('/api/submit-complaint', envelope({ name: 'Test Patient', phone_no: '03001234567', details: 'I was charged twice for my blood test.' })),
    );
    const body = await res.json();
    expect(body).toMatchObject({ success: true, department: 'billing' });
    expect(body.message).toMatch(/^Your complaint has been submitted and sent to Billing & Insurance\. Your complaint code is C M P,/);
    expect(repository.complaints[0]).toMatchObject({ channel: 'voice', call_id: 'call_v1', email: null });
    expect(callLog.actions[0]).toMatchObject({ action: 'complaint_filed', reference: body.complaint_code, call_id: 'call_v1' });
  });

  it('puts the emergency notice first when the caller describes an emergency', async () => {
    const { app } = setup();
    const body = await (
      await app.submitVoiceComplaint(await signed('/api/submit-complaint', envelope({ name: 'Test Patient', phone_no: '03001234567', details: 'My mother has chest pain and nobody is helping' })))
    ).json();
    expect(body.message).toMatch(/^If this is a medical emergency, call 1122/);
  });

  it('spots a repeat of the same complaint from the same phone', async () => {
    const { app } = setup();
    const args = { name: 'Test Patient', phone_no: '03001234567', details: 'I was charged twice for my blood test.' };
    await app.submitVoiceComplaint(await signed('/api/submit-complaint', envelope(args)));
    const again = await (await app.submitVoiceComplaint(await signed('/api/submit-complaint', envelope({ ...args, phone_no: '+92 300 1234567' })))).json();
    expect(again).toMatchObject({ success: false });
    expect(again.message).toMatch(/already filed this same complaint/);
  });

  it('needs a valid Retell signature', async () => {
    const { app } = setup();
    const res = await app.submitVoiceComplaint(post('/api/submit-complaint', JSON.stringify(envelope({ name: 'x', phone_no: '03001234567', details: 'long enough text' }))));
    expect(res.status).toBe(401);
  });
});

describe('POST /api/create-web-call', () => {
  it('starts a call for the configured agent and returns a summary token for it', async () => {
    const { app, webCalls } = setup();
    const res = await app.createWebCall(post('/api/create-web-call', {}, { origin: ORIGIN }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toEqual({
      success: true,
      call_id: 'call_web_1',
      access_token: 'short-lived-token',
      transport: 'gateway',
      ice_servers: [{ urls: 'turn:turn.example.test:3478', username: 'u', credential: 'c' }],
      summary_token: summaryToken('call_web_1', summaryKey(KEY)),
    });
    expect(res.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    expect(webCalls).toEqual(['agent_123']);
    expect(JSON.stringify(body)).not.toContain(KEY);
  });

  it('is off without an agent id', async () => {
    const { app } = setup({ retellAgentId: null });
    expect((await app.createWebCall(post('/api/create-web-call', {}))).status).toBe(503);
  });

  it('checks the demo passcode when one is set, and slows down guessing', async () => {
    const { app } = setup({ webCallPasscode: 'open-sesame', rateLimit: { windowMs: 60_000, perIp: 100 } });
    expect((await app.createWebCall(post('/api/create-web-call', {}))).status).toBe(401);
    expect((await app.createWebCall(post('/api/create-web-call', { passcode: 'wrong' }))).status).toBe(401);
    expect((await app.createWebCall(post('/api/create-web-call', { passcode: ' open-sesame ' }))).status).toBe(201);
    let last = 0;
    for (let i = 0; i < 10; i++) last = (await app.createWebCall(post('/api/create-web-call', { passcode: 'wrong' }))).status;
    expect(last).toBe(429);
  });

  it('caps calls per IP and overall, because calls cost Retell minutes', async () => {
    const perIp = setup({ rateLimit: { windowMs: 60_000, perIp: 100 } });
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await perIp.app.createWebCall(post('/api/create-web-call', {}))).status);
    expect(statuses).toEqual([201, 201, 201, 429]);

    const overall = setup({ webCall: { perIpPer10Min: 100, globalPerHour: 2 }, rateLimit: { windowMs: 60_000, perIp: 100 } });
    const ips = ['198.51.100.1', '198.51.100.2', '198.51.100.3'];
    const results = [];
    for (const ip of ips) results.push((await overall.app.createWebCall(post('/api/create-web-call', {}, { 'x-real-ip': ip }))).status);
    expect(results).toEqual([201, 201, 429]);
  });

  it('answers 502 when Retell fails', async () => {
    const { app } = setup({}, { webCallFails: true });
    expect((await app.createWebCall(post('/api/create-web-call', {}))).status).toBe(502);
  });
});

describe('after-call summary', () => {
  async function busyCall() {
    const s = setup();
    const slot = s.bookings.addSlot({ doctor_name: 'Dr. Sara Malik', specialty_code: 'cardiology', slot_date: '2026-11-24', start_time: '10:00', end_time: '10:30' });
    const call = { call_id: 'call_web_1' };
    await s.app.bookAppointment(
      await signed('/api/book-appointment', { name: 'book_appointment', call, args: { name: 'Test Patient', phone_no: '03001234567', email: 'patient@example.test', schedule_id: slot.slot_id } }),
    );
    await s.app.submitVoiceComplaint(
      await signed('/api/submit-complaint', { name: 'submit_complaint', call, args: { name: 'Test Patient', phone_no: '03001234567', details: 'The parking was full and the guard was rude.' } }),
    );
    return s;
  }

  it('shows what the call did, only with the right token', async () => {
    const { app } = await busyCall();
    const token = summaryToken('call_web_1', summaryKey(KEY));
    const res = await app.callSummary(new Request(`https://api.example/api/call-summary?call_id=call_web_1&token=${token}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.actions.map((a: { action: string }) => a.action)).toEqual(['booked', 'complaint_filed']);
    expect(body.text).toMatch(/Booked APT-[A-Z0-9]{6} with Dr\. Sara Malik \(Cardiology\) on 2026-11-24 at 10:00\./);

    const other = await app.callSummary(new Request(`https://api.example/api/call-summary?call_id=call_web_2&token=${token}`));
    expect(other.status).toBe(403);
    const none = await app.callSummary(new Request('https://api.example/api/call-summary?call_id=call_web_1'));
    expect(none.status).toBe(403);
  });

  it('emails the summary once when Retell reports the call ended', async () => {
    const { app, email } = await busyCall();
    const before = email.sent.length;
    const ended = { event: 'call_ended', call: { call_id: 'call_web_1', transcript: 'not stored' } };
    expect((await app.retellWebhook(await signed('/api/retell-webhook', ended))).status).toBe(204);
    expect((await app.retellWebhook(await signed('/api/retell-webhook', ended))).status).toBe(204);
    const summaries = email.sent.slice(before).filter((e) => e.subject === 'Your MediLens call summary');
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.to).toBe('patient@example.test');
    expect(summaries[0]!.text).toMatch(/Filed complaint CMP-[A-Z0-9]{6}: sent to/);
    expect(summaries[0]!.text).not.toContain('not stored');
  });

  it('ignores other events, unsigned webhooks and calls with no email', async () => {
    const { app, email } = setup();
    const before = email.sent.length;
    expect((await app.retellWebhook(await signed('/api/retell-webhook', { event: 'call_started', call: { call_id: 'c' } }))).status).toBe(204);
    expect((await app.retellWebhook(post('/api/retell-webhook', JSON.stringify({ event: 'call_ended', call: { call_id: 'c' } })))).status).toBe(401);
    expect((await app.retellWebhook(await signed('/api/retell-webhook', { event: 'call_ended', call: { call_id: 'empty' } }))).status).toBe(204);
    expect(email.sent.length).toBe(before);
  });
});

describe('health', () => {
  it('reports the voice features without secrets', async () => {
    const { app } = setup({ webCallPasscode: 'x' });
    const body = await (await app.health(new Request('https://api.example/api/health'))).json();
    expect(body).toMatchObject({ voice: 'on', web_call: 'on_with_passcode', voice_input: 'on' });
    expect(JSON.stringify(body)).not.toContain(KEY);
  });
});

import { describe, expect, it } from 'vitest';
import { MemoryCallLog, SupabaseCallLog, type CallAction } from '../lib/calls/log.js';
import { summarizeCall, summaryKey, summaryRecipient, summaryToken, validSummaryToken } from '../lib/calls/summary.js';

const action = (over: Partial<CallAction>): CallAction => ({
  call_id: 'call_1',
  action: 'booked',
  reference: 'APT-ABC234',
  details: { doctor_name: 'Dr. Sara Malik', department: 'Cardiology', appointment_date: '2026-11-24', appointment_time: '10:00' },
  email: null,
  created_at: '2026-11-23T05:00:00Z',
  ...over,
});

describe('summary tokens', () => {
  const key = summaryKey('server-secret');

  it('accepts the token for its own call only', () => {
    const token = summaryToken('call_1', key);
    expect(validSummaryToken('call_1', token, key)).toBe(true);
    expect(validSummaryToken('call_2', token, key)).toBe(false);
    expect(validSummaryToken('call_1', token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A'), key)).toBe(false);
    expect(validSummaryToken('call_1', '', key)).toBe(false);
  });

  it('changes with the secret', () => {
    expect(summaryToken('call_1', summaryKey('other'))).not.toBe(summaryToken('call_1', key));
  });
});

describe('summarizeCall', () => {
  it('writes one line per action, in order', () => {
    const s = summarizeCall('call_1', [
      action({}),
      action({ action: 'rescheduled', details: { doctor_name: 'Dr. Sara Malik', appointment_date: '2026-11-25', appointment_time: '11:00' } }),
      action({
        action: 'complaint_filed',
        reference: 'CMP-XYZ789',
        details: { department_name: 'Billing & Insurance', expected_response_hours: 72, emergency: false },
      }),
    ]);
    expect(s.actions.map((a) => a.text)).toEqual([
      'Booked APT-ABC234 with Dr. Sara Malik (Cardiology) on 2026-11-24 at 10:00.',
      'Moved APT-ABC234 to Dr. Sara Malik on 2026-11-25 at 11:00.',
      'Filed complaint CMP-XYZ789: sent to Billing & Insurance, response within 72 hours.',
    ]);
    expect(s.text.split('\n')).toHaveLength(3);
  });

  it('says so when the call did nothing', () => {
    expect(summarizeCall('call_1', []).text).toBe('Nothing was booked, changed or filed during this call.');
  });

  it('emails the last address given during the call', () => {
    expect(summaryRecipient([action({ email: 'a@example.test' }), action({ email: null }), action({ email: 'b@example.test' })])).toBe('b@example.test');
    expect(summaryRecipient([action({})])).toBeNull();
  });
});

describe('call logs', () => {
  it('memory log allows one summary per call', async () => {
    const log = new MemoryCallLog();
    await log.record(action({}));
    expect(await log.list('call_1')).toHaveLength(1);
    expect(await log.list('other')).toEqual([]);
    expect(await log.claimSummary('call_1')).toBe(true);
    expect(await log.claimSummary('call_1')).toBe(false);
  });

  it('supabase log filters by call, hides summary markers, and maps the unique index to "already sent"', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    let claimStatus = 201;
    const log = new SupabaseCallLog({
      url: 'https://abc.supabase.co',
      serviceKey: 'k',
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init: init ?? {} });
        if (init?.method === 'POST') return new Response(null, { status: claimStatus });
        return new Response('[]', { status: 200 });
      }) as typeof fetch,
    });
    await log.list('call_1');
    const q = new URL(calls[0]!.url).searchParams;
    expect(q.get('call_id')).toBe('eq.call_1');
    expect(q.get('action')).toBe('neq.summary_sent');
    expect(await log.claimSummary('call_1')).toBe(true);
    claimStatus = 409;
    expect(await log.claimSummary('call_1')).toBe(false);
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({ call_id: 'call_1', action: 'summary_sent', reference: 'call_1' });
  });
});

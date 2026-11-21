/**
 * After-call summary: what the call did, as text for the page and an email.
 * The browser gets a token with the call id from /api/create-web-call; only
 * that token can read the summary, so call ids can't be used to browse.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { CallAction } from './log.js';

/** A key for summary tokens, derived from a server secret (never sent anywhere). */
export function summaryKey(secret: string): Buffer {
  return createHash('sha256').update(`medilens-call-summary:${secret}`).digest();
}

export function summaryToken(callId: string, key: Buffer): string {
  return createHmac('sha256', key).update(callId).digest('base64url');
}

export function validSummaryToken(callId: string, token: string, key: Buffer): boolean {
  const expected = Buffer.from(summaryToken(callId, key));
  const given = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const s = (v: unknown) => (v === null || v === undefined ? '' : String(v));

/** One plain sentence per action, in order. */
export function describe(action: CallAction): string {
  const d = action.details;
  switch (action.action) {
    case 'booked':
      return `Booked ${action.reference} with ${s(d.doctor_name)} (${s(d.department)}) on ${s(d.appointment_date)} at ${s(d.appointment_time)}.`;
    case 'rescheduled':
      return `Moved ${action.reference} to ${s(d.doctor_name)} on ${s(d.appointment_date)} at ${s(d.appointment_time)}.`;
    case 'cancelled':
      return `Cancelled ${action.reference} (${s(d.doctor_name)}, ${s(d.appointment_date)} at ${s(d.appointment_time)}).`;
    case 'complaint_filed':
      return `Filed complaint ${action.reference}: sent to ${s(d.department_name)}${d.emergency ? ' (marked as an emergency)' : ''}, response within ${s(d.expected_response_hours)} hours.`;
  }
}

export interface CallSummary {
  call_id: string;
  actions: { action: CallAction['action']; reference: string; text: string }[];
  text: string;
}

export function summarizeCall(callId: string, actions: CallAction[]): CallSummary {
  const lines = actions.map((a) => ({ action: a.action, reference: a.reference, text: describe(a) }));
  return {
    call_id: callId,
    actions: lines,
    text: lines.length ? lines.map((l) => `• ${l.text}`).join('\n') : 'Nothing was booked, changed or filed during this call.',
  };
}

/** The address to email the summary to: the most recent one given during the call. */
export function summaryRecipient(actions: CallAction[]): string | null {
  for (let i = actions.length - 1; i >= 0; i--) if (actions[i]!.email) return actions[i]!.email;
  return null;
}

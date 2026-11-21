/**
 * Every public URL and the handler behind it. Vercel's Hobby plan allows at
 * most 12 functions per deployment, so all endpoints run in one function
 * (api/router.ts); vercel.json rewrites /api/<route> to it. URLs are unchanged.
 */
import type { App } from './http.js';

export const ROUTES = {
  // Complaints (browser)
  complaints: 'submitComplaint',
  'complaint-status': 'complaintStatus',
  'complaints-summary': 'complaintsSummary',
  transcribe: 'transcribe',
  // Voice agent (browser)
  'create-web-call': 'createWebCall',
  'call-summary': 'callSummary',
  // Retell custom functions (signed)
  'doctor-availability': 'doctorAvailability',
  'book-appointment': 'bookAppointment',
  'appointment-check': 'appointmentCheck',
  'confirm-reschedule': 'confirmReschedule',
  'cancel-status': 'cancelStatus',
  'confirm-cancellation': 'confirmCancellation',
  'complaint-check': 'complaintCheck',
  'submit-complaint': 'submitVoiceComplaint',
  // Retell webhook (signed)
  'retell-webhook': 'retellWebhook',
  health: 'health',
} as const satisfies Record<string, keyof App>;

export type RouteName = keyof typeof ROUTES;

/** The route name from a request: the rewrite's ?route=, else the last path segment. */
export function routeOf(request: Request): RouteName | null {
  const url = new URL(request.url);
  const name = url.searchParams.get('route') ?? url.pathname.replace(/\/+$/, '').split('/').pop() ?? '';
  return Object.hasOwn(ROUTES, name) ? (name as RouteName) : null;
}

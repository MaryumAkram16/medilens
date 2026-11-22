/**
 * Talks to the MediLens API (the medilens-api project). Nothing secret lives in
 * the site: the Retell and Gemini keys stay on the server, and the staff key is
 * typed by staff and kept only for the browser tab (sessionStorage).
 */
export const API_URL = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/+$/, '') || 'https://medilens-api.vercel.app';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

type Fetch = typeof fetch;

async function call<T>(path: string, init: RequestInit = {}, doFetch: Fetch = fetch): Promise<T> {
  let res: Response;
  try {
    res = await doFetch(`${API_URL}/api/${path}`, {
      ...init,
      headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.headers as Record<string, string> | undefined) },
    });
  } catch {
    throw new ApiError(0, 'NETWORK', "Can't reach MediLens right now. Check your connection and try again.");
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const message = typeof body.error === 'string' ? body.error : typeof body.message === 'string' ? body.message : 'Something went wrong. Please try again.';
    throw new ApiError(res.status, typeof body.error_code === 'string' ? body.error_code : 'ERROR', message);
  }
  return body as T;
}

export type Priority = 'High' | 'Medium' | 'Low';

export interface ComplaintInput {
  name: string;
  email: string;
  phone: string;
  details: string;
  type?: string;
  priority?: Priority;
  channel: 'web' | 'voice';
}

export interface ComplaintResult {
  success: true;
  message: string;
  complaint_code: string;
  priority: Priority;
  department: string;
  department_name: string;
  expected_response_hours: number;
  needs_review: boolean;
  emergency: boolean;
  emergency_notice: string | null;
  spoken_message: string;
}

export const submitComplaint = (input: ComplaintInput, f?: Fetch) =>
  call<ComplaintResult>('complaints', { method: 'POST', body: JSON.stringify(input) }, f);

export interface StatusResult {
  success: true;
  complaint_code: string;
  status: 'Pending' | 'In Review' | 'Resolved';
  priority: Priority;
  department_name: string;
  submitted_at: string;
  spoken_message: string;
}

export const complaintStatus = (code: string, contact: { email?: string; phone?: string }, f?: Fetch) =>
  call<StatusResult>('complaint-status', { method: 'POST', body: JSON.stringify({ complaint_code: code, ...contact }) }, f);

export const transcribe = (audioBase64: string, mimeType: string, f?: Fetch) =>
  call<{ success: true; transcript: string; language: string }>('transcribe', { method: 'POST', body: JSON.stringify({ audio_base64: audioBase64, mime_type: mimeType }) }, f);

export interface WebCall {
  success: true;
  call_id: string;
  access_token: string;
  summary_token: string;
  /** Which media stack issued the token. Retell's tokens look alike, so the client must be told. */
  transport?: 'gateway' | 'livekit';
  ice_servers?: { urls: string | string[]; username?: string; credential?: string }[];
  url?: string;
}

export const createWebCall = (passcode: string | undefined, f?: Fetch) =>
  call<WebCall>('create-web-call', { method: 'POST', body: JSON.stringify(passcode ? { passcode } : {}) }, f);

export interface CallSummary {
  success: true;
  call_id: string;
  actions: { action: string; reference: string; text: string }[];
  text: string;
}

export const callSummary = (callId: string, token: string, f?: Fetch) =>
  call<CallSummary>(`call-summary?${new URLSearchParams({ call_id: callId, token })}`, {}, f);

// ---- Staff desk (admin key) ----

export interface ComplaintRow {
  complaint_code: string;
  patient_name: string;
  email: string | null;
  phone: string;
  details: string;
  channel: 'web' | 'voice';
  priority: Priority;
  priority_hint: Priority | null;
  department_code: string;
  category: string;
  sentiment: string;
  suggested_action: string;
  confidence: number;
  triage_source: 'ai' | 'keywords';
  emergency: boolean;
  needs_review: boolean;
  status: 'Pending' | 'In Review' | 'Resolved';
  created_at: string;
}

export interface Summary {
  summary: {
    total: number;
    pending: number;
    resolved: number;
    highPriority: number;
    needsReview: number;
    emergency: number;
    byDepartment: Record<string, number>;
  };
  data: ComplaintRow[];
}

const admin = (key: string) => ({ 'x-admin-key': key });

export const complaintsSummary = (key: string, f?: Fetch) => call<Summary>('complaints-summary', { headers: admin(key) }, f);

export interface ReviewInput {
  complaint_code: string;
  status?: 'Pending' | 'In Review' | 'Resolved';
  priority?: Priority;
  department?: string;
  confirm?: boolean;
  note?: string;
}

export const updateComplaint = (key: string, input: ReviewInput, f?: Fetch) =>
  call<{ success: true; review: string; notified: string[] }>('complaint-update', { method: 'POST', headers: admin(key), body: JSON.stringify(input) }, f);

export interface Accuracy {
  reviewed: number;
  by_source: Record<'ai' | 'keywords', { reviewed: number; both_correct: number; accuracy: number | null }>;
  recent_corrections: { complaint_code: string; triage_source: string; from: string; to: string }[];
}

export const triageAccuracy = (key: string, f?: Fetch) => call<Accuracy>('triage-accuracy', { headers: admin(key) }, f);

/** Department codes and names, matching the API's catalogue. */
export const DEPARTMENTS: Record<string, string> = {
  emergency: 'Emergency Department',
  clinical_care: 'Doctor & Clinical Care',
  nursing: 'Nursing & Ward Care',
  pharmacy: 'Pharmacy',
  laboratory: 'Laboratory & Diagnostics',
  appointments: 'Appointments & Scheduling',
  billing: 'Billing & Insurance',
  facilities: 'Facilities & Cleanliness',
  patient_relations: 'Patient Relations (triage desk)',
};

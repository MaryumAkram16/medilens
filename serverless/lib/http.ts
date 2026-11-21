/**
 * Request handling for the Vercel functions in api/. Web-standard Request in,
 * Response out, so handlers run the same in tests, locally and on Vercel.
 */
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { geminiClassifier } from './complaints/gemini.js';
import { complaintStatusSchema, firstIssue, lowercaseKeys, submitComplaintSchema } from './complaints/schema.js';
import { ComplaintService, summarize } from './complaints/service.js';
import { loadConfig, type AppConfig } from './config.js';
import { MemoryRepository } from './data/memory.js';
import { SupabaseRepository } from './data/supabase.js';
import { DataSourceError, type ComplaintRepository } from './data/types.js';
import { LogEmailSender, SmtpEmailSender, type EmailSender } from './notify/email.js';
import { RateLimiter } from './rate-limit.js';
import type { Classifier } from './complaints/gemini.js';
import { voiceComplaintStatus } from './complaints/service.js';
import { MemoryBookingRepository } from './booking/memory.js';
import { SupabaseBookingRepository } from './booking/supabase.js';
import { BookingService, normalizeCode, type VoiceResult } from './booking/service.js';
import type { BookingRepository } from './booking/types.js';
import {
  appointmentArgs,
  availabilityArgs,
  bookArgs,
  complaintCheckArgs,
  rescheduleArgs,
  retellEnvelope,
} from './booking/schema.js';
import { SIGNATURE_HEADER, verifyRetellSignature } from './signature.js';
import type { z } from 'zod';

export interface AppDeps {
  config: AppConfig;
  repository?: ComplaintRepository;
  bookings?: BookingRepository;
  email?: EmailSender;
  classifier?: Classifier | null;
  now?: () => Date;
}

type Handler = (request: Request) => Promise<Response>;

export interface App {
  submitComplaint: Handler;
  complaintStatus: Handler;
  complaintsSummary: Handler;
  health: Handler;
  // Retell voice agent tools (POST, signed by Retell)
  doctorAvailability: Handler;
  bookAppointment: Handler;
  appointmentCheck: Handler;
  confirmReschedule: Handler;
  cancelStatus: Handler;
  confirmCancellation: Handler;
  complaintCheck: Handler;
}

const BASE_HEADERS: Record<string, string> = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

function log(level: 'info' | 'warn' | 'error', msg: string, fields: Record<string, unknown> = {}) {
  (level === 'info' ? console.log : console.warn)(JSON.stringify({ level, msg, ...fields }));
}

function clientIp(request: Request): string {
  // Set by the Vercel edge; not client-controlled there.
  const real = request.headers.get('x-real-ip')?.trim();
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return (real || forwarded || 'unknown').slice(0, 64);
}

async function readBody(request: Request, maxBytes: number): Promise<string | null> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  const buf = new Uint8Array(await request.arrayBuffer());
  return buf.byteLength > maxBytes ? null : new TextDecoder().decode(buf);
}

function sameSecret(given: string | null, expected: string): boolean {
  if (!given) return false;
  const digest = (v: string) => createHash('sha256').update(v).digest();
  return timingSafeEqual(digest(given), digest(expected));
}

export function createApp(deps: AppDeps): App {
  const { config } = deps;
  const now = deps.now ?? (() => new Date());
  const repository =
    deps.repository ??
    (config.supabase ? new SupabaseRepository({ url: config.supabase.url, serviceKey: config.supabase.serviceKey }) : new MemoryRepository(now));
  const email = deps.email ?? (config.smtp ? new SmtpEmailSender(config.smtp) : new LogEmailSender());
  const classifier =
    deps.classifier !== undefined
      ? deps.classifier
      : config.gemini
        ? geminiClassifier({
            apiKey: config.gemini.apiKey,
            model: config.gemini.model,
            onFailure: (reason) => log('warn', 'ai_triage_failed', { reason }),
          })
        : null;
  const service = new ComplaintService({
    repository,
    email,
    classifier,
    alertEmailOverride: config.alertEmailOverride,
    log: (msg, fields) => log('warn', msg, fields),
  });
  const limiter = new RateLimiter(config.rateLimit.windowMs);
  const bookings =
    deps.bookings ??
    (config.supabase
      ? new SupabaseBookingRepository({ url: config.supabase.url, serviceKey: config.supabase.serviceKey })
      : new MemoryBookingRepository(now));
  const booking = new BookingService({ repository: bookings, email, now, log: (msg, fields) => log('warn', msg, fields) });
  // Voice calls get their own budget: a single call makes several tool requests.
  const voiceLimiter = new RateLimiter(60_000);

  type Call = { callId: string | null; fromNumber: string | null };
  type VoiceFn<S extends z.ZodType> = (args: z.infer<S>, call: Call) => Promise<VoiceResult>;

  /**
   * Retell custom function: verify the signature over the raw body, parse
   * { call, args }, then run the tool. Business outcomes are 200 with
   * success:false and a sentence the agent can say.
   */
  function voice<S extends z.ZodType>(tool: string, schema: S, fn: VoiceFn<S>): Handler {
    return async (request) => {
      const requestId = randomUUID();
      const say = (status: number, message: string, code: string, extra: Record<string, string> = {}) =>
        json(status, { success: false, error_code: code, message, request_id: requestId }, requestId, extra);
      if (request.method !== 'POST') return say(405, 'This endpoint only accepts POST.', 'METHOD_NOT_ALLOWED', { allow: 'POST' });
      if (!config.retellApiKey) return say(503, 'The voice service is not switched on.', 'VOICE_NOT_CONFIGURED');
      const raw = await readBody(request, config.maxBodyBytes);
      if (raw === null) return say(413, 'That request was too large.', 'PAYLOAD_TOO_LARGE');
      if (!(await verifyRetellSignature(raw, config.retellApiKey, request.headers.get(SIGNATURE_HEADER)))) {
        log('warn', 'voice_bad_signature', { request_id: requestId, tool });
        return say(401, 'This request could not be authorized.', 'UNAUTHORIZED');
      }
      let envelope: z.infer<typeof retellEnvelope>;
      try {
        const parsed = retellEnvelope.safeParse(JSON.parse(raw));
        if (!parsed.success) return say(400, "I couldn't read that request.", 'INVALID_REQUEST');
        envelope = parsed.data;
      } catch {
        return say(400, "I couldn't read that request.", 'INVALID_JSON');
      }
      const call: Call = { callId: envelope.call?.call_id ?? null, fromNumber: envelope.call?.from_number ?? null };
      const rate = voiceLimiter.check(`call:${call.callId ?? clientIp(request)}`, 30, now().getTime());
      if (!rate.allowed) {
        return say(429, "I'm getting a lot of requests right now. Please give me a moment.", 'RATE_LIMITED', { 'retry-after': String(rate.retryAfterSeconds) });
      }
      const args = schema.safeParse(envelope.args);
      if (!args.success) {
        return json(200, { success: false, error_code: 'VALIDATION_ERROR', error: firstIssue(args.error), message: "I'm missing some details. Could you repeat them?", request_id: requestId }, requestId);
      }
      try {
        const result = await fn(args.data, call);
        log('info', 'voice_tool', { request_id: requestId, tool, call_id: call.callId, success: result.success });
        return json(200, { ...result, request_id: requestId }, requestId);
      } catch (err) {
        const reason = err instanceof DataSourceError ? err.message : err instanceof Error ? err.name : 'unknown';
        log('error', 'voice_tool_failed', { request_id: requestId, tool, reason });
        return say(err instanceof DataSourceError ? 503 : 500, "I'm having trouble reaching our system right now. Please try again in a moment.", 'SERVER_ERROR');
      }
    };
  }

  const phoneOf = (given: string | undefined, call: Call) => {
    const phone = given || call.fromNumber || '';
    return phone.replace(/\D/g, '').length >= 10 ? phone : null;
  };
  const askPhone: VoiceResult = { success: false, message: 'Could you tell me the phone number you booked with?' };
  const badCode: VoiceResult = { success: false, message: "That doesn't sound like an appointment ID. It starts with A P T and has six letters or numbers. Could you read it again?" };

  /** Code + phone for the appointment tools, or the question to ask the caller. */
  function owner(
    args: { appointment_id: string; phone_no?: string | undefined },
    call: Call,
  ): { ok: true; code: string; phone: string } | { ok: false; reply: VoiceResult } {
    const code = normalizeCode(args.appointment_id, 'APT');
    if (!code) return { ok: false, reply: badCode };
    const phone = phoneOf(args.phone_no, call);
    if (!phone) return { ok: false, reply: askPhone };
    return { ok: true, code, phone };
  }

  function corsHeaders(request: Request): Record<string, string> | null {
    const origin = request.headers.get('origin');
    if (!origin) return {}; // server-to-server or same-origin
    if (!config.allowedOrigins.includes(origin.replace(/\/+$/, ''))) return null;
    return {
      'access-control-allow-origin': origin,
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type, x-admin-key',
      'access-control-max-age': '600',
      vary: 'Origin',
    };
  }

  function json(status: number, body: unknown, requestId: string, extra: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), { status, headers: { ...BASE_HEADERS, 'x-request-id': requestId, ...extra } });
  }

  function error(status: number, code: string, message: string, requestId: string, extra: Record<string, string> = {}) {
    return json(status, { success: false, error_code: code, error: message, request_id: requestId }, requestId, extra);
  }

  /**
   * Shared front door: method, CORS, rate limit, body size, JSON.
   * Returns either a Response to send or the parsed body.
   */
  async function gate(
    request: Request,
    method: 'GET' | 'POST',
    requestId: string,
  ): Promise<{ response: Response } | { body: unknown; cors: Record<string, string> }> {
    const cors = corsHeaders(request);
    if (cors === null) return { response: error(403, 'ORIGIN_NOT_ALLOWED', 'This origin is not allowed.', requestId) };
    if (request.method === 'OPTIONS') return { response: new Response(null, { status: 204, headers: { ...cors } }) };
    if (request.method !== method) {
      return { response: error(405, 'METHOD_NOT_ALLOWED', `Use ${method}.`, requestId, { ...cors, allow: `${method}, OPTIONS` }) };
    }
    const rate = limiter.check(clientIp(request), config.rateLimit.perIp, now().getTime());
    if (!rate.allowed) {
      return {
        response: error(429, 'RATE_LIMITED', 'Too many requests. Please wait a minute and try again.', requestId, {
          ...cors,
          'retry-after': String(rate.retryAfterSeconds),
        }),
      };
    }
    if (method === 'GET') return { body: null, cors };
    if (!(request.headers.get('content-type') ?? '').toLowerCase().includes('application/json')) {
      return { response: error(415, 'UNSUPPORTED_MEDIA_TYPE', 'Send JSON (content-type: application/json).', requestId, cors) };
    }
    const raw = await readBody(request, config.maxBodyBytes);
    if (raw === null) return { response: error(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large.', requestId, cors) };
    try {
      return { body: JSON.parse(raw), cors };
    } catch {
      return { response: error(400, 'INVALID_JSON', 'Request body is not valid JSON.', requestId, cors) };
    }
  }

  async function guarded(name: string, requestId: string, cors: Record<string, string>, fn: () => Promise<Response>) {
    try {
      return await fn();
    } catch (err) {
      const reason = err instanceof DataSourceError ? err.message : err instanceof Error ? err.name : 'unknown';
      log('error', `${name}_failed`, { request_id: requestId, reason });
      return error(err instanceof DataSourceError ? 503 : 500, 'SERVER_ERROR', 'Something went wrong. Please try again in a moment.', requestId, cors);
    }
  }

  return {
    async submitComplaint(request) {
      const requestId = randomUUID();
      const g = await gate(request, 'POST', requestId);
      if ('response' in g) return g.response;
      const parsed = submitComplaintSchema.safeParse(lowercaseKeys(g.body));
      if (!parsed.success) return error(400, 'VALIDATION_ERROR', firstIssue(parsed.error), requestId, g.cors);
      return guarded('submit_complaint', requestId, g.cors, async () => {
        const result = await service.submit(parsed.data);
        if (result.status === 201) {
          log('info', 'complaint_created', {
            request_id: requestId,
            complaint_code: result.body.complaint_code,
            priority: result.body.priority,
            department: result.body.department,
            needs_review: result.body.needs_review,
            emergency: result.body.emergency,
          });
        }
        return json(result.status, result.body, requestId, g.cors);
      });
    },

    async complaintStatus(request) {
      const requestId = randomUUID();
      const g = await gate(request, 'POST', requestId);
      if ('response' in g) return g.response;
      const parsed = complaintStatusSchema.safeParse(lowercaseKeys(g.body));
      if (!parsed.success) return error(400, 'VALIDATION_ERROR', firstIssue(parsed.error), requestId, g.cors);
      return guarded('complaint_status', requestId, g.cors, async () => {
        const result = await service.status(parsed.data.complaint_code, parsed.data);
        if (!result.found) {
          return json(
            404,
            {
              success: false,
              error_code: 'NOT_FOUND',
              error: 'No complaint matches that code and contact detail.',
              spoken_message: "I couldn't find a complaint with that code and contact detail. Could you check the code?",
            },
            requestId,
            g.cors,
          );
        }
        const { found: _found, ...body } = result;
        return json(200, { success: true, ...body }, requestId, g.cors);
      });
    },

    async complaintsSummary(request) {
      const requestId = randomUUID();
      const g = await gate(request, 'GET', requestId);
      if ('response' in g) return g.response;
      // Returns patient data: admin key only, and switched off when no key is configured.
      if (!config.adminApiKey || !sameSecret(request.headers.get('x-admin-key'), config.adminApiKey)) {
        return error(401, 'UNAUTHORIZED', 'A valid admin key is required.', requestId, g.cors);
      }
      return guarded('complaints_summary', requestId, g.cors, async () =>
        json(200, summarize(await repository.list(500), now()), requestId, g.cors),
      );
    },

    doctorAvailability: voice('doctor_availability', availabilityArgs, (a) => booking.availability(a.department, a.date)),

    bookAppointment: voice('book_appointment', bookArgs, async (a, call) => {
      const phone = phoneOf(a.phone_no, call);
      if (!phone) return askPhone;
      const email = a.email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a.email) ? a.email.toLowerCase() : null;
      return booking.book({ name: a.name, phone, email, slotId: Number(a.schedule_id), callId: call.callId });
    }),

    appointmentCheck: voice('appointment_check', appointmentArgs, (a, call) => {
      const o = owner(a, call);
      return o.ok ? booking.check(o.code, o.phone) : Promise.resolve(o.reply);
    }),

    confirmReschedule: voice('confirm_reschedule', rescheduleArgs, (a, call) => {
      const o = owner(a, call);
      if (!o.ok) return Promise.resolve(o.reply);
      const target: { slotId?: number; date?: string; time?: string } = {};
      if (a.schedule_id) target.slotId = Number(a.schedule_id);
      if (a.appointment_date) target.date = a.appointment_date;
      if (a.slot_start_time) target.time = a.slot_start_time;
      return booking.reschedule(o.code, o.phone, target);
    }),

    cancelStatus: voice('cancel_status', appointmentArgs, (a, call) => {
      const o = owner(a, call);
      return o.ok ? booking.cancelStatus(o.code, o.phone) : Promise.resolve(o.reply);
    }),

    confirmCancellation: voice('confirm_cancellation', appointmentArgs, (a, call) => {
      const o = owner(a, call);
      return o.ok ? booking.cancel(o.code, o.phone) : Promise.resolve(o.reply);
    }),

    complaintCheck: voice('complaint_check', complaintCheckArgs, async (a, call) => {
      const code = normalizeCode(a.complaint_id, 'CMP');
      if (!code) return { success: false, message: 'Complaint codes start with C M P and have six letters or numbers. Could you read it again?' };
      const phone = phoneOf(a.phone_no, call) ?? undefined;
      const emailAddr = a.email?.toLowerCase();
      if (!phone && !emailAddr) return { success: false, message: 'Could you tell me the phone number or email you used for the complaint?' };
      return (await voiceComplaintStatus(
        service,
        { repository, email, alertEmailOverride: config.alertEmailOverride, now },
        code,
        { phone, email: emailAddr },
      )) as VoiceResult;
    }),

    async health(request) {
      const requestId = randomUUID();
      if (request.method !== 'GET') return error(405, 'METHOD_NOT_ALLOWED', 'Use GET.', requestId, { allow: 'GET' });
      return json(
        200,
        {
          status: 'ok',
          data_source: config.dataSource,
          ai_triage: classifier ? 'gemini' : 'keywords_only',
          email: email.kind,
          voice: config.retellApiKey ? 'on' : 'off',
          time: now().toISOString(),
        },
        requestId,
      );
    },
  };
}

let shared: App | null = null;

/** One app per warm instance, built from the environment on first use. */
export function appFromEnv(): App {
  shared ??= createApp({ config: loadConfig() });
  return shared;
}

export function handlerFor(name: keyof App): Handler {
  return async (request) => {
    try {
      return await appFromEnv()[name](request);
    } catch (err) {
      // Config errors name the variables only, never their values.
      log('error', 'startup_failed', { reason: err instanceof Error ? err.message : 'unknown' });
      return new Response(JSON.stringify({ success: false, error_code: 'NOT_CONFIGURED', error: 'Service is not configured.' }), {
        status: 503,
        headers: BASE_HEADERS,
      });
    }
  };
}

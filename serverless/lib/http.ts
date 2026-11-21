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

export interface AppDeps {
  config: AppConfig;
  repository?: ComplaintRepository;
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

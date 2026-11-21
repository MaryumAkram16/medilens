/**
 * Voice agent scenario suite: scripted caller journeys run against the real
 * tool endpoints exactly as Retell calls them (signed requests, loose speech-
 * like arguments), each step graded, and every spoken reply checked against
 * speech-quality rules.
 *
 * What it covers: the backend side of every conversation (what the agent can
 * be told, and whether it can say it). What it doesn't: the Retell LLM's own
 * choices (which tool to call, how it phrases the question). That needs real
 * calls with RETELL_API_KEY; see README.
 */
import { MemoryBookingRepository } from '../../lib/booking/memory.js';
import { MemoryCallLog } from '../../lib/calls/log.js';
import type { AiTriage } from '../../lib/complaints/triage.js';
import { MemoryRepository } from '../../lib/data/memory.js';
import { createApp, type App } from '../../lib/http.js';
import { LogEmailSender } from '../../lib/notify/email.js';
import { signRetellBody } from '../../lib/signature.js';
import type { AppConfig } from '../../lib/config.js';

export const KEY = 'scenario-retell-key';
/** Monday 23 November 2026, 09:10 in Pakistan: a normal clinic morning. */
export const NOW = new Date('2026-11-23T04:10:00Z');

export type Tool =
  | 'doctorAvailability'
  | 'bookAppointment'
  | 'appointmentCheck'
  | 'confirmReschedule'
  | 'cancelStatus'
  | 'confirmCancellation'
  | 'complaintCheck'
  | 'submitVoiceComplaint';

export type Ctx = Record<string, unknown>;

export interface Step {
  /** What the caller is doing, for the report. */
  say: string;
  tool: Tool;
  args: Record<string, unknown> | ((ctx: Ctx) => Record<string, unknown>);
  /** Retell's call object; defaults to a web call with this scenario's id. */
  call?: Record<string, unknown>;
  expect: {
    status?: number;
    success?: boolean;
    message?: RegExp;
    /** Extra checks on the JSON body; return a problem or null. */
    check?: (body: Record<string, unknown>, ctx: Ctx) => string | null;
  };
  /** Values to remember for later steps, e.g. the booked appointment code. */
  save?: (body: Record<string, unknown>, ctx: Ctx) => void;
  /** Changes the world before this step, e.g. days passing between two calls. */
  before?: (world: World, ctx: Ctx) => void;
}

export interface Scenario {
  id: string;
  title: string;
  /** The AI triage answer for complaint steps (the real model is not called here). */
  triage?: AiTriage;
  /** Changes to the world before the call starts. */
  setup?: (world: World) => void | Promise<void>;
  steps: Step[];
}

export interface World {
  app: App;
  bookings: MemoryBookingRepository;
  complaints: MemoryRepository;
  email: LogEmailSender;
}

/** Rules every sentence the agent will speak must pass. */
export const SPEECH_RULES: { name: string; test: (m: string) => boolean }[] = [
  { name: 'not empty', test: (m) => m.trim().length > 0 },
  { name: 'at most 70 words', test: (m) => m.trim().split(/\s+/).length <= 70 },
  { name: 'no programming values', test: (m) => !/\b(undefined|null|NaN)\b|\[object|[{}]/.test(m) },
  { name: 'no machine dates (YYYY-MM-DD)', test: (m) => !/\b\d{4}-\d{2}-\d{2}\b/.test(m) },
  { name: 'times say AM or PM', test: (m) => !/\b([01]?\d|2[0-3]):[0-5]\d\b(?! ?[AP]M)/.test(m) },
  { name: 'codes spelled out, not raw', test: (m) => !/\b(APT|CMP)-[A-Z0-9]{6}\b/.test(m) },
];

export interface StepResult {
  say: string;
  tool: Tool;
  status: number;
  message: string;
  problems: string[];
}

export interface ScenarioResult {
  id: string;
  title: string;
  passed: boolean;
  steps: StepResult[];
}

function config(): AppConfig {
  return {
    dataSource: 'demo',
    supabase: null,
    gemini: null,
    smtp: null,
    alertEmailOverride: null,
    allowedOrigins: [],
    adminApiKey: null,
    retellApiKey: KEY,
    retellAgentId: null,
    webCallPasscode: null,
    webCall: { perIpPer10Min: 3, globalPerHour: 30 },
    summarySecret: null,
    cronSecret: null,
    maxBodyBytes: 16 * 1024,
    rateLimit: { windowMs: 60_000, perIp: 1000 },
  };
}

export async function runScenario(s: Scenario): Promise<ScenarioResult> {
  const bookings = new MemoryBookingRepository(() => NOW);
  const complaints = new MemoryRepository(() => NOW);
  const email = new LogEmailSender();
  const app = createApp({
    config: config(),
    bookings,
    repository: complaints,
    email,
    callLog: new MemoryCallLog(() => NOW),
    classifier: s.triage ? async () => s.triage! : null,
    transcriber: null,
    now: () => NOW,
  });
  await bookings.ensureDemoSlots(14);
  const world: World = { app, bookings, complaints, email };
  await s.setup?.(world);

  const ctx: Ctx = {};
  const steps: StepResult[] = [];
  for (const step of s.steps) {
    step.before?.(world, ctx);
    const args = typeof step.args === 'function' ? step.args(ctx) : step.args;
    const body = JSON.stringify({ name: step.tool, call: step.call ?? { call_id: `call_${s.id}` }, args });
    const req = new Request(`https://api.example/api/${step.tool}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-real-ip': '203.0.113.50', 'x-retell-signature': await signRetellBody(body, KEY) },
      body,
    });
    const res = await app[step.tool](req);
    const json = (await res.json()) as Record<string, unknown>;
    const message = typeof json.message === 'string' ? json.message : '';
    const problems: string[] = [];
    const want = step.expect;
    if (res.status !== (want.status ?? 200)) problems.push(`HTTP ${res.status}, expected ${want.status ?? 200}`);
    if (want.success !== undefined && json.success !== want.success) problems.push(`success=${json.success}, expected ${want.success}`);
    if (want.message && !want.message.test(message)) problems.push(`message "${message}" does not match ${want.message}`);
    const extra = want.check?.(json, ctx);
    if (extra) problems.push(extra);
    for (const rule of SPEECH_RULES) if (!rule.test(message)) problems.push(`speech rule "${rule.name}" broken: "${message}"`);
    step.save?.(json, ctx);
    steps.push({ say: step.say, tool: step.tool, status: res.status, message, problems });
  }
  return { id: s.id, title: s.title, passed: steps.every((st) => st.problems.length === 0), steps };
}

export function formatResults(results: ScenarioResult[]): string {
  const passed = results.filter((r) => r.passed).length;
  const stepCount = results.reduce((n, r) => n + r.steps.length, 0);
  const lines = [
    `## Voice agent scenarios: ${passed}/${results.length} passed (${stepCount} tool calls, every reply checked against ${SPEECH_RULES.length} speech rules)`,
    '',
    '| Scenario | Result |',
    '|---|---|',
    ...results.map((r) => `| ${r.id} ${r.title} | ${r.passed ? 'pass' : 'FAIL'} |`),
  ];
  for (const r of results.filter((x) => !x.passed)) {
    lines.push('', `### ${r.id} ${r.title}`);
    for (const st of r.steps.filter((x) => x.problems.length)) lines.push(`- ${st.say}: ${st.problems.join('; ')}`);
  }
  return lines.join('\n');
}

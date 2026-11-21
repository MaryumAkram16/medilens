import type { AiTriage } from '../lib/complaints/triage.js';
import type { AppConfig } from '../lib/config.js';
import { MemoryRepository } from '../lib/data/memory.js';
import { LogEmailSender, type Email, type EmailSender } from '../lib/notify/email.js';

export const VALID = {
  name: 'Test Patient',
  email: 'patient@example.test',
  phone: '+92 300 1234567',
  details: 'I was charged twice for the same blood test on my bill.',
};

export const billingAi: AiTriage = {
  priority: 'Medium',
  department: 'billing',
  category: 'Duplicate charge',
  sentiment: 'Negative',
  suggested_action: 'Remove the duplicate charge and reply within 72 hours.',
  confidence: 0.9,
};

export function fakeClassifier(answer: AiTriage | null = billingAi) {
  const calls: string[] = [];
  const classify = async (text: string) => {
    calls.push(text);
    return answer;
  };
  return { calls, classify };
}

export class FailingEmailSender implements EmailSender {
  readonly kind = 'smtp' as const;
  async send(_email: Email): Promise<void> {
    throw new Error('smtp_down');
  }
}

export function testConfig(over: Partial<AppConfig> = {}): AppConfig {
  return {
    dataSource: 'demo',
    supabase: null,
    gemini: null,
    smtp: null,
    alertEmailOverride: null,
    allowedOrigins: ['https://medilens-demo.example'],
    adminApiKey: 'admin-test-key',
    retellApiKey: null,
    retellAgentId: null,
    webCallPasscode: null,
    webCall: { perIpPer10Min: 3, globalPerHour: 30 },
    summarySecret: null,
    cronSecret: null,
    maxBodyBytes: 16 * 1024,
    rateLimit: { windowMs: 60_000, perIp: 10 },
    ...over,
  };
}

export function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`https://api.example${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-real-ip': '203.0.113.7', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

export { LogEmailSender, MemoryRepository };

/** The first bytes of a real WebM file, padded: enough to pass the audio check. */
export const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(64, 1)]);

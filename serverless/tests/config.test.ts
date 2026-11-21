import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../lib/config.js';

describe('loadConfig', () => {
  it('defaults to demo data, keyword-only triage and logged email', () => {
    const c = loadConfig({});
    expect(c).toMatchObject({ dataSource: 'demo', supabase: null, gemini: null, smtp: null, adminApiKey: null, allowedOrigins: [] });
    expect(c.rateLimit).toEqual({ windowMs: 60_000, perIp: 10 });
  });

  it('reads Supabase, Gemini, SMTP and origins', () => {
    const c = loadConfig({
      DATA_SOURCE: 'supabase',
      SUPABASE_URL: 'https://abc.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'svc',
      GEMINI_API_KEY: 'g',
      SMTP_USER: 'me@example.test',
      SMTP_APP_PASSWORD: 'pw',
      ALLOWED_ORIGINS: 'https://a.example/, https://b.example',
    });
    expect(c.supabase).toEqual({ url: 'https://abc.supabase.co', serviceKey: 'svc' });
    expect(c.gemini).toEqual({ apiKey: 'g', model: '' });
    expect(c.smtp).toEqual({ user: 'me@example.test', appPassword: 'pw', from: 'me@example.test' });
    expect(c.allowedOrigins).toEqual(['https://a.example', 'https://b.example']);
  });

  it('names the broken variables without echoing their values', () => {
    try {
      loadConfig({ DATA_SOURCE: 'supabase', SUPABASE_URL: 'http://leaky-value.example', SMTP_USER: 'only-user' });
      throw new Error('expected ConfigError');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const message = (err as Error).message;
      expect(message).toContain('SUPABASE_URL');
      expect(message).toContain('SUPABASE_SERVICE_ROLE_KEY');
      expect(message).toContain('SMTP_USER and SMTP_APP_PASSWORD');
      expect(message).not.toContain('leaky-value');
    }
  });
});

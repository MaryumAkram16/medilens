/**
 * Environment configuration. Secrets come only from environment variables and
 * are never logged; problems are reported by variable name only.
 */
export interface AppConfig {
  dataSource: 'demo' | 'supabase';
  supabase: { url: string; serviceKey: string } | null;
  gemini: { apiKey: string; model: string } | null;
  smtp: { user: string; appPassword: string; from: string } | null;
  alertEmailOverride: string | null;
  allowedOrigins: string[];
  adminApiKey: string | null;
  maxBodyBytes: number;
  rateLimit: { windowMs: number; perIp: number };
}

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid configuration: ${problems.join('; ')}`);
    this.name = 'ConfigError';
  }
}

type Env = Readonly<Record<string, string | undefined>>;

export function loadConfig(env: Env = process.env): AppConfig {
  const get = (k: string) => env[k]?.trim() || '';
  const problems: string[] = [];

  const dataSource = (get('DATA_SOURCE') || 'demo').toLowerCase();
  if (dataSource !== 'demo' && dataSource !== 'supabase') problems.push('DATA_SOURCE must be demo or supabase');

  let supabase: AppConfig['supabase'] = null;
  if (dataSource === 'supabase') {
    const url = get('SUPABASE_URL');
    const serviceKey = get('SUPABASE_SERVICE_ROLE_KEY');
    if (!/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/.test(url)) problems.push('SUPABASE_URL must be https://<project>.supabase.co');
    if (!serviceKey) problems.push('SUPABASE_SERVICE_ROLE_KEY is required when DATA_SOURCE=supabase');
    supabase = { url, serviceKey };
  }

  const smtpUser = get('SMTP_USER');
  const smtpPass = get('SMTP_APP_PASSWORD');
  if (Boolean(smtpUser) !== Boolean(smtpPass)) problems.push('SMTP_USER and SMTP_APP_PASSWORD must be set together');

  if (problems.length) throw new ConfigError(problems);

  return {
    dataSource: dataSource as AppConfig['dataSource'],
    supabase,
    gemini: get('GEMINI_API_KEY') ? { apiKey: get('GEMINI_API_KEY'), model: get('GEMINI_MODEL') } : null,
    smtp: smtpUser ? { user: smtpUser, appPassword: smtpPass, from: get('MAIL_FROM') || smtpUser } : null,
    alertEmailOverride: get('ALERT_EMAIL_OVERRIDE') || null,
    allowedOrigins: get('ALLOWED_ORIGINS')
      .split(',')
      .map((o) => o.trim().replace(/\/+$/, ''))
      .filter(Boolean),
    adminApiKey: get('ADMIN_API_KEY') || null,
    maxBodyBytes: 16 * 1024,
    rateLimit: { windowMs: 60_000, perIp: 10 }, // the n8n workflow's 10 requests per minute
  };
}

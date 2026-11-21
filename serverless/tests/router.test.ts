import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createApp } from '../lib/http.js';
import { createRouter } from '../lib/router.js';
import { ROUTES, routeOf } from '../lib/routes.js';
import { LogEmailSender, MemoryRepository, VALID, post, testConfig } from './helpers.js';

const app = createApp({ config: testConfig(), repository: new MemoryRepository(), email: new LogEmailSender(), classifier: null });
const router = createRouter((key) => app[key]);

describe('deployment shape (Vercel Hobby: at most 12 functions)', () => {
  it('ships a single function', () => {
    const files = readdirSync(new URL('../api/', import.meta.url)).filter((f) => f.endsWith('.ts'));
    expect(files).toEqual(['router.ts']);
    expect(files.length).toBeLessThanOrEqual(12);
  });

  it('rewrites every /api/<route> to it', () => {
    const vercel = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
    expect(vercel.rewrites).toEqual([{ source: '/api/:route', destination: '/api/router?route=:route' }]);
    expect(Object.keys(vercel.functions)).toEqual(['api/router.ts']);
  });

  it('keeps every documented endpoint', () => {
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    const documented = [...readme.matchAll(/`(?:GET|POST) \/api\/([a-z-]+)/g)].map((m) => m[1]);
    for (const route of documented) expect(Object.keys(ROUTES)).toContain(route);
  });
});

describe('routeOf', () => {
  it('reads the rewrite parameter, or the path when called directly', () => {
    expect(routeOf(new Request('https://x/api/router?route=complaints'))).toBe('complaints');
    expect(routeOf(new Request('https://x/api/health'))).toBe('health');
    expect(routeOf(new Request('https://x/api/call-summary?call_id=c&token=t'))).toBe('call-summary');
  });

  it('rejects unknown names, including object built-ins', () => {
    expect(routeOf(new Request('https://x/api/router?route=nope'))).toBeNull();
    expect(routeOf(new Request('https://x/api/router?route=constructor'))).toBeNull();
    expect(routeOf(new Request('https://x/api/router?route=__proto__'))).toBeNull();
    expect(routeOf(new Request('https://x/api/router'))).toBeNull();
  });
});

describe('router', () => {
  it('sends each route to its handler, with the same results as before', async () => {
    const health = await router(new Request('https://x/api/router?route=health'));
    expect(await health.json()).toMatchObject({ status: 'ok' });

    const created = await router(post('/api/router?route=complaints', VALID));
    expect(created.status).toBe(201);

    const wrongMethod = await router(new Request('https://x/api/router?route=complaints'));
    expect(wrongMethod.status).toBe(405);
  });

  it('keeps the original query string for handlers that read it', async () => {
    const res = await router(new Request('https://x/api/router?route=call-summary&call_id=c1&token=bad'));
    // Reached call-summary (not a 404); summaries are off in this config, so 503.
    expect(res.status).toBe(503);
  });

  it('answers 404 for anything else', async () => {
    const res = await router(new Request('https://x/api/router?route=admin'));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error_code: 'NOT_FOUND' });
  });
});

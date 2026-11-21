import { describe, expect, it, vi } from 'vitest';
import { ApiError, API_URL, complaintStatus, complaintsSummary, submitComplaint, updateComplaint } from '../src/api';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('api client', () => {
  it('posts complaints as JSON to /api/complaints', async () => {
    const f = vi.fn(async () => json(201, { success: true, complaint_code: 'CMP-ABC123' }));
    const input = { name: 'Test "Quote" User', email: 'a@example.test', phone: '03001234567', details: 'Bill charged twice', channel: 'web' as const };
    const r = await submitComplaint(input, f);
    expect(r.complaint_code).toBe('CMP-ABC123');
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${API_URL}/api/complaints`);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual(input);
  });

  it('turns API errors into ApiError with status, code and message', async () => {
    const f = vi.fn(async () => json(409, { success: false, error_code: 'DUPLICATE', error: 'Already received.' }));
    await expect(submitComplaint({ name: 'x', email: 'a@example.test', phone: '1', details: 'xxxxxxxxxx', channel: 'web' }, f)).rejects.toMatchObject({
      status: 409,
      code: 'DUPLICATE',
      message: 'Already received.',
    });
  });

  it('reports network failures as a friendly NETWORK error', async () => {
    const f = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const err = await complaintStatus('CMP-ABC123', { email: 'a@example.test' }, f).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('NETWORK');
  });

  it('survives a non-JSON error body', async () => {
    const f = vi.fn(async () => new Response('<html>502</html>', { status: 502 }));
    await expect(complaintsSummary('k', f)).rejects.toMatchObject({ status: 502, code: 'ERROR' });
  });

  it('sends the staff key only in the x-admin-key header', async () => {
    const f = vi.fn(async () => json(200, { success: true, review: 'confirmed', notified: [] }));
    await updateComplaint('staff-key', { complaint_code: 'CMP-ABC123', confirm: true }, f);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).not.toContain('staff-key');
    expect((init.headers as Record<string, string>)['x-admin-key']).toBe('staff-key');
    expect(init.body).not.toContain('staff-key');
  });
});

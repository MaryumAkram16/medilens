import { describe, expect, it } from 'vitest';
import { SupabaseBookingRepository } from '../lib/booking/supabase.js';
import { BookingError } from '../lib/booking/types.js';
import { DataSourceError } from '../lib/data/types.js';

const found = {
  appointment_code: 'APT-ABC234',
  status: 'Booked',
  patient_name: 'Test Patient',
  email: null,
  slot_id: '7',
  doctor_name: 'Dr. Sara Malik',
  specialty_code: 'cardiology',
  slot_date: '2026-11-24',
  start_time: '10:00:00',
  end_time: '10:30:00',
};

function repo(respond: (fn: string, body: Record<string, unknown>) => Response) {
  const calls: { fn: string; body: Record<string, unknown>; headers: Record<string, string> }[] = [];
  const r = new SupabaseBookingRepository({
    url: 'https://abc.supabase.co',
    serviceKey: 'service-key',
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      const fn = String(url).split('/rpc/')[1]!;
      const body = JSON.parse(String(init?.body));
      calls.push({ fn, body, headers: init?.headers as Record<string, string> });
      return respond(fn, body);
    }) as typeof fetch,
  });
  return { r, calls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('SupabaseBookingRepository', () => {
  it('books through the book_appointment function and reads the slot back', async () => {
    const { r, calls } = repo((fn) => (fn === 'book_appointment' ? json([{ appointment_code: 'APT-ABC234', slot_id: 7 }]) : json([found])));
    const appt = await r.book({ slotId: 7, name: 'Test Patient', phone: '03001234567', email: null, code: 'APT-ABC234', callId: 'call_1' });
    expect(calls.map((c) => c.fn)).toEqual(['book_appointment', 'find_appointment']);
    expect(calls[0]!.body).toEqual({ p_slot_id: 7, p_name: 'Test Patient', p_phone: '03001234567', p_email: '', p_code: 'APT-ABC234', p_call_id: 'call_1' });
    expect(calls[0]!.headers.authorization).toBe('Bearer service-key');
    expect(appt).toMatchObject({ appointment_code: 'APT-ABC234', slot: { slot_id: 7, doctor_name: 'Dr. Sara Malik' } });
  });

  it.each(['slot_unavailable', 'not_found', 'not_booked', 'different_specialty'])('turns the SQL "%s" error into a BookingError', async (code) => {
    const { r } = repo(() => json({ code: 'P0001', message: code }, 400));
    await expect(r.cancel('APT-ABC234', '0300')).rejects.toEqual(new BookingError(code as never));
  });

  it('treats other database errors and timeouts as outages', async () => {
    const other = repo(() => json({ code: 'P0001', message: 'something else' }, 400));
    await expect(other.r.reschedule('APT-ABC234', '0300', 9)).rejects.toBeInstanceOf(DataSourceError);
    const down = repo(() => new Response('', { status: 503 }));
    await expect(down.r.availableSlots('cardiology', null, 5)).rejects.toThrow('supabase_http_503');
  });

  it('returns null from find when nothing matches, and passes filters as arguments', async () => {
    const { r, calls } = repo(() => json([]));
    await expect(r.find('APT-ABC234', '03001234567')).resolves.toBeNull();
    await r.availableSlots('dermatology', '2026-11-25', 12);
    expect(calls[1]!.body).toEqual({ p_specialty: 'dermatology', p_from: '2026-11-25', p_limit: 12 });
  });
});

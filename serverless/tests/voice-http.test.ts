import { describe, expect, it } from 'vitest';
import { MemoryBookingRepository } from '../lib/booking/memory.js';
import { createApp, type App } from '../lib/http.js';
import { signRetellBody } from '../lib/signature.js';
import { LogEmailSender, MemoryRepository, VALID, fakeClassifier, post, testConfig } from './helpers.js';

const KEY = 'retell-test-key';
const NOW = new Date('2026-11-23T04:10:00Z'); // Monday 09:10 in Pakistan

function setup(over: Parameters<typeof testConfig>[0] = {}) {
  const bookings = new MemoryBookingRepository(() => NOW);
  const repository = new MemoryRepository(() => NOW);
  const email = new LogEmailSender();
  const app = createApp({
    config: testConfig({ retellApiKey: KEY, ...over }),
    repository,
    bookings,
    email,
    classifier: fakeClassifier().classify,
    now: () => NOW,
  });
  const slot = bookings.addSlot({ doctor_name: 'Dr. Sara Malik', specialty_code: 'cardiology', slot_date: '2026-11-24', start_time: '10:00', end_time: '10:30' });
  return { app, bookings, repository, email, slot };
}

async function signed(path: string, payload: unknown, key = KEY) {
  const body = JSON.stringify(payload);
  return post(path, body, { 'x-retell-signature': await signRetellBody(body, key) });
}

const envelope = (name: string, args: Record<string, unknown>, call: Record<string, unknown> = { call_id: 'call_1' }) => ({ name, call, args });

async function bookOne(app: App, slotId: number) {
  const res = await app.bookAppointment(
    await signed('/api/book-appointment', envelope('book_appointment', { name: 'Test Patient', phone_no: '03001234567', email: 'patient@example.test', schedule_id: String(slotId) })),
  );
  return res.json();
}

describe('Retell signature', () => {
  it('rejects a missing, forged or wrong-key signature', async () => {
    const { app } = setup();
    const body = JSON.stringify(envelope('doctor_availability', { department: 'cardiology' }));
    expect((await app.doctorAvailability(post('/api/doctor-availability', body))).status).toBe(401);
    expect((await app.doctorAvailability(post('/api/doctor-availability', body, { 'x-retell-signature': `v=${Date.now()},d=${'0'.repeat(64)}` }))).status).toBe(401);
    expect((await app.doctorAvailability(await signed('/api/doctor-availability', envelope('x', { department: 'cardiology' }), 'other-key'))).status).toBe(401);
  });

  it('rejects a body changed after signing', async () => {
    const { app } = setup();
    const original = JSON.stringify(envelope('x', { department: 'cardiology' }));
    const sig = await signRetellBody(original, KEY);
    const tampered = original.replace('cardiology', 'dermatology');
    expect((await app.doctorAvailability(post('/api/doctor-availability', tampered, { 'x-retell-signature': sig }))).status).toBe(401);
  });

  it('is switched off (503) without RETELL_API_KEY, and POST only', async () => {
    const off = setup({ retellApiKey: null });
    expect((await off.app.doctorAvailability(await signed('/api/doctor-availability', envelope('x', {})))).status).toBe(503);
    const on = setup();
    expect((await on.app.doctorAvailability(new Request('https://api.example/api/doctor-availability'))).status).toBe(405);
  });
});

describe('voice tools', () => {
  it('lists availability for a spoken department', async () => {
    const { app } = setup();
    const res = await app.doctorAvailability(await signed('/api/doctor-availability', envelope('doctor_availability', { department: 'heart' })));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ success: true, status: 'success', department: 'Cardiology' });
    expect(body.consolidated_data[0].slots[0]).toMatchObject({ schedule_id: expect.any(Number), start_time: expect.stringMatching(/^\d{2}:\d{2}$/) });
  });

  it('books, then checks, cancels and confirms with the code and phone', async () => {
    const { app, slot } = setup();
    const booked = await bookOne(app, slot.slot_id);
    expect(booked).toMatchObject({ success: true, appointment_time: '10:00' });
    const code = booked.appointment_id as string;

    const spoken = code.replace('-', '').split('').join(' ');
    const status = await (await app.cancelStatus(await signed('/api/cancel-status', envelope('cancel', { appointment_id: spoken, phone_no: '+92 300 1234567' })))).json();
    expect(status).toMatchObject({ success: true, appointment_id: code });

    const cancelled = await (await app.confirmCancellation(await signed('/api/confirm-cancellation', envelope('cancel', { appointment_id: code, phone_no: '03001234567' })))).json();
    expect(cancelled).toMatchObject({ success: true, status: 'Cancelled' });
  });

  it("uses the caller's number when the agent didn't collect one", async () => {
    const { app, slot } = setup();
    const res = await app.bookAppointment(
      await signed('/api/book-appointment', envelope('book', { name: 'Test Patient', schedule_id: slot.slot_id }, { call_id: 'c2', from_number: '+923001234567' })),
    );
    expect(await res.json()).toMatchObject({ success: true });
  });

  it('asks for what is missing instead of failing', async () => {
    const { app, slot } = setup();
    const noPhone = await (await app.bookAppointment(await signed('/api/book-appointment', envelope('book', { name: 'Test Patient', schedule_id: slot.slot_id })))).json();
    expect(noPhone).toMatchObject({ success: false, message: 'Could you tell me the phone number you booked with?' });

    const noName = await app.bookAppointment(await signed('/api/book-appointment', envelope('book', { schedule_id: slot.slot_id })));
    expect(noName.status).toBe(200);
    expect(await noName.json()).toMatchObject({ success: false, error_code: 'VALIDATION_ERROR' });

    const badCode = await (await app.appointmentCheck(await signed('/api/appointment-check', envelope('check', { appointment_id: '12', phone_no: '03001234567' })))).json();
    expect(badCode.message).toMatch(/starts with A P T/);
  });

  it('reschedules by date and time', async () => {
    const { app, slot, bookings } = setup();
    bookings.addSlot({ doctor_name: 'Dr. Sara Malik', specialty_code: 'cardiology', slot_date: '2026-11-25', start_time: '11:00', end_time: '11:30' });
    const { appointment_id } = await bookOne(app, slot.slot_id);
    const r = await (
      await app.confirmReschedule(
        await signed('/api/confirm-reschedule', envelope('check_slot', { appointment_id, phone_no: '03001234567', appointment_date: '2026-11-25', slot_start_time: '11:00' })),
      )
    ).json();
    expect(r).toMatchObject({ success: true, appointment_date: '2026-11-25', appointment_time: '11:00' });
  });

  it('limits one call to 30 tool requests a minute', async () => {
    const { app } = setup();
    let last = 0;
    for (let i = 0; i < 31; i++) {
      last = (await app.doctorAvailability(await signed('/api/doctor-availability', envelope('x', { department: 'cardiology' }, { call_id: 'busy' })))).status;
    }
    expect(last).toBe(429);
  });
});

describe('complaint check by voice', () => {
  async function fileComplaint(app: App) {
    return (await app.submitComplaint(post('/api/complaints', VALID))).json();
  }

  it('reads back the status with the code and phone', async () => {
    const { app } = setup();
    const { complaint_code } = await fileComplaint(app);
    const r = await (await app.complaintCheck(await signed('/api/complaint-check', envelope('complaint_check', { complaint_id: complaint_code, phone_no: VALID.phone })))).json();
    expect(r).toMatchObject({ success: true, status: 'Pending', escalated: false });
  });

  it('escalates a complaint pending for more than 48 hours, like the n8n flow', async () => {
    const { app, repository, email } = setup();
    const { complaint_code } = await fileComplaint(app);
    repository.complaints[0]!.created_at = new Date(NOW.getTime() - 50 * 3_600_000).toISOString();
    const r = await (await app.complaintCheck(await signed('/api/complaint-check', envelope('complaint_check', { complaint_id: complaint_code, email: VALID.email })))).json();
    expect(r).toMatchObject({ success: true, escalated: true });
    expect(r.message).toMatch(/escalated it to our patient relations team/);
    expect(email.sent.at(-1)!.subject).toMatch(/^\[ESCALATED\] Complaint CMP-/);
    expect(repository.auditLog.at(-1)).toMatchObject({ action: 'ESCALATED' });
  });

  it('gives one answer for a wrong contact or unknown code', async () => {
    const { app } = setup();
    const { complaint_code } = await fileComplaint(app);
    const wrong = await (await app.complaintCheck(await signed('/api/complaint-check', envelope('c', { complaint_id: complaint_code, phone_no: '03119999999' })))).json();
    const unknown = await (await app.complaintCheck(await signed('/api/complaint-check', envelope('c', { complaint_id: 'CMP-NOPE99', phone_no: VALID.phone })))).json();
    expect(wrong.message).toBe(unknown.message);
    expect(wrong.success).toBe(false);
  });
});

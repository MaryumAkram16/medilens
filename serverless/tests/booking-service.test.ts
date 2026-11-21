import { describe, expect, it } from 'vitest';
import { MemoryBookingRepository } from '../lib/booking/memory.js';
import { BookingService } from '../lib/booking/service.js';
import { FailingEmailSender, LogEmailSender } from './helpers.js';

// Monday 23 November 2026, 09:10 in Pakistan.
const NOW = new Date('2026-11-23T04:10:00Z');
const PHONE = '+92 300 1234567';

function setup(email = new LogEmailSender()) {
  const repo = new MemoryBookingRepository(() => NOW);
  let n = 0;
  const service = new BookingService({ repository: repo, email, now: () => NOW, newCode: () => `APT-TEST${String(++n).padStart(2, '0')}` });
  const sara = (date: string, start: string, end: string) =>
    repo.addSlot({ doctor_name: 'Dr. Sara Malik', specialty_code: 'cardiology', slot_date: date, start_time: start, end_time: end });
  return { repo, service, email, sara };
}

const book = (service: BookingService, slotId: number, over: Partial<{ phone: string; callId: string | null; email: string | null }> = {}) =>
  service.book({ name: 'Test Patient', phone: PHONE, email: 'patient@example.test', slotId, callId: null, ...over });

describe('availability', () => {
  it('asks for a department it does not recognise', async () => {
    const { service } = setup();
    const r = await service.availability('something else', undefined);
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/I can book General Medicine, Cardiology/);
  });

  it('fills demo slots, hides past and booked ones, and groups by doctor like n8n', async () => {
    const { service, repo } = setup();
    const r = await service.availability('heart', undefined);
    expect(r.success).toBe(true);
    const groups = r.consolidated_data as { doctor_name: string; slot_date: string; slots: { schedule_id: number; start_time: string }[] }[];
    // 09:00 has passed at 09:10, so today's first opening is 09:30.
    expect(groups[0]).toMatchObject({ doctor_name: 'Dr. Sara Malik', slot_date: '2026-11-23' });
    expect(groups[0]!.slots[0]!.start_time).toBe('09:30');
    expect(r.message).toContain('Dr. Sara Malik on Monday 23 November at 9:30 AM');

    await book(service, groups[0]!.slots[0]!.schedule_id);
    const after = await service.availability('cardiology', undefined);
    expect((after.consolidated_data as typeof groups)[0]!.slots[0]!.start_time).toBe('10:00');
    expect(repo.slots.some((s) => s.slot_date === '2026-11-29')).toBe(false); // Sunday is closed
  });
});

describe('book', () => {
  it('books, returns a code (not the slot number) and emails a confirmation', async () => {
    const { service, sara, email } = setup();
    const slot = sara('2026-11-24', '10:00', '10:30');
    const r = await book(service, slot.slot_id);
    expect(r).toMatchObject({ success: true, appointment_id: 'APT-TEST01', doctor_name: 'Dr. Sara Malik', department: 'Cardiology', appointment_time: '10:00', email_sent: true });
    expect(r.message).toContain('Your appointment ID is A P T, T E S T 0 1');
    expect(email.sent[0]!.subject).toBe('MediLens appointment booked: APT-TEST01');
  });

  it('refuses a slot someone else already has', async () => {
    const { service, sara } = setup();
    const slot = sara('2026-11-24', '10:00', '10:30');
    await book(service, slot.slot_id);
    const second = await book(service, slot.slot_id, { phone: '0311 7654321' });
    expect(second).toMatchObject({ success: false });
    expect(second.message).toMatch(/just booked by another patient/);
  });

  it('refuses past and blocked slots', async () => {
    const { service, sara, repo } = setup();
    expect((await book(service, sara('2026-11-23', '09:00', '09:30').slot_id)).success).toBe(false);
    const blocked = repo.addSlot({ doctor_name: 'Dr. Sara Malik', specialty_code: 'cardiology', slot_date: '2026-11-25', start_time: '10:00', end_time: '10:30', blocked: true });
    expect((await book(service, blocked.slot_id)).success).toBe(false);
  });

  it('returns the same booking when Retell retries the same call', async () => {
    const { service, sara, repo } = setup();
    const slot = sara('2026-11-24', '10:00', '10:30');
    const a = await book(service, slot.slot_id, { callId: 'call_1' });
    const b = await book(service, slot.slot_id, { callId: 'call_1' });
    expect(b.appointment_id).toBe(a.appointment_id);
    expect(repo.appointments).toHaveLength(1);
  });

  it('still books when the email fails, and says so', async () => {
    const { service, sara } = setup(new FailingEmailSender() as unknown as LogEmailSender);
    const r = await book(service, sara('2026-11-24', '10:00', '10:30').slot_id);
    expect(r).toMatchObject({ success: true, email_sent: false });
    expect(r.message).toMatch(/could not send the confirmation email/);
  });
});

describe('check, cancel and reschedule need the code and the matching phone', () => {
  it('gives the same answer for a wrong phone and an unknown code', async () => {
    const { service, sara } = setup();
    await book(service, sara('2026-11-24', '10:00', '10:30').slot_id);
    const wrongPhone = await service.cancelStatus('APT-TEST01', '0311 7654321');
    const unknown = await service.cancelStatus('APT-NOPE99', PHONE);
    expect(wrongPhone).toEqual(unknown);
    expect(wrongPhone.success).toBe(false);
    expect((await service.cancel('APT-TEST01', '0311 7654321')).success).toBe(false);
  });

  it('accepts the phone in local or international form', async () => {
    const { service, sara } = setup();
    await book(service, sara('2026-11-24', '10:00', '10:30').slot_id);
    expect((await service.cancelStatus('APT-TEST01', '03001234567')).success).toBe(true);
  });

  it('cancels, frees the slot for someone else, and refuses a second cancel', async () => {
    const { service, sara, email } = setup();
    const slot = sara('2026-11-24', '10:00', '10:30');
    await book(service, slot.slot_id);
    const r = await service.cancel('APT-TEST01', PHONE);
    expect(r).toMatchObject({ success: true, status: 'Cancelled' });
    expect(email.sent.at(-1)!.subject).toBe('MediLens appointment cancelled: APT-TEST01');
    // n8n bug: 'booked' vs 'Booked' left cancelled slots unbookable.
    expect((await book(service, slot.slot_id, { phone: '0311 7654321' })).success).toBe(true);
    expect((await service.cancel('APT-TEST01', PHONE)).message).toMatch(/already cancelled/);
  });

  it('offers the next opening in the same specialty, excluding the current slot', async () => {
    const { service, sara } = setup();
    const mine = sara('2026-11-24', '10:00', '10:30');
    sara('2026-11-24', '11:00', '11:30');
    await book(service, mine.slot_id);
    const r = await service.check('APT-TEST01', PHONE);
    expect(r.next_available_slot).toMatchObject({ doctor_name: 'Dr. Sara Malik' });
    expect((r.next_available_slot as { schedule_id: number }).schedule_id).not.toBe(mine.slot_id);
  });

  it('reschedules by slot and releases the old slot', async () => {
    const { service, sara } = setup();
    const oldSlot = sara('2026-11-24', '10:00', '10:30');
    const newSlot = sara('2026-11-25', '11:00', '11:30');
    await book(service, oldSlot.slot_id);
    const r = await service.reschedule('APT-TEST01', PHONE, { slotId: newSlot.slot_id });
    expect(r).toMatchObject({ success: true, appointment_id: 'APT-TEST01', appointment_date: '2026-11-25', appointment_time: '11:00' });
    // n8n bug: the "free old slot" query was inverted, so the old slot stayed taken.
    expect((await book(service, oldSlot.slot_id, { phone: '0311 7654321' })).success).toBe(true);
  });

  it('reschedules by date and time, preferring the same doctor', async () => {
    const { service, sara, repo } = setup();
    await book(service, sara('2026-11-24', '10:00', '10:30').slot_id);
    repo.addSlot({ doctor_name: 'Dr. Another', specialty_code: 'cardiology', slot_date: '2026-11-26', start_time: '09:30', end_time: '10:00' });
    const same = sara('2026-11-26', '09:30', '10:00');
    const r = await service.reschedule('APT-TEST01', PHONE, { date: '2026-11-26', time: '09:30' });
    expect(r).toMatchObject({ success: true, doctor_name: 'Dr. Sara Malik' });
    expect(repo.appointments[0]!.slot_id).toBe(same.slot_id);
  });

  it('will not move an appointment into another department or a taken slot', async () => {
    const { service, sara, repo } = setup();
    await book(service, sara('2026-11-24', '10:00', '10:30').slot_id);
    const skin = repo.addSlot({ doctor_name: 'Dr. Hina Qureshi', specialty_code: 'dermatology', slot_date: '2026-11-25', start_time: '10:00', end_time: '10:30' });
    expect((await service.reschedule('APT-TEST01', PHONE, { slotId: skin.slot_id })).message).toMatch(/different department/);
    const taken = sara('2026-11-25', '12:00', '12:30');
    await book(service, taken.slot_id, { phone: '0311 7654321' });
    expect((await service.reschedule('APT-TEST01', PHONE, { slotId: taken.slot_id })).message).toMatch(/no longer available/);
    expect((await service.reschedule('APT-TEST01', PHONE, { date: '2026-11-30', time: '09:00' })).message).toMatch(/no free Cardiology slot/);
  });
});

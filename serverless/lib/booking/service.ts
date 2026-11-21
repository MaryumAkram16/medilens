/**
 * The voice agent's tools, ported from n8n Medilens_Voice_Appointment_Booking.json.
 * Every result has `success` and a `message` written to be spoken by the agent;
 * business problems (slot taken, wrong code) are answers, not errors, so the
 * agent can explain them and carry on.
 */
import { randomInt } from 'node:crypto';
import type { EmailSender } from '../notify/email.js';
import { SPECIALTIES, SPECIALTY_LIST_SPOKEN, resolveSpecialty, type SpecialtyCode } from './catalog.js';
import { hhmm, karachiParts, spokenDate, spokenTime } from './clock.js';
import { BookingError, type Appointment, type BookingRepository, type Slot } from './types.js';

export interface VoiceResult {
  success: boolean;
  message: string;
  [key: string]: unknown;
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function newAppointmentCode(): string {
  let s = 'APT-';
  for (let i = 0; i < 6; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return s;
}

/**
 * Turns what a caller or speech-to-text produced into a code: "a p t 7 k 2 q x m",
 * "APT 7K2QXM" and "7k2qxm" all become "APT-7K2QXM". Returns null if it can't.
 */
export function normalizeCode(raw: unknown, prefix: 'APT' | 'CMP'): string | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const s = String(raw).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const body = s.startsWith(prefix) ? s.slice(prefix.length) : s;
  return /^[A-Z0-9]{6}$/.test(body) ? `${prefix}-${body}` : null;
}

export const spellCode = (code: string) =>
  code
    .split('-')
    .map((p) => p.split('').join(' '))
    .join(', ');

const when = (slot: Slot) => `${spokenDate(slot.slot_date)} at ${spokenTime(slot.start_time)}`;

/** Same grouping as the n8n "Group Slots By Doctor" node. */
function groupByDoctor(slots: Slot[]) {
  const groups = new Map<string, { doctor_name: string; slot_date: string; slots: { schedule_id: number; start_time: string; end_time: string }[] }>();
  for (const s of slots) {
    const key = `${s.doctor_name}-${s.slot_date}`;
    if (!groups.has(key)) groups.set(key, { doctor_name: s.doctor_name, slot_date: s.slot_date, slots: [] });
    groups.get(key)!.slots.push({ schedule_id: s.slot_id, start_time: hhmm(s.start_time), end_time: hhmm(s.end_time) });
  }
  return [...groups.values()];
}

function appointmentView(a: Appointment) {
  return {
    appointment_id: a.appointment_code,
    status: a.status,
    patient_name: a.patient_name,
    doctor_name: a.slot.doctor_name,
    department: SPECIALTIES[a.slot.specialty_code],
    appointment_date: a.slot.slot_date,
    appointment_time: hhmm(a.slot.start_time),
  };
}

export interface BookingServiceDeps {
  repository: BookingRepository;
  email: EmailSender;
  now?: () => Date;
  newCode?: () => string;
  log?: (msg: string, fields: Record<string, unknown>) => void;
}

const NOT_FOUND =
  "I couldn't find an appointment with that ID and phone number. Could you read me the appointment ID again, and the phone number you booked with?";

export class BookingService {
  private readonly now: () => Date;
  private readonly newCode: () => string;
  private readonly log: (msg: string, fields: Record<string, unknown>) => void;
  private demoSlotsReadyOn: string | null = null;

  constructor(private readonly deps: BookingServiceDeps) {
    this.now = deps.now ?? (() => new Date());
    this.newCode = deps.newCode ?? newAppointmentCode;
    this.log = deps.log ?? (() => {});
  }

  /** Tops up demo slots at most once a day per instance. */
  private async ensureSlots(): Promise<void> {
    const today = karachiParts(this.now()).date;
    if (this.demoSlotsReadyOn === today) return;
    await this.deps.repository.ensureDemoSlots(14);
    this.demoSlotsReadyOn = today;
  }

  async availability(department: string | undefined, date: string | undefined): Promise<VoiceResult> {
    const specialty = resolveSpecialty(department);
    if (!specialty) {
      return { success: false, status: 'failed', message: `Which department would you like? I can book ${SPECIALTY_LIST_SPOKEN}.` };
    }
    await this.ensureSlots();
    const from = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
    const slots = await this.deps.repository.availableSlots(specialty, from, 12);
    if (slots.length === 0) {
      return { success: false, status: 'failed', message: `No doctors are available in ${SPECIALTIES[specialty]} right now.` };
    }
    const first = slots.slice(0, 3);
    return {
      success: true,
      status: 'success',
      department: SPECIALTIES[specialty],
      consolidated_data: groupByDoctor(slots),
      message: `In ${SPECIALTIES[specialty]}, the next openings are: ${first
        .map((s) => `${s.doctor_name} on ${when(s)}`)
        .join('; ')}. Which one would you like?`,
    };
  }

  async book(input: { name: string; phone: string; email: string | null; slotId: number; callId: string | null }): Promise<VoiceResult> {
    let appt: Appointment;
    try {
      appt = await this.deps.repository.book({ ...input, code: this.newCode() });
    } catch (err) {
      if (err instanceof BookingError && err.code === 'slot_unavailable') {
        return { success: false, message: 'Sorry, that slot was just booked by another patient or is no longer available. Please choose another time.' };
      }
      throw err;
    }
    const v = appointmentView(appt);
    const emailed = await this.sendEmail(appt, 'booked');
    return {
      success: true,
      ...v,
      email_sent: emailed,
      message:
        `${appt.patient_name}, your appointment is booked with ${appt.slot.doctor_name} in ${v.department} on ${when(appt.slot)}. ` +
        `Your appointment ID is ${spellCode(appt.appointment_code)}. Please arrive 10 minutes early.` +
        (appt.email && !emailed ? ' I could not send the confirmation email, so please note the ID.' : ''),
    };
  }

  async check(code: string, phone: string): Promise<VoiceResult> {
    const appt = await this.deps.repository.find(code, phone);
    if (!appt) return { success: false, message: NOT_FOUND };
    const v = appointmentView(appt);
    if (appt.status !== 'Booked') {
      return { success: true, ...v, message: `Appointment ${spellCode(code)} is ${appt.status.toLowerCase()}.` };
    }
    await this.ensureSlots();
    // The next opening in the same specialty after now, excluding this slot.
    const next = (await this.deps.repository.availableSlots(appt.slot.specialty_code, null, 5)).find((s) => s.slot_id !== appt.slot.slot_id);
    return {
      success: true,
      ...v,
      next_available_slot: next
        ? { schedule_id: next.slot_id, doctor_name: next.doctor_name, slot_date: next.slot_date, start_time: hhmm(next.start_time), end_time: hhmm(next.end_time) }
        : null,
      message:
        `Your appointment is with ${appt.slot.doctor_name} on ${when(appt.slot)}.` +
        (next ? ` The next available slot is with ${next.doctor_name} on ${when(next)}. Would you like that one?` : ' There are no other open slots right now.'),
    };
  }

  /** Reschedules to a slot id, or to a date and time in the same specialty (same doctor preferred). */
  async reschedule(code: string, phone: string, target: { slotId?: number; date?: string; time?: string }): Promise<VoiceResult> {
    const current = await this.deps.repository.find(code, phone);
    if (!current) return { success: false, message: NOT_FOUND };
    if (current.status !== 'Booked') return { success: false, message: `Appointment ${spellCode(code)} is ${current.status.toLowerCase()}, so it can't be moved.` };

    let slotId = target.slotId;
    if (slotId === undefined && target.date && target.time) {
      const options = (await this.deps.repository.availableSlots(current.slot.specialty_code, target.date, 50)).filter(
        (s) => s.slot_date === target.date && hhmm(s.start_time) === hhmm(target.time!),
      );
      slotId = (options.find((s) => s.doctor_name === current.slot.doctor_name) ?? options[0])?.slot_id;
      if (slotId === undefined) return { success: false, message: `There's no free ${SPECIALTIES[current.slot.specialty_code]} slot on ${spokenDate(target.date)} at ${spokenTime(target.time)}. Shall I find the next available one?` };
    }
    if (slotId === undefined) return { success: false, message: 'Which new date and time would you like?' };

    let moved: Appointment;
    try {
      moved = await this.deps.repository.reschedule(code, phone, slotId);
    } catch (err) {
      if (err instanceof BookingError) {
        const messages: Record<string, string> = {
          slot_unavailable: 'Sorry, that slot is no longer available. Please choose another time.',
          different_specialty: `That slot is in a different department. I can only move it to another ${SPECIALTIES[current.slot.specialty_code]} slot.`,
          not_found: NOT_FOUND,
          not_booked: "That appointment isn't active any more, so it can't be moved.",
        };
        return { success: false, message: messages[err.code] ?? NOT_FOUND };
      }
      throw err;
    }
    const emailed = await this.sendEmail(moved, 'rescheduled');
    return {
      success: true,
      ...appointmentView(moved),
      email_sent: emailed,
      message: `Done. Your appointment ${spellCode(code)} is now with ${moved.slot.doctor_name} on ${when(moved.slot)}. Your old slot has been released.`,
    };
  }

  async cancelStatus(code: string, phone: string): Promise<VoiceResult> {
    const appt = await this.deps.repository.find(code, phone);
    if (!appt) return { success: false, message: NOT_FOUND };
    const v = appointmentView(appt);
    if (appt.status !== 'Booked') return { success: true, ...v, message: `Appointment ${spellCode(code)} is already ${appt.status.toLowerCase()}.` };
    return {
      success: true,
      ...v,
      message: `I found your appointment with ${appt.slot.doctor_name} on ${when(appt.slot)}. Do you want me to cancel it?`,
    };
  }

  async cancel(code: string, phone: string): Promise<VoiceResult> {
    let appt: Appointment;
    try {
      appt = await this.deps.repository.cancel(code, phone);
    } catch (err) {
      if (err instanceof BookingError && err.code === 'not_found') return { success: false, message: NOT_FOUND };
      if (err instanceof BookingError && err.code === 'not_booked') return { success: false, message: 'That appointment is already cancelled or completed.' };
      throw err;
    }
    const emailed = await this.sendEmail(appt, 'cancelled');
    return {
      success: true,
      ...appointmentView(appt),
      email_sent: emailed,
      message: `Your appointment ${spellCode(code)} with ${appt.slot.doctor_name} on ${when(appt.slot)} has been cancelled.`,
    };
  }

  private async sendEmail(appt: Appointment, what: 'booked' | 'rescheduled' | 'cancelled'): Promise<boolean> {
    if (!appt.email) return false;
    const v = appointmentView(appt);
    try {
      await this.deps.email.send({
        to: appt.email,
        subject: `MediLens appointment ${what}: ${appt.appointment_code}`,
        text: [
          `${appt.patient_name},`,
          '',
          `Your appointment has been ${what}.`,
          `Appointment ID: ${appt.appointment_code}`,
          `Doctor: ${v.doctor_name}`,
          `Department: ${v.department}`,
          `Date: ${spokenDate(appt.slot.slot_date)}`,
          `Time: ${spokenTime(appt.slot.start_time)}`,
          what === 'cancelled' ? '' : '\nPlease arrive 10 minutes before your appointment time.',
          '',
          'MediLens Clinic (demo system)',
        ].join('\n'),
      });
      return true;
    } catch (err) {
      this.log('appointment_email_failed', { appointment: appt.appointment_code, reason: err instanceof Error ? err.message.slice(0, 120) : 'unknown' });
      return false;
    }
  }
}

export function isSpecialty(code: string): code is SpecialtyCode {
  return code in SPECIALTIES;
}

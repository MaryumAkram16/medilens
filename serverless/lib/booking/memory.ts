/**
 * In-memory appointments with the same rules as the database functions in
 * db/002_appointments.sql. Used for DATA_SOURCE=demo and the service tests;
 * the SQL itself is tested against real Postgres in tests/migration.test.ts.
 */
import { SPECIALTY_CODES, type SpecialtyCode } from './catalog.js';
import { addDays, hhmm, isoWeekday, karachiParts } from './clock.js';
import { BookingError, phoneKey, type Appointment, type AppointmentStatus, type BookRequest, type BookingRepository, type Slot } from './types.js';

interface Row {
  appointment_code: string;
  slot_id: number;
  patient_name: string;
  phone: string;
  email: string | null;
  status: AppointmentStatus;
  call_id: string | null;
}

export const DEMO_DOCTORS: { name: string; specialty: SpecialtyCode }[] = [
  { name: 'Dr. Ayesha Khan', specialty: 'general_medicine' },
  { name: 'Dr. Bilal Ahmed', specialty: 'general_medicine' },
  { name: 'Dr. Sara Malik', specialty: 'cardiology' },
  { name: 'Dr. Usman Raza', specialty: 'pediatrics' },
  { name: 'Dr. Hina Qureshi', specialty: 'dermatology' },
  { name: 'Dr. Omar Siddiqui', specialty: 'orthopedics' },
  { name: 'Dr. Fatima Javed', specialty: 'gynecology' },
];

const SLOT_TIMES = ['09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '12:00', '12:30'];

export class MemoryBookingRepository implements BookingRepository {
  readonly slots: (Slot & { blocked: boolean })[] = [];
  readonly appointments: Row[] = [];
  private nextSlotId = 1;

  constructor(private readonly now: () => Date = () => new Date()) {}

  private isFuture(slot: Slot): boolean {
    const n = karachiParts(this.now());
    return slot.slot_date > n.date || (slot.slot_date === n.date && hhmm(slot.start_time) > n.time);
  }

  private bookedSlot(slotId: number): boolean {
    return this.appointments.some((a) => a.slot_id === slotId && a.status === 'Booked');
  }

  private bookable(slot: (Slot & { blocked: boolean }) | undefined): slot is Slot & { blocked: boolean } {
    return !!slot && !slot.blocked && this.isFuture(slot) && !this.bookedSlot(slot.slot_id);
  }

  private view(row: Row): Appointment {
    const { blocked: _b, ...slot } = this.slots.find((s) => s.slot_id === row.slot_id)!;
    return { appointment_code: row.appointment_code, status: row.status, patient_name: row.patient_name, email: row.email, slot };
  }

  private owned(code: string, phone: string): Row {
    const row = this.appointments.find((a) => a.appointment_code === code && phoneKey(a.phone) === phoneKey(phone));
    if (!row) throw new BookingError('not_found');
    return row;
  }

  /** Adds a slot directly (tests). */
  addSlot(slot: Omit<Slot, 'slot_id'> & { blocked?: boolean }): Slot {
    const s = { ...slot, slot_id: this.nextSlotId++, blocked: slot.blocked ?? false };
    this.slots.push(s);
    return s;
  }

  async ensureDemoSlots(days: number): Promise<number> {
    const today = karachiParts(this.now()).date;
    let added = 0;
    for (let i = 0; i <= Math.min(days, 60); i++) {
      const date = addDays(today, i);
      if (isoWeekday(date) === 7) continue;
      for (const doc of DEMO_DOCTORS) {
        for (const start of SLOT_TIMES) {
          if (this.slots.some((s) => s.doctor_name === doc.name && s.slot_date === date && hhmm(s.start_time) === start)) continue;
          const [h, m] = start.split(':').map(Number);
          const endMin = h! * 60 + m! + 30;
          const end = `${String(Math.floor(endMin / 60)).padStart(2, '0')}:${String(endMin % 60).padStart(2, '0')}`;
          this.addSlot({ doctor_name: doc.name, specialty_code: doc.specialty, slot_date: date, start_time: start, end_time: end });
          added++;
        }
      }
    }
    return added;
  }

  async availableSlots(specialty: SpecialtyCode, from: string | null, limit: number): Promise<Slot[]> {
    if (!SPECIALTY_CODES.includes(specialty)) return [];
    const start = from ?? karachiParts(this.now()).date;
    return this.slots
      .filter((s) => s.specialty_code === specialty && s.slot_date >= start && this.bookable(s))
      .sort((a, b) => a.slot_date.localeCompare(b.slot_date) || a.start_time.localeCompare(b.start_time) || a.doctor_name.localeCompare(b.doctor_name))
      .slice(0, Math.max(1, Math.min(limit, 50)))
      .map(({ blocked: _b, ...s }) => s);
  }

  async book(req: BookRequest): Promise<Appointment> {
    if (req.callId) {
      const retry = this.appointments.find((a) => a.call_id === req.callId && a.slot_id === req.slotId && a.status === 'Booked');
      if (retry) return this.view(retry);
    }
    if (!this.bookable(this.slots.find((s) => s.slot_id === req.slotId))) throw new BookingError('slot_unavailable');
    const row: Row = {
      appointment_code: req.code,
      slot_id: req.slotId,
      patient_name: req.name,
      phone: req.phone,
      email: req.email,
      status: 'Booked',
      call_id: req.callId,
    };
    this.appointments.push(row);
    return this.view(row);
  }

  async cancel(code: string, phone: string): Promise<Appointment> {
    const row = this.owned(code, phone);
    if (row.status !== 'Booked') throw new BookingError('not_booked');
    row.status = 'Cancelled';
    return this.view(row);
  }

  async reschedule(code: string, phone: string, newSlotId: number): Promise<Appointment> {
    const row = this.owned(code, phone);
    if (row.status !== 'Booked') throw new BookingError('not_booked');
    const current = this.slots.find((s) => s.slot_id === row.slot_id)!;
    const target = this.slots.find((s) => s.slot_id === newSlotId);
    if (target?.slot_id === row.slot_id) return this.view(row);
    if (!this.bookable(target)) throw new BookingError('slot_unavailable');
    if (target.specialty_code !== current.specialty_code) throw new BookingError('different_specialty');
    row.slot_id = newSlotId;
    return this.view(row);
  }

  async find(code: string, phone: string): Promise<Appointment | null> {
    try {
      return this.view(this.owned(code, phone));
    } catch {
      return null;
    }
  }
}

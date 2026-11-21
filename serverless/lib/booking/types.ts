import type { SpecialtyCode } from './catalog.js';

export interface Slot {
  slot_id: number;
  doctor_name: string;
  specialty_code: SpecialtyCode;
  /** YYYY-MM-DD, Pakistan time */
  slot_date: string;
  /** HH:MM or HH:MM:SS */
  start_time: string;
  end_time: string;
}

export type AppointmentStatus = 'Booked' | 'Cancelled' | 'Completed';

export interface Appointment {
  appointment_code: string;
  status: AppointmentStatus;
  patient_name: string;
  email: string | null;
  slot: Slot;
}

export interface BookRequest {
  slotId: number;
  name: string;
  phone: string;
  email: string | null;
  code: string;
  callId: string | null;
}

export type BookingErrorCode = 'slot_unavailable' | 'not_found' | 'not_booked' | 'different_specialty';

/** A business outcome the agent should explain to the caller (not a crash). */
export class BookingError extends Error {
  constructor(readonly code: BookingErrorCode) {
    super(code);
    this.name = 'BookingError';
  }
}

/**
 * Appointment store. Book, cancel and reschedule are atomic (database functions
 * in Supabase); every lookup or change by code also requires the phone number.
 */
export interface BookingRepository {
  availableSlots(specialty: SpecialtyCode, from: string | null, limit: number): Promise<Slot[]>;
  book(req: BookRequest): Promise<Appointment>;
  cancel(code: string, phone: string): Promise<Appointment>;
  reschedule(code: string, phone: string, newSlotId: number): Promise<Appointment>;
  find(code: string, phone: string): Promise<Appointment | null>;
  /** Keeps demo slots available for the next days; returns how many were added. */
  ensureDemoSlots(days: number): Promise<number>;
}

/** Last 10 digits: "0300 1234567" and "+92 300 1234567" are the same phone. */
export const phoneKey = (phone: string) => phone.replace(/\D/g, '').slice(-10);

/**
 * Appointments in Supabase through the database functions in
 * db/002_appointments.sql (PostgREST /rpc). Each change is one function call,
 * so it is atomic; the service-role key is server-side only.
 */
import { DataSourceError } from '../data/types.js';
import type { SpecialtyCode } from './catalog.js';
import { BookingError, type Appointment, type BookRequest, type BookingErrorCode, type BookingRepository, type Slot } from './types.js';

export interface SupabaseBookingOptions {
  url: string;
  serviceKey: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

const BUSINESS_ERRORS: BookingErrorCode[] = ['slot_unavailable', 'not_found', 'not_booked', 'different_specialty'];

interface AppointmentRow {
  appointment_code: string;
  status: Appointment['status'];
  patient_name: string;
  email: string | null;
  slot_id: number;
}

interface FoundRow extends AppointmentRow {
  doctor_name: string;
  specialty_code: SpecialtyCode;
  slot_date: string;
  start_time: string;
  end_time: string;
}

export class SupabaseBookingRepository implements BookingRepository {
  private readonly base: string;
  private readonly doFetch: typeof fetch;

  constructor(private readonly opts: SupabaseBookingOptions) {
    this.base = `${opts.url.replace(/\/+$/, '')}/rest/v1/rpc`;
    this.doFetch = opts.fetch ?? fetch;
  }

  private async rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    let res: Response;
    try {
      res = await this.doFetch(`${this.base}/${fn}`, {
        method: 'POST',
        headers: {
          apikey: this.opts.serviceKey,
          authorization: `Bearer ${this.opts.serviceKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(args),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 8_000),
      });
    } catch (err) {
      throw new DataSourceError(err instanceof Error && err.name === 'TimeoutError' ? 'supabase_timeout' : 'supabase_unreachable');
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { code?: string; message?: string };
      if (body.code === 'P0001' && BUSINESS_ERRORS.includes(body.message as BookingErrorCode)) {
        throw new BookingError(body.message as BookingErrorCode);
      }
      throw new DataSourceError(`supabase_http_${res.status}`);
    }
    return (await res.json()) as T;
  }

  /** The functions return bare appointment rows; read the slot back with find(). */
  private async withSlot(rows: AppointmentRow[], phone: string): Promise<Appointment> {
    const row = rows[0];
    if (!row) throw new DataSourceError('supabase_empty_result');
    const full = await this.find(row.appointment_code, phone);
    if (!full) throw new DataSourceError('supabase_missing_after_write');
    return full;
  }

  async availableSlots(specialty: SpecialtyCode, from: string | null, limit: number): Promise<Slot[]> {
    const rows = await this.rpc<Slot[]>('available_slots', { p_specialty: specialty, p_from: from, p_limit: limit });
    return rows.map((r) => ({ ...r, slot_id: Number(r.slot_id) }));
  }

  async book(req: BookRequest): Promise<Appointment> {
    const rows = await this.rpc<AppointmentRow[]>('book_appointment', {
      p_slot_id: req.slotId,
      p_name: req.name,
      p_phone: req.phone,
      p_email: req.email ?? '',
      p_code: req.code,
      p_call_id: req.callId,
    });
    return this.withSlot(rows, req.phone);
  }

  async cancel(code: string, phone: string): Promise<Appointment> {
    return this.withSlot(await this.rpc<AppointmentRow[]>('cancel_appointment', { p_code: code, p_phone: phone }), phone);
  }

  async reschedule(code: string, phone: string, newSlotId: number): Promise<Appointment> {
    return this.withSlot(
      await this.rpc<AppointmentRow[]>('reschedule_appointment', { p_code: code, p_phone: phone, p_new_slot_id: newSlotId }),
      phone,
    );
  }

  async find(code: string, phone: string): Promise<Appointment | null> {
    const [row] = await this.rpc<FoundRow[]>('find_appointment', { p_code: code, p_phone: phone });
    if (!row) return null;
    return {
      appointment_code: row.appointment_code,
      status: row.status,
      patient_name: row.patient_name,
      email: row.email,
      slot: {
        slot_id: Number(row.slot_id),
        doctor_name: row.doctor_name,
        specialty_code: row.specialty_code,
        slot_date: row.slot_date,
        start_time: row.start_time,
        end_time: row.end_time,
      },
    };
  }

  async ensureDemoSlots(days: number): Promise<number> {
    return Number(await this.rpc<number>('ensure_demo_slots', { p_days: days }));
  }
}

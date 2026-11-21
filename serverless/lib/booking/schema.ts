/**
 * What Retell sends to a custom function: { name, call, args }. Arguments come
 * from speech, so they are loose strings; these schemas accept that and the
 * service normalises codes, phones and dates.
 */
import { z } from 'zod';

const str = (max: number) => z.string().trim().max(max);
const optionalStr = (max: number) => z.preprocess((v) => (v === null || v === '' ? undefined : v), str(max).optional());
const idLike = z.union([z.string(), z.number()]).transform((v) => String(v).trim());
const date = z.preprocess((v) => (v === '' || v === null ? undefined : v), z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD').optional());
const time = z.preprocess(
  (v) => (v === '' || v === null ? undefined : v),
  z.string().regex(/^([01]?\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, 'time must be HH:MM (24-hour)').optional(),
);

export const retellEnvelope = z.object({
  name: z.string().optional(),
  call: z
    .object({
      call_id: z.string().max(128).optional(),
      from_number: z.string().max(32).optional(),
    })
    .loose()
    .optional(),
  args: z.record(z.string(), z.unknown()).default({}),
});

export const availabilityArgs = z.object({
  department: optionalStr(80),
  date,
});

export const bookArgs = z.object({
  name: str(100).min(1, 'name is required'),
  phone_no: optionalStr(32),
  email: optionalStr(254),
  schedule_id: idLike.pipe(z.string().regex(/^\d{1,12}$/, 'schedule_id must be a slot number')),
});

export const appointmentArgs = z.object({
  appointment_id: idLike,
  phone_no: optionalStr(32),
  patient_name: optionalStr(100),
});

export const rescheduleArgs = appointmentArgs.extend({
  schedule_id: z.preprocess((v) => (v === '' || v === null ? undefined : v), idLike.pipe(z.string().regex(/^\d{1,12}$/)).optional()),
  appointment_date: date,
  slot_start_time: time,
});

export const complaintCheckArgs = z.object({
  complaint_id: idLike,
  phone_no: optionalStr(32),
  email: optionalStr(254),
});

import { z } from 'zod';
import { PRIORITIES } from './catalog.js';

const trimmed = (max: number) => z.string().trim().min(1).max(max);

/** POST /api/complaints. Keys are matched case-insensitively, like the n8n workflow. */
export const submitComplaintSchema = z.object({
  name: trimmed(100),
  email: z.string().trim().toLowerCase().pipe(z.email()).pipe(z.string().max(254)),
  phone: z
    .string()
    .trim()
    .regex(/^\+?[0-9][0-9 ()-]{5,19}$/, 'phone must be 7 to 20 digits, spaces or dashes'),
  details: z.string().trim().min(10, 'details must be at least 10 characters').max(4000),
  // What the patient picked in the form: kept as hints, the triage decides.
  type: z.string().trim().max(60).optional(),
  priority: z.enum(PRIORITIES).optional(),
  channel: z.enum(['web', 'voice']).default('web'),
});

export type SubmitComplaintInput = z.infer<typeof submitComplaintSchema>;

/** POST /api/complaint-status: the code plus the email or phone used to file it. */
export const complaintStatusSchema = z
  .object({
    complaint_code: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^CMP-[A-Z0-9]{6}$/, 'complaint_code looks like CMP-ABC123'),
    email: z.string().trim().toLowerCase().max(254).optional(),
    phone: z.string().trim().max(20).optional(),
  })
  .refine((v) => Boolean(v.email || v.phone), { message: 'email or phone is required', path: ['email'] });

export function lowercaseKeys(body: unknown): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  return Object.fromEntries(Object.entries(body).map(([k, v]) => [k.toLowerCase(), v]));
}

/** First problem, phrased for a person (field + reason), never echoing the value. */
export function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'invalid request';
  const field = issue.path.join('.') || 'body';
  return issue.code === 'invalid_type' && issue.input === undefined ? `${field} is required` : `${field}: ${issue.message}`;
}

/**
 * Staff review: confirm or correct a complaint's priority and department, and
 * move it through Pending -> In Review -> Resolved.
 *
 * The first review of each complaint is the ground truth for live accuracy:
 * "of the complaints staff have looked at, how often was the triage right?".
 * Corrections also become evaluation cases, so the test set grows from the
 * mistakes that actually happen.
 */
import { z } from 'zod';
import type { ComplaintRecord, ComplaintRepository, ComplaintStatus, ReviewedComplaint } from '../data/types.js';
import type { EmailSender } from '../notify/email.js';
import { DEPARTMENTS, DEPARTMENT_CODES, PRIORITIES, type DepartmentCode, type Priority } from './catalog.js';

export const reviewSchema = z
  .object({
    complaint_code: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^CMP-[A-Z0-9]{6}$/, 'complaint_code looks like CMP-ABC123'),
    status: z.enum(['Pending', 'In Review', 'Resolved']).optional(),
    priority: z.enum(PRIORITIES).optional(),
    department: z.enum(DEPARTMENT_CODES as [string, ...string[]]).optional(),
    /** Confirms the triage was right without changing anything else. */
    confirm: z.boolean().optional(),
    note: z.string().trim().max(500).optional(),
  })
  .refine((v) => v.status || v.priority || v.department || v.confirm, {
    message: 'send at least one of status, priority, department or confirm',
    path: ['status'],
  });

export type ReviewInput = z.infer<typeof reviewSchema>;

export interface ReviewDeps {
  repository: ComplaintRepository;
  email: EmailSender;
  alertEmailOverride?: string | null;
  now: () => Date;
  log?: (msg: string, fields: Record<string, unknown>) => void;
}

export type ReviewResult =
  | { status: 200; body: Record<string, unknown> }
  | { status: 404; body: { success: false; error_code: 'NOT_FOUND'; error: string } };

const STATUS_MESSAGES: Record<ComplaintStatus, string> = {
  Pending: 'Your complaint is waiting to be reviewed.',
  'In Review': 'Your complaint is now being looked into by the team.',
  Resolved: 'Your complaint has been marked as resolved. If the problem is not fixed, reply to this email or call us.',
};

export async function reviewComplaint(deps: ReviewDeps, input: ReviewInput): Promise<ReviewResult> {
  const { repository } = deps;
  const log = deps.log ?? (() => {});
  const found = await repository.findByCode(input.complaint_code);
  if (!found) return { status: 404, body: { success: false, error_code: 'NOT_FOUND', error: 'No complaint with that code.' } };
  // A copy: some stores hand back the live row, and the comparisons below need the old values.
  const before: ComplaintRecord = { ...found };

  const toPriority = (input.priority ?? before.priority) as Priority;
  const toDepartment = (input.department ?? before.department_code) as DepartmentCode;
  const corrected = toPriority !== before.priority || toDepartment !== before.department_code;
  const firstReview = !(await repository.hasReview(before.id));

  // Any routing decision by staff, or an explicit confirm, is a review.
  let reviewRecorded = false;
  if (corrected || input.confirm || (firstReview && input.status)) {
    reviewRecorded = await repository.addReview({
      complaint_id: before.id,
      action: corrected ? 'corrected' : 'confirmed',
      from_priority: before.priority,
      from_department: before.department_code,
      to_priority: toPriority,
      to_department: toDepartment,
      triage_source: before.triage_source,
      first_review: firstReview,
      note: input.note ?? null,
    });
  }

  const after = await repository.updateComplaint(before.id, {
    priority: toPriority,
    department_code: toDepartment,
    ...(input.status ? { status: input.status } : {}),
    needs_review: false,
    reviewed_at: deps.now().toISOString(),
  });

  await repository
    .audit({
      complaint_id: before.id,
      action: corrected ? 'CORRECTED' : input.status && input.status !== before.status ? 'STATUS_CHANGED' : 'CONFIRMED',
      details: {
        from: { priority: before.priority, department: before.department_code, status: before.status },
        to: { priority: after.priority, department: after.department_code, status: after.status },
        first_review: firstReview,
      },
    })
    .catch(() => log('audit_failed', { complaint_code: before.complaint_code }));

  const notified: string[] = [];
  if (toDepartment !== before.department_code) {
    if (await safeSend(deps, () => alertNewDepartment(deps, after))) notified.push('department');
  }
  if (input.status && input.status !== before.status && after.email) {
    if (await safeSend(deps, () => tellPatient(deps, after, input.status!))) notified.push('patient');
  }

  return {
    status: 200,
    body: {
      success: true,
      complaint_code: after.complaint_code,
      status: after.status,
      priority: after.priority,
      department: after.department_code,
      department_name: DEPARTMENTS[after.department_code].name,
      review: reviewRecorded ? (corrected ? 'corrected' : 'confirmed') : 'none',
      first_review: reviewRecorded && firstReview,
      notified,
    },
  };
}

async function safeSend(deps: ReviewDeps, fn: () => Promise<void>): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch (err) {
    deps.log?.('review_email_failed', { reason: err instanceof Error ? err.message.slice(0, 120) : 'unknown' });
    return false;
  }
}

async function alertNewDepartment(deps: ReviewDeps, c: ComplaintRecord): Promise<void> {
  const to = deps.alertEmailOverride || (await deps.repository.departmentEmail(c.department_code));
  if (!to) throw new Error('no_department_email');
  await deps.email.send({
    to,
    subject: `Complaint ${c.complaint_code} reassigned to ${DEPARTMENTS[c.department_code].name} (${c.priority})`,
    text: `Staff reassigned complaint ${c.complaint_code} to your department.\nPriority: ${c.priority}\n\n${c.details}`,
  });
}

async function tellPatient(deps: ReviewDeps, c: ComplaintRecord, status: ComplaintStatus): Promise<void> {
  await deps.email.send({
    to: c.email!,
    subject: `Update on your MediLens complaint ${c.complaint_code}: ${status}`,
    text: [`Dear ${c.patient_name},`, '', STATUS_MESSAGES[status], '', `Complaint code: ${c.complaint_code}`, '', 'MediLens Patient Relations (demo system)'].join('\n'),
  });
}

interface SourceAccuracy {
  reviewed: number;
  both_correct: number;
  department_correct: number;
  priority_correct: number;
  accuracy: number | null;
}

/**
 * Live accuracy from first reviews: a confirmed complaint was routed right; a
 * corrected one counts per field (department and priority separately).
 */
export function triageAccuracy(reviews: ReviewedComplaint[]) {
  const empty = (): SourceAccuracy => ({ reviewed: 0, both_correct: 0, department_correct: 0, priority_correct: 0, accuracy: null });
  const by: Record<'ai' | 'keywords', SourceAccuracy> = { ai: empty(), keywords: empty() };
  for (const r of reviews) {
    const s = by[r.triage_source];
    const dept = r.from_department === r.to_department;
    const prio = r.from_priority === r.to_priority;
    s.reviewed++;
    if (dept) s.department_correct++;
    if (prio) s.priority_correct++;
    if (dept && prio) s.both_correct++;
  }
  for (const s of Object.values(by)) s.accuracy = s.reviewed ? Math.round((s.both_correct / s.reviewed) * 1000) / 1000 : null;

  const corrections = reviews.filter((r) => r.action === 'corrected');
  return {
    reviewed: reviews.length,
    by_source: by,
    recent_corrections: corrections.slice(0, 20).map((r) => ({
      complaint_code: r.complaint_code,
      triage_source: r.triage_source,
      from: `${r.from_priority} ${r.from_department}`,
      to: `${r.to_priority} ${r.to_department}`,
    })),
    /**
     * Reviewed complaints in evals/triage/dataset.json's case format, so they can
     * be scored with `npm run eval:triage:live -- <file>`. They contain real
     * patient text: keep the file out of git.
     */
    cases: reviews.map((r) => ({
      id: r.complaint_code,
      text: r.details,
      expected_priority: r.to_priority,
      expected_department: r.to_department,
    })),
  };
}

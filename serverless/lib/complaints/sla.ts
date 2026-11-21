/**
 * Deadline monitor: every hour, complaints past their department's target
 * response time (1 h for emergencies up to 72 h for billing) and not resolved
 * are escalated without anyone having to notice: the department is alerted,
 * the patient is told it has been escalated, and it is audited.
 *
 * Each complaint is claimed in the database before any email is sent, so it is
 * escalated at most once even if two sweeps overlap. The trade-off: if an email
 * fails, the sweep won't retry it; the failure is audited and logged instead.
 */
import type { ComplaintRecord, ComplaintRepository } from '../data/types.js';
import type { EmailSender } from '../notify/email.js';
import { DEPARTMENTS } from './catalog.js';

export interface SlaDeps {
  repository: ComplaintRepository;
  email: EmailSender;
  alertEmailOverride?: string | null;
  now: () => Date;
  log?: (msg: string, fields: Record<string, unknown>) => void;
}

export interface SweepReport {
  escalated: number;
  complaints: { complaint_code: string; department: string; priority: string; hours_open: number; alerted: boolean; patient_told: boolean }[];
}

export const SWEEP_BATCH = 50;

export async function slaSweep(deps: SlaDeps): Promise<SweepReport> {
  const log = deps.log ?? (() => {});
  const due = await deps.repository.claimOverdue(SWEEP_BATCH);
  const report: SweepReport = { escalated: due.length, complaints: [] };

  for (const c of due) {
    const hoursOpen = Math.floor((deps.now().getTime() - new Date(c.created_at).getTime()) / 3_600_000);
    const alerted = await attempt(deps, c, 'SLA_ALERT_FAILED', () => alertDepartment(deps, c, hoursOpen));
    const patientTold = c.email ? await attempt(deps, c, 'SLA_PATIENT_EMAIL_FAILED', () => tellPatient(deps, c)) : false;
    await deps.repository
      .audit({
        complaint_id: c.id,
        action: 'SLA_ESCALATED',
        details: { hours_open: hoursOpen, target_hours: DEPARTMENTS[c.department_code].slaHours, alerted, patient_told: patientTold },
      })
      .catch(() => log('audit_failed', { complaint_code: c.complaint_code }));
    report.complaints.push({
      complaint_code: c.complaint_code,
      department: c.department_code,
      priority: c.priority,
      hours_open: hoursOpen,
      alerted,
      patient_told: patientTold,
    });
  }
  return report;
}

async function attempt(deps: SlaDeps, c: ComplaintRecord, failureAction: string, fn: () => Promise<void>): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch (err) {
    const reason = err instanceof Error ? err.message.slice(0, 120) : 'unknown';
    deps.log?.(failureAction.toLowerCase(), { complaint_code: c.complaint_code, reason });
    await deps.repository.audit({ complaint_id: c.id, action: failureAction, details: { reason } }).catch(() => {});
    return false;
  }
}

async function alertDepartment(deps: SlaDeps, c: ComplaintRecord, hoursOpen: number): Promise<void> {
  const dept = DEPARTMENTS[c.department_code];
  const to = deps.alertEmailOverride || (await deps.repository.departmentEmail(c.department_code));
  if (!to) throw new Error('no_department_email');
  await deps.email.send({
    to,
    subject: `[OVERDUE] Complaint ${c.complaint_code} (${c.priority}) open ${hoursOpen} h, target ${dept.slaHours} h`,
    text: [
      `Complaint ${c.complaint_code} for ${dept.name} has passed its ${dept.slaHours}-hour response target and is still ${c.status}.`,
      `Priority: ${c.priority}${c.emergency ? ' · EMERGENCY' : ''}`,
      `Suggested action: ${c.suggested_action}`,
      '',
      'Please contact the patient today and update the complaint.',
    ].join('\n'),
  });
}

async function tellPatient(deps: SlaDeps, c: ComplaintRecord): Promise<void> {
  await deps.email.send({
    to: c.email!,
    subject: `Your MediLens complaint ${c.complaint_code} has been escalated`,
    text: [
      `Dear ${c.patient_name},`,
      '',
      `We're sorry we haven't resolved your complaint within our target time. It has been escalated to ${DEPARTMENTS[c.department_code].name}'s manager, who will contact you.`,
      '',
      `Complaint code: ${c.complaint_code}`,
      '',
      'MediLens Patient Relations (demo system)',
    ].join('\n'),
  });
}

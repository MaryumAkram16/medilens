/**
 * Complaint workflow, ported from n8n Complaint_Management.json and extended:
 * the AI decides priority and department (the patient's choice is only a hint),
 * code-level safety rules sit on top, and the complaint is routed to that
 * department. Every dependency is injected, so the whole flow runs in tests
 * without a network.
 */
import { createHash, randomInt } from 'node:crypto';
import type { ComplaintRecord, ComplaintRepository } from '../data/types.js';
import type { EmailSender } from '../notify/email.js';
import { DEPARTMENTS, type DepartmentCode, type Priority } from './catalog.js';
import type { Classifier } from './gemini.js';
import type { SubmitComplaintInput } from './schema.js';
import { finalizeTriage, normalize, type TriageResult } from './triage.js';

export interface ComplaintServiceDeps {
  repository: ComplaintRepository;
  email: EmailSender;
  /** Null when no AI key is configured: keyword rules triage every complaint. */
  classifier: Classifier | null;
  /** Demo setting: send every department alert here instead of the department's address. */
  alertEmailOverride?: string | null;
  newCode?: () => string;
  log?: (msg: string, fields: Record<string, unknown>) => void;
}

export type SubmitResult =
  | {
      status: 201;
      body: {
        success: true;
        message: string;
        complaint_code: string;
        priority: Priority;
        department: DepartmentCode;
        department_name: string;
        expected_response_hours: number;
        needs_review: boolean;
        emergency: boolean;
        emergency_notice: string | null;
        /** The same answer phrased to be read aloud (voice agent, text-to-speech). */
        spoken_message: string;
      };
    }
  | { status: 409; body: { success: false; error_code: 'DUPLICATE_COMPLAINT'; error: string } };

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I, easier to read aloud

export function newComplaintCode(): string {
  let s = 'CMP-';
  for (let i = 0; i < 6; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return s;
}

export function detailsHash(details: string): string {
  return createHash('sha256').update(normalize(details)).digest('hex');
}

/** Spells a code for speech: "C M P, 4 7 K 2 9 X". */
export function spellCode(code: string): string {
  return code
    .split('-')
    .map((part) => part.split('').join(' '))
    .join(', ');
}

export class ComplaintService {
  private readonly newCode: () => string;
  private readonly log: (msg: string, fields: Record<string, unknown>) => void;

  constructor(private readonly deps: ComplaintServiceDeps) {
    this.newCode = deps.newCode ?? newComplaintCode;
    this.log = deps.log ?? (() => {});
  }

  async triage(details: string): Promise<TriageResult> {
    const ai = this.deps.classifier ? await this.deps.classifier(details) : null;
    return finalizeTriage(details, ai);
  }

  async submit(input: SubmitComplaintInput): Promise<SubmitResult> {
    const { repository } = this.deps;
    const hash = detailsHash(input.details);

    // Checked before the AI call so a resubmission costs no AI quota.
    if (await repository.isDuplicate(input.email, hash)) return duplicate();

    const triage = await this.triage(input.details);
    const inserted = await repository.insert({
      complaint_code: this.newCode(),
      patient_name: input.name,
      email: input.email,
      phone: input.phone,
      details: input.details,
      details_hash: hash,
      channel: input.channel,
      category_hint: input.type ?? null,
      priority_hint: input.priority ?? null,
      priority: triage.priority,
      department_code: triage.department,
      category: triage.category,
      sentiment: triage.sentiment,
      suggested_action: triage.suggested_action,
      confidence: Math.round(triage.confidence * 100) / 100,
      triage_source: triage.source,
      emergency: triage.emergency,
      needs_review: triage.needs_review,
    });
    // Two identical submissions racing: the database constraint decides.
    if (!inserted.ok) return duplicate();
    const record = inserted.record;

    // Audit and notifications never fail the request: the complaint is already saved.
    await this.safe('audit_failed', record, () =>
      repository.audit({
        complaint_id: record.id,
        action: 'CREATED',
        details: {
          channel: record.channel,
          priority: record.priority,
          department: record.department_code,
          triage_source: triage.source,
          confidence: record.confidence,
          emergency: triage.emergency,
          needs_review: triage.needs_review,
          review_reason: triage.review_reason,
          // Patient's own choice vs the triage, so disagreements can be reviewed.
          priority_hint: record.priority_hint,
          hint_overridden: record.priority_hint !== null && record.priority_hint !== record.priority,
        },
      }),
    );
    await this.safe('department_alert_failed', record, () => this.alertDepartment(record, triage));
    await this.safe('patient_email_failed', record, () => this.confirmToPatient(record, triage));

    const dept = DEPARTMENTS[record.department_code];
    const message = `Your complaint has been submitted. Your complaint code is ${record.complaint_code}`;
    const spoken = [
      triage.emergency_notice,
      `Your complaint has been submitted and sent to ${dept.name}.`,
      `Your complaint code is ${spellCode(record.complaint_code)}.`,
      `They aim to respond within ${dept.slaHours} ${dept.slaHours === 1 ? 'hour' : 'hours'}.`,
    ]
      .filter(Boolean)
      .join(' ');

    return {
      status: 201,
      body: {
        success: true,
        message,
        complaint_code: record.complaint_code,
        priority: record.priority,
        department: record.department_code,
        department_name: dept.name,
        expected_response_hours: dept.slaHours,
        needs_review: record.needs_review,
        emergency: record.emergency,
        emergency_notice: triage.emergency_notice,
        spoken_message: spoken,
      },
    };
  }

  private async alertDepartment(record: ComplaintRecord, triage: TriageResult): Promise<void> {
    const to = this.deps.alertEmailOverride || (await this.deps.repository.departmentEmail(record.department_code));
    if (!to) throw new Error('no_department_email');
    const tag = record.emergency ? '[EMERGENCY] ' : record.priority === 'High' ? '[HIGH] ' : '';
    await this.deps.email.send({
      to,
      subject: `${tag}New ${record.priority} complaint ${record.complaint_code} for ${DEPARTMENTS[record.department_code].name}`,
      text: [
        `Complaint ${record.complaint_code} (${record.channel})`,
        `Priority: ${record.priority}${record.priority_hint ? ` (patient chose ${record.priority_hint})` : ''}`,
        `Category: ${record.category} · Sentiment: ${record.sentiment}`,
        `Triage: ${triage.source}, confidence ${record.confidence.toFixed(2)}`,
        triage.review_reason ? `Needs review: ${triage.review_reason}` : null,
        '',
        `Suggested action: ${record.suggested_action}`,
        '',
        `Patient: ${record.patient_name} · ${record.email} · ${record.phone}`,
        '',
        record.details,
      ]
        .filter((l) => l !== null)
        .join('\n'),
    });
  }

  private async confirmToPatient(record: ComplaintRecord, triage: TriageResult): Promise<void> {
    const dept = DEPARTMENTS[record.department_code];
    await this.deps.email.send({
      to: record.email,
      subject: `Your MediLens complaint ${record.complaint_code}`,
      text: [
        `Dear ${record.patient_name},`,
        '',
        triage.emergency_notice,
        triage.emergency_notice ? '' : null,
        `We have received your complaint. Your complaint code is ${record.complaint_code}.`,
        `It has been sent to ${dept.name}, who aim to respond within ${dept.slaHours} ${dept.slaHours === 1 ? 'hour' : 'hours'}.`,
        'Keep this code to check the status of your complaint.',
        '',
        'MediLens Patient Relations',
        '(Demo system: please do not send real medical information.)',
      ]
        .filter((l) => l !== null)
        .join('\n'),
    });
  }

  private async safe(action: string, record: ComplaintRecord, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      const reason = err instanceof Error ? err.message.slice(0, 120) : 'unknown';
      this.log(action, { complaint_code: record.complaint_code, reason });
      if (action !== 'audit_failed') {
        await this.deps.repository
          .audit({ complaint_id: record.id, action: action.toUpperCase(), details: { reason } })
          .catch(() => this.log('audit_failed', { complaint_code: record.complaint_code }));
      }
    }
  }

  /** Status lookup: needs the code plus the email or phone it was filed with. */
  async status(code: string, contact: { email?: string | undefined; phone?: string | undefined }) {
    const record = await this.deps.repository.findByCode(code);
    const digits = (s: string) => s.replace(/\D/g, '');
    const matches =
      record !== null &&
      ((contact.email !== undefined && contact.email === record.email.trim().toLowerCase()) ||
        (contact.phone !== undefined && digits(contact.phone).length >= 7 && digits(contact.phone) === digits(record.phone)));
    // Same answer for "no such code" and "wrong contact", so codes can't be probed.
    if (!record || !matches) return { found: false as const };
    const dept = DEPARTMENTS[record.department_code];
    return {
      found: true as const,
      complaint_code: record.complaint_code,
      status: record.status,
      priority: record.priority,
      department_name: dept.name,
      submitted_at: record.created_at,
      spoken_message: `Complaint ${spellCode(record.complaint_code)} is ${record.status.toLowerCase()} with ${dept.name}.`,
    };
  }
}

/** A pending complaint older than this is escalated when the patient calls about it (n8n rule). */
export const ESCALATE_AFTER_HOURS = 48;

export interface VoiceStatusResult {
  success: boolean;
  message: string;
  complaint_code?: string;
  status?: string;
  department_name?: string;
  escalated?: boolean;
}

export async function voiceComplaintStatus(
  service: ComplaintService,
  deps: { repository: ComplaintRepository; email: EmailSender; alertEmailOverride?: string | null; now: () => Date },
  code: string,
  contact: { email?: string | undefined; phone?: string | undefined },
): Promise<VoiceStatusResult> {
  const result = await service.status(code, contact);
  if (!result.found) {
    return { success: false, message: "I couldn't find a complaint with that code and contact detail. Could you read me the complaint code again?" };
  }
  const ageHours = (deps.now().getTime() - new Date(result.submitted_at).getTime()) / 3_600_000;
  const base = { success: true, complaint_code: result.complaint_code, status: result.status, department_name: result.department_name };
  if (result.status !== 'Pending' || ageHours <= ESCALATE_AFTER_HOURS) {
    return { ...base, escalated: false, message: result.spoken_message };
  }

  const record = await deps.repository.findByCode(result.complaint_code);
  try {
    const to = deps.alertEmailOverride || (await deps.repository.departmentEmail('patient_relations'));
    if (to) {
      await deps.email.send({
        to,
        subject: `[ESCALATED] Complaint ${result.complaint_code} pending for ${Math.floor(ageHours)} hours`,
        text: `The patient called about complaint ${result.complaint_code} (${result.department_name}). It has been pending for ${Math.floor(ageHours)} hours, over the ${ESCALATE_AFTER_HOURS}-hour target. Please follow up today.`,
      });
    }
    if (record) await deps.repository.audit({ complaint_id: record.id, action: 'ESCALATED', details: { age_hours: Math.floor(ageHours), via: 'voice' } });
  } catch {
    // The caller still gets an answer; the failed escalation shows up in the logs.
  }
  return {
    ...base,
    escalated: true,
    message: `Your complaint ${spellCode(result.complaint_code)} has been pending longer than expected. I have escalated it to our patient relations team, and someone will contact you today.`,
  };
}

function duplicate(): SubmitResult {
  return {
    status: 409,
    body: { success: false, error_code: 'DUPLICATE_COMPLAINT', error: 'You have already filed this complaint before.' },
  };
}

/** Same shape as the n8n "Compute Complaints Summary" node, plus review and emergency counts. */
export function summarize(complaints: ComplaintRecord[], now: Date = new Date()) {
  const countBy = <K extends keyof ComplaintRecord>(key: K, value: ComplaintRecord[K]) =>
    complaints.filter((c) => c[key] === value).length;
  const groupBy = (key: 'category' | 'department_code') =>
    complaints.reduce<Record<string, number>>((acc, c) => {
      acc[c[key]] = (acc[c[key]] ?? 0) + 1;
      return acc;
    }, {});
  return {
    summary: {
      total: complaints.length,
      pending: countBy('status', 'Pending'),
      resolved: countBy('status', 'Resolved'),
      lowPriority: countBy('priority', 'Low'),
      mediumPriority: countBy('priority', 'Medium'),
      highPriority: countBy('priority', 'High'),
      needsReview: countBy('needs_review', true),
      emergency: countBy('emergency', true),
      byCategory: groupBy('category'),
      byDepartment: groupBy('department_code'),
    },
    data: complaints,
    timestamp: now.toISOString(),
    recordCount: complaints.length,
  };
}

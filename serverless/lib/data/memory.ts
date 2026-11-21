/**
 * In-memory repository with synthetic department contacts. Used for local
 * development, tests, and DATA_SOURCE=demo. Data lives only as long as the
 * process (one warm serverless instance).
 */
import { DEPARTMENTS, type DepartmentCode } from '../complaints/catalog.js';
import {
  contactKey,
  type AuditEntry,
  type ComplaintPatch,
  type ComplaintRecord,
  type ComplaintRepository,
  type InsertResult,
  type NewComplaint,
  type NewReview,
  type ReviewRecord,
  type ReviewedComplaint,
} from './types.js';

export class MemoryRepository implements ComplaintRepository {
  readonly complaints: ComplaintRecord[] = [];
  readonly auditLog: AuditEntry[] = [];
  readonly reviews: ReviewRecord[] = [];
  /** Complaint ids already escalated by the deadline monitor. */
  readonly escalated = new Set<number>();
  private nextId = 1;

  constructor(private readonly now: () => Date = () => new Date()) {}

  async isDuplicate(key: string, detailsHash: string): Promise<boolean> {
    return this.complaints.some((c) => contactKey(c.email, c.phone) === key && c.details_hash === detailsHash);
  }

  async insert(complaint: NewComplaint): Promise<InsertResult> {
    if (await this.isDuplicate(contactKey(complaint.email, complaint.phone), complaint.details_hash)) return { ok: false, reason: 'duplicate' };
    const record: ComplaintRecord = {
      ...complaint,
      id: this.nextId++,
      status: 'Pending',
      created_at: this.now().toISOString(),
    };
    this.complaints.push(record);
    return { ok: true, record };
  }

  async findByCode(code: string): Promise<ComplaintRecord | null> {
    return this.complaints.find((c) => c.complaint_code === code) ?? null;
  }

  async list(limit: number): Promise<ComplaintRecord[]> {
    return [...this.complaints].reverse().slice(0, limit);
  }

  async departmentEmail(code: DepartmentCode): Promise<string | null> {
    return code in DEPARTMENTS ? `${code.replace('_', '-')}@medilens.test` : null;
  }

  async audit(entry: AuditEntry): Promise<void> {
    this.auditLog.push(entry);
  }

  async updateComplaint(id: number, patch: ComplaintPatch): Promise<ComplaintRecord> {
    const row = this.complaints.find((c) => c.id === id);
    if (!row) throw new Error('complaint_not_found');
    const { reviewed_at: _r, ...fields } = patch;
    Object.assign(row, fields);
    return row;
  }

  async hasReview(complaintId: number): Promise<boolean> {
    return this.reviews.some((r) => r.complaint_id === complaintId);
  }

  async addReview(review: NewReview): Promise<boolean> {
    if (review.first_review && this.reviews.some((r) => r.complaint_id === review.complaint_id && r.first_review)) return false;
    this.reviews.push({ ...review, created_at: this.now().toISOString() });
    return true;
  }

  async claimOverdue(limit: number): Promise<ComplaintRecord[]> {
    const now = this.now().getTime();
    const due = this.complaints
      .filter(
        (c) =>
          c.status !== 'Resolved' &&
          !this.escalated.has(c.id) &&
          new Date(c.created_at).getTime() + DEPARTMENTS[c.department_code].slaHours * 3_600_000 < now,
      )
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .slice(0, Math.max(1, Math.min(limit, 200)));
    for (const c of due) this.escalated.add(c.id);
    return due;
  }

  async firstReviews(limit: number): Promise<ReviewedComplaint[]> {
    return this.reviews
      .filter((r) => r.first_review)
      .reverse()
      .slice(0, limit)
      .map((r) => {
        const c = this.complaints.find((x) => x.id === r.complaint_id)!;
        return { ...r, complaint_code: c.complaint_code, details: c.details };
      });
  }
}

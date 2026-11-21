import type { DepartmentCode, Priority, Sentiment } from '../complaints/catalog.js';

export type ComplaintStatus = 'Pending' | 'In Review' | 'Resolved';

/** A row of public.complaints (db/001_complaints.sql). */
export interface ComplaintRecord {
  id: number;
  complaint_code: string;
  patient_name: string;
  /** Optional for voice complaints. */
  email: string | null;
  phone: string;
  details: string;
  details_hash: string;
  channel: 'web' | 'voice';
  /** Retell call that filed it, for voice complaints. */
  call_id: string | null;
  category_hint: string | null;
  priority_hint: Priority | null;
  priority: Priority;
  department_code: DepartmentCode;
  category: string;
  sentiment: Sentiment;
  suggested_action: string;
  confidence: number;
  triage_source: 'ai' | 'keywords';
  emergency: boolean;
  needs_review: boolean;
  status: ComplaintStatus;
  created_at: string;
}

export type NewComplaint = Omit<ComplaintRecord, 'id' | 'status' | 'created_at'>;

export interface AuditEntry {
  complaint_id: number | null;
  action: string;
  details: Record<string, unknown>;
}

/** A staff review (db/004 complaint_reviews). */
export interface ReviewRecord {
  complaint_id: number;
  action: 'confirmed' | 'corrected';
  from_priority: Priority;
  from_department: DepartmentCode;
  to_priority: Priority;
  to_department: DepartmentCode;
  triage_source: 'ai' | 'keywords';
  first_review: boolean;
  note: string | null;
  created_at: string;
}

export type NewReview = Omit<ReviewRecord, 'created_at'>;

/** A first review with the complaint it belongs to, for accuracy and the case export. */
export interface ReviewedComplaint extends ReviewRecord {
  complaint_code: string;
  details: string;
}

export type ComplaintPatch = Partial<Pick<ComplaintRecord, 'priority' | 'department_code' | 'status' | 'needs_review'>> & {
  reviewed_at?: string;
};

export type InsertResult = { ok: true; record: ComplaintRecord } | { ok: false; reason: 'duplicate' };

export interface ComplaintRepository {
  /** True when this contact (email, or phone without one) already filed the same normalised text. */
  isDuplicate(contactKey: string, detailsHash: string): Promise<boolean>;
  /** Inserts; the database's unique constraint is the final word on duplicates. */
  insert(complaint: NewComplaint): Promise<InsertResult>;
  findByCode(code: string): Promise<ComplaintRecord | null>;
  list(limit: number): Promise<ComplaintRecord[]>;
  departmentEmail(code: DepartmentCode): Promise<string | null>;
  audit(entry: AuditEntry): Promise<void>;
  /** Staff review (db/004). */
  updateComplaint(id: number, patch: ComplaintPatch): Promise<ComplaintRecord>;
  hasReview(complaintId: number): Promise<boolean>;
  /** Returns false if a first review already exists (two staff saving at once). */
  addReview(review: NewReview): Promise<boolean>;
  firstReviews(limit: number): Promise<ReviewedComplaint[]>;
  /**
   * Deadline monitor (db/005): marks unresolved complaints past their
   * department's target time as escalated and returns them. Each complaint is
   * returned once, ever, even if two sweeps run at the same time.
   */
  claimOverdue(limit: number): Promise<ComplaintRecord[]>;
}

/** Who filed it, for duplicate detection: the email, or the phone's last 10 digits. Mirrors db/003. */
export function contactKey(email: string | null, phone: string): string {
  return email?.trim() ? email.trim().toLowerCase() : phone.replace(/\D/g, '').slice(-10);
}

/** The data store could not be reached or answered with an error. */
export class DataSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DataSourceError';
  }
}

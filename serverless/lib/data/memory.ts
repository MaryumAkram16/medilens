/**
 * In-memory repository with synthetic department contacts. Used for local
 * development, tests, and DATA_SOURCE=demo. Data lives only as long as the
 * process (one warm serverless instance).
 */
import { DEPARTMENTS, type DepartmentCode } from '../complaints/catalog.js';
import { contactKey, type AuditEntry, type ComplaintRecord, type ComplaintRepository, type InsertResult, type NewComplaint } from './types.js';

export class MemoryRepository implements ComplaintRepository {
  readonly complaints: ComplaintRecord[] = [];
  readonly auditLog: AuditEntry[] = [];
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
}

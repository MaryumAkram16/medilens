/**
 * Runs db/001 against a real Postgres. Needs TEST_DATABASE_URL (CI starts a
 * Postgres 16 service); skipped otherwise. Uses its own database, never Supabase.
 */
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEPARTMENTS } from '../lib/complaints/catalog.js';

const url = process.env.TEST_DATABASE_URL;
const sql = (name: string) => readFileSync(new URL(`../db/${name}`, import.meta.url), 'utf8');

const row = (over: Record<string, unknown> = {}) => ({
  complaint_code: 'CMP-TEST01',
  patient_name: 'Test Patient',
  email: 'patient@example.test',
  phone: '+923001234567',
  details: 'Charged twice',
  details_hash: 'hash-1',
  priority: 'Medium',
  department_code: 'billing',
  category: 'Duplicate charge',
  sentiment: 'Negative',
  suggested_action: 'Refund',
  confidence: 0.9,
  triage_source: 'ai',
  ...over,
});

describe.skipIf(!url)('db/001_complaints.sql', () => {
  let db: pg.Client;

  const insert = (r: Record<string, unknown>) => {
    const keys = Object.keys(r);
    return db.query(
      `insert into public.complaints (${keys.join(',')}) values (${keys.map((_, i) => `$${i + 1}`).join(',')}) returning *`,
      Object.values(r),
    );
  };
  const failCode = async (p: Promise<unknown>) => {
    try {
      await p;
      return 'no error';
    } catch (err) {
      return `${(err as { code?: string }).code} ${(err as { constraint?: string }).constraint ?? ''}`.trim();
    }
  };

  beforeAll(async () => {
    db = new pg.Client({ connectionString: url });
    await db.connect();
    await db.query(sql('001_rollback.sql'));
    await db.query(sql('001_complaints.sql'));
  });

  afterAll(async () => {
    await db?.query(sql('001_rollback.sql'));
    await db?.end();
  });

  it('can be applied twice', async () => {
    await expect(db.query(sql('001_complaints.sql'))).resolves.toBeDefined();
  });

  it('seeds exactly the departments the code knows', async () => {
    const { rows } = await db.query('select code, name, sla_hours from public.departments order by code');
    expect(rows).toEqual(
      Object.entries(DEPARTMENTS)
        .map(([code, d]) => ({ code, name: d.name, sla_hours: d.slaHours }))
        .sort((a, b) => a.code.localeCompare(b.code)),
    );
  });

  it('stores a complaint with defaults', async () => {
    const { rows } = await insert(row());
    expect(rows[0]).toMatchObject({ status: 'Pending', channel: 'web', emergency: false, needs_review: false, email_norm: 'patient@example.test' });
  });

  it('rejects the same text from the same email, ignoring email case', async () => {
    expect(await failCode(insert(row({ complaint_code: 'CMP-TEST02', email: ' PATIENT@Example.test ' })))).toBe('23505 complaints_no_duplicate');
    await expect(insert(row({ complaint_code: 'CMP-TEST03', email: 'other@example.test' }))).resolves.toBeDefined();
  });

  it('rejects duplicate codes, unknown departments and values outside the allowed lists', async () => {
    expect(await failCode(insert(row({ details_hash: 'h2' })))).toBe('23505 complaints_complaint_code_key');
    expect(await failCode(insert(row({ complaint_code: 'CMP-TEST04', details_hash: 'h3', department_code: 'finance' })))).toMatch(/^23503/);
    for (const [field, value] of [
      ['priority', 'Urgent'],
      ['sentiment', 'Angry'],
      ['status', 'Closed'],
      ['channel', 'fax'],
      ['triage_source', 'guess'],
      ['confidence', 1.5],
    ] as const) {
      expect(await failCode(insert(row({ complaint_code: 'CMP-TEST05', details_hash: `h-${field}`, [field]: value })))).toMatch(/^23514/);
    }
  });

  it('turns on row-level security for every table', async () => {
    const { rows } = await db.query(
      `select relname, relrowsecurity from pg_class where relname in ('departments','complaints','complaint_audit') order by relname`,
    );
    expect(rows.every((r) => r.relrowsecurity === true)).toBe(true);
    expect(rows).toHaveLength(3);
  });

  it('keeps audit rows when a complaint is deleted', async () => {
    const { rows } = await insert(row({ complaint_code: 'CMP-TEST06', details_hash: 'h-audit' }));
    await db.query(`insert into public.complaint_audit (complaint_id, action) values ($1, 'CREATED')`, [rows[0].id]);
    await db.query('delete from public.complaints where id = $1', [rows[0].id]);
    const audit = await db.query(`select complaint_id from public.complaint_audit where action = 'CREATED'`);
    expect(audit.rows).toEqual([{ complaint_id: null }]);
  });
});

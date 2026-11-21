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
    // Start clean even if an earlier run stopped half-way (later migrations' tables first).
    await db.query('drop function if exists public.claim_overdue_complaints(int)');
    await db.query('drop table if exists public.complaint_reviews');
    await db.query('drop table if exists public.call_actions');
    await db.query(sql('002_rollback.sql'));
    await db.query(sql('001_rollback.sql'));
    await db.query(sql('001_complaints.sql'));
  });

  afterAll(async () => {
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

// Same database as above, so these run after it in this file (never in parallel).
describe.skipIf(!url)('db/002_appointments.sql', () => {
  let db: pg.Client;
  const PHONE = '+92 300 1234567';

  const p0001 = async (q: Promise<unknown>) => {
    try {
      await q;
      return 'no error';
    } catch (err) {
      return (err as { message: string }).message;
    }
  };
  // A slot far enough ahead to be in the future whatever the clock says.
  const futureSlot = async (doctor = 'Dr. Sara Malik', start = '10:00') => {
    const { rows } = await db.query(
      `insert into doctor_slots (doctor_id, slot_date, start_time, end_time)
       select id, (now() at time zone 'Asia/Karachi')::date + 30, $2::time, $2::time + interval '30 minutes' from doctors where name = $1
       on conflict (doctor_id, slot_date, start_time) do update set blocked = false returning id`,
      [doctor, start],
    );
    return Number(rows[0].id);
  };
  const book = (client: pg.Client, slot: number, code: string, phone = PHONE, callId: string | null = null) =>
    client.query('select * from book_appointment($1, $2, $3, $4, $5, $6)', [slot, 'Test Patient', phone, 'p@example.test', code, callId]);

  beforeAll(async () => {
    db = new pg.Client({ connectionString: url });
    await db.connect();
    await db.query(sql('002_appointments.sql'));
  });

  afterAll(async () => {
    await db?.end();
  });

  it('applies twice, seeds the doctors and keeps demo slots topped up idempotently', async () => {
    await db.query(sql('002_appointments.sql'));
    expect((await db.query('select count(*)::int as n from doctors')).rows[0].n).toBe(7);
    expect((await db.query('select ensure_demo_slots(14) as added')).rows[0].added).toBe(0);
    const sundays = await db.query(`select count(*)::int as n from doctor_slots where extract(isodow from slot_date) = 7`);
    expect(sundays.rows[0].n).toBe(0);
  });

  it('lists only future, unblocked, unbooked slots of the specialty', async () => {
    const slot = await futureSlot('Dr. Sara Malik', '11:00');
    const before = (await db.query(`select slot_id from available_slots('cardiology', ((now() at time zone 'Asia/Karachi')::date + 30), 50)`)).rows.map((r) => Number(r.slot_id));
    expect(before).toContain(slot);
    await book(db, slot, 'APT-LIST01');
    const after = (await db.query(`select slot_id from available_slots('cardiology', ((now() at time zone 'Asia/Karachi')::date + 30), 50)`)).rows.map((r) => Number(r.slot_id));
    expect(after).not.toContain(slot);
    const others = await db.query(`select distinct specialty_code from available_slots('dermatology', null, 50)`);
    expect(others.rows.map((r) => r.specialty_code)).toEqual(['dermatology']);
  });

  it('lets exactly one of two simultaneous bookings of a slot win', async () => {
    const slot = await futureSlot('Dr. Sara Malik', '12:00');
    const a = new pg.Client({ connectionString: url });
    const b = new pg.Client({ connectionString: url });
    await Promise.all([a.connect(), b.connect()]);
    try {
      const results = await Promise.allSettled([book(a, slot, 'APT-RACE01', PHONE), book(b, slot, 'APT-RACE02', '0311 7654321')]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect(lost.reason.message).toBe('slot_unavailable');
      const booked = await db.query(`select count(*)::int as n from appointments where slot_id = $1 and status = 'Booked'`, [slot]);
      expect(booked.rows[0].n).toBe(1);
    } finally {
      await Promise.all([a.end(), b.end()]);
    }
  });

  it('refuses past and blocked slots', async () => {
    const { rows } = await db.query(
      `insert into doctor_slots (doctor_id, slot_date, start_time, end_time)
       select id, (now() at time zone 'Asia/Karachi')::date - 1, '10:00', '10:30' from doctors where name = 'Dr. Usman Raza' returning id`,
    );
    expect(await p0001(book(db, Number(rows[0].id), 'APT-PAST01'))).toBe('slot_unavailable');
    const blocked = await futureSlot('Dr. Usman Raza', '09:00');
    await db.query('update doctor_slots set blocked = true where id = $1', [blocked]);
    expect(await p0001(book(db, blocked, 'APT-BLKD01'))).toBe('slot_unavailable');
  });

  it('returns the original booking when the same call retries', async () => {
    const slot = await futureSlot('Dr. Hina Qureshi', '10:00');
    const first = await book(db, slot, 'APT-RTRY01', PHONE, 'call_42');
    const again = await book(db, slot, 'APT-RTRY02', PHONE, 'call_42');
    expect(again.rows[0].appointment_code).toBe(first.rows[0].appointment_code);
  });

  it('needs the matching phone (in any format) to find or cancel', async () => {
    const slot = await futureSlot('Dr. Omar Siddiqui', '10:00');
    await book(db, slot, 'APT-OWNR01');
    expect((await db.query(`select * from find_appointment('APT-OWNR01', '0311 7654321')`)).rows).toEqual([]);
    expect((await db.query(`select * from find_appointment('APT-OWNR01', '03001234567')`)).rows[0]).toMatchObject({ doctor_name: 'Dr. Omar Siddiqui', status: 'Booked' });
    expect(await p0001(db.query(`select * from cancel_appointment('APT-OWNR01', '0311 7654321')`))).toBe('not_found');
  });

  it('cancel frees the slot for the next patient and cannot run twice', async () => {
    const slot = await futureSlot('Dr. Fatima Javed', '10:00');
    await book(db, slot, 'APT-CNCL01');
    const { rows } = await db.query(`select * from cancel_appointment('APT-CNCL01', $1)`, [PHONE]);
    expect(rows[0]).toMatchObject({ status: 'Cancelled' });
    expect(rows[0].cancelled_at).not.toBeNull();
    await expect(book(db, slot, 'APT-CNCL02', '0311 7654321')).resolves.toBeDefined();
    expect(await p0001(db.query(`select * from cancel_appointment('APT-CNCL01', $1)`, [PHONE]))).toBe('not_booked');
  });

  it('reschedule moves the booking, releases the old slot, and stays in the specialty', async () => {
    const oldSlot = await futureSlot('Dr. Ayesha Khan', '10:00');
    const newSlot = await futureSlot('Dr. Bilal Ahmed', '11:00');
    await book(db, oldSlot, 'APT-MOVE01');
    const { rows } = await db.query(`select * from reschedule_appointment('APT-MOVE01', $1, $2)`, [PHONE, newSlot]);
    expect(Number(rows[0].slot_id)).toBe(newSlot);
    await expect(book(db, oldSlot, 'APT-MOVE02', '0311 7654321')).resolves.toBeDefined();

    const otherSpecialty = await futureSlot('Dr. Sara Malik', '09:30');
    expect(await p0001(db.query(`select * from reschedule_appointment('APT-MOVE01', $1, $2)`, [PHONE, otherSpecialty]))).toBe('different_specialty');
    expect(await p0001(db.query(`select * from reschedule_appointment('APT-MOVE01', $1, $2)`, [PHONE, oldSlot]))).toBe('slot_unavailable');
  });

  it('turns on row-level security for every table', async () => {
    const { rows } = await db.query(
      `select relrowsecurity from pg_class where relname in ('specialties','doctors','doctor_slots','appointments')`,
    );
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.relrowsecurity)).toBe(true);
  });
});

// Runs last in this file and tears everything down.
describe.skipIf(!url)('db/003_voice.sql', () => {
  let db: pg.Client;
  const complaint = (over: Record<string, unknown>) => {
    const r = {
      complaint_code: 'CMP-VOICE1',
      patient_name: 'Test Patient',
      email: null,
      phone: '+92 300 1234567',
      details: 'Charged twice',
      details_hash: 'voice-hash',
      priority: 'Medium',
      department_code: 'billing',
      category: 'Duplicate charge',
      sentiment: 'Negative',
      suggested_action: 'Refund',
      confidence: 0.9,
      triage_source: 'ai',
      channel: 'voice',
      call_id: 'call_1',
      ...over,
    };
    const keys = Object.keys(r);
    return db.query(
      `insert into public.complaints (${keys.join(',')}) values (${keys.map((_, i) => `$${i + 1}`).join(',')}) returning *`,
      Object.values(r),
    );
  };
  const failCode = async (q: Promise<unknown>) => {
    try {
      await q;
      return 'no error';
    } catch (err) {
      return `${(err as { code?: string }).code} ${(err as { constraint?: string }).constraint ?? ''}`.trim();
    }
  };
  const clearComplaints = () => db.query('truncate public.complaint_audit, public.complaints cascade');

  beforeAll(async () => {
    db = new pg.Client({ connectionString: url });
    await db.connect();
    await db.query(sql('005_rollback.sql'));
    await db.query(sql('004_rollback.sql'));
    await clearComplaints();
    await db.query(sql('003_voice.sql'));
    await db.query(sql('004_reviews.sql'));
    await db.query(sql('005_sla.sql'));
  });

  afterAll(async () => {
    if (db) {
      await clearComplaints();
      await db.query(sql('005_rollback.sql'));
      await db.query(sql('004_rollback.sql'));
      await db.query(sql('003_rollback.sql'));
      await db.query(sql('002_rollback.sql'));
      await db.query(sql('001_rollback.sql'));
      await db.end();
    }
  });

  it('applies twice', async () => {
    await expect(db.query(sql('003_voice.sql'))).resolves.toBeDefined();
  });

  it('accepts a voice complaint without an email and keys duplicates on the phone', async () => {
    const { rows } = await complaint({});
    expect(rows[0]).toMatchObject({ email: null, contact_key: '3001234567', call_id: 'call_1' });
    expect(await failCode(complaint({ complaint_code: 'CMP-VOICE2', phone: '03001234567' }))).toBe('23505 complaints_no_duplicate_contact');
  });

  it('still keys web complaints on the email, ignoring case', async () => {
    await complaint({ complaint_code: 'CMP-WEB001', email: 'patient@example.test', details_hash: 'web-hash', channel: 'web', call_id: null });
    expect(
      await failCode(complaint({ complaint_code: 'CMP-WEB002', email: ' PATIENT@example.test', phone: '0399 0000000', details_hash: 'web-hash' })),
    ).toBe('23505 complaints_no_duplicate_contact');
  });

  it('allows one summary per call, and only known actions', async () => {
    await db.query(`insert into public.call_actions (call_id, action, reference) values ('call_1', 'booked', 'APT-ABC234')`);
    await db.query(`insert into public.call_actions (call_id, action, reference) values ('call_1', 'summary_sent', 'call_1')`);
    expect(await failCode(db.query(`insert into public.call_actions (call_id, action, reference) values ('call_1', 'summary_sent', 'call_1')`))).toMatch(/^23505/);
    expect(await failCode(db.query(`insert into public.call_actions (call_id, action, reference) values ('call_1', 'deleted', 'x')`))).toMatch(/^23514/);
    const rls = await db.query(`select relrowsecurity from pg_class where relname = 'call_actions'`);
    expect(rls.rows[0].relrowsecurity).toBe(true);
  });

  it('004: keeps exactly one first review per complaint, with valid labels', async () => {
    const { rows } = await complaint({ complaint_code: 'CMP-REVW01', details_hash: 'review-hash', phone: '0311 1111111' });
    const id = rows[0].id;
    const review = (first: boolean, to = 'billing') =>
      db.query(
        `insert into public.complaint_reviews (complaint_id, action, from_priority, from_department, to_priority, to_department, triage_source, first_review)
         values ($1, 'confirmed', 'Medium', 'billing', 'Medium', $2, 'ai', $3)`,
        [id, to, first],
      );
    await review(true);
    expect(await failCode(review(true))).toBe('23505 complaint_reviews_one_first');
    await expect(review(false)).resolves.toBeDefined();
    expect(await failCode(review(false, 'finance'))).toMatch(/^23503/);
    const rls = await db.query(`select relrowsecurity from pg_class where relname = 'complaint_reviews'`);
    expect(rls.rows[0].relrowsecurity).toBe(true);
    await db.query('delete from public.complaints where id = $1', [id]);
    expect((await db.query('select count(*)::int as n from public.complaint_reviews where complaint_id = $1', [id])).rows[0].n).toBe(0);
  });

  it('005: claims overdue unresolved complaints once, even with two sweeps at the same moment', async () => {
    await clearComplaints();
    const old = (code: string, hoursAgo: number, dept: string, status = 'Pending') =>
      complaint({ complaint_code: code, details_hash: `sla-${code}`, phone: `0300 ${code.slice(-6).replace(/\D/g, '9').padEnd(7, '1')}`, department_code: dept, status }).then(({ rows }) =>
        db.query(`update public.complaints set created_at = now() - make_interval(hours => $2) where id = $1`, [rows[0].id, hoursAgo]),
      );
    await old('CMP-SLA001', 30, 'nursing'); // 24 h target: overdue
    await old('CMP-SLA002', 30, 'billing'); // 72 h target: not yet
    await old('CMP-SLA003', 2, 'emergency'); // 1 h target: overdue
    await old('CMP-SLA004', 100, 'facilities', 'Resolved'); // resolved: never
    for (let i = 0; i < 6; i++) await old(`CMP-SLAB0${i}`, 50, 'clinical_care'); // 24 h target: overdue

    const a = new pg.Client({ connectionString: url });
    const b = new pg.Client({ connectionString: url });
    await Promise.all([a.connect(), b.connect()]);
    try {
      const [ra, rb] = await Promise.all([
        a.query('select complaint_code from claim_overdue_complaints(50)'),
        b.query('select complaint_code from claim_overdue_complaints(50)'),
      ]);
      const codes = [...ra.rows, ...rb.rows].map((r) => r.complaint_code).sort();
      expect(codes).toEqual(['CMP-SLA001', 'CMP-SLA003', 'CMP-SLAB00', 'CMP-SLAB01', 'CMP-SLAB02', 'CMP-SLAB03', 'CMP-SLAB04', 'CMP-SLAB05']);
      expect(new Set(codes).size).toBe(codes.length); // no complaint claimed by both
    } finally {
      await Promise.all([a.end(), b.end()]);
    }
    expect((await db.query('select count(*)::int as n from claim_overdue_complaints(50)')).rows[0].n).toBe(0);
    const marked = await db.query(`select count(*)::int as n from public.complaints where escalated_at is not null`);
    expect(marked.rows[0].n).toBe(8);
  });

  it('rolls back and re-applies once no email-less complaints remain', async () => {
    await clearComplaints();
    await db.query(sql('003_rollback.sql'));
    const cols = await db.query(
      `select column_name from information_schema.columns where table_name = 'complaints' and column_name in ('contact_key','call_id')`,
    );
    expect(cols.rows).toEqual([]);
    await db.query(sql('003_voice.sql'));
  });
});

/**
 * Scores triage results against evals/triage/dataset.json. Pure: the offline
 * run (keyword rules, in CI) and the live run (Gemini) both use it.
 */
import type { DepartmentCode, Priority } from '../../lib/complaints/catalog.js';
import type { TriageResult } from '../../lib/complaints/triage.js';

export interface Case {
  id: string;
  text: string;
  expected_priority: Priority;
  expected_department: DepartmentCode;
  note?: string;
}

export interface Dataset {
  description: string;
  cases: Case[];
}

export interface Report {
  total: number;
  departmentCorrect: number;
  priorityCorrect: number;
  bothCorrect: number;
  /** Emergencies (expected department "emergency") that were flagged as emergencies. */
  emergencyCaught: number;
  emergencyTotal: number;
  /** Non-emergencies flagged as emergencies. */
  falseAlarms: string[];
  needsReview: number;
  /** Cases the AI answered (vs keyword fallback); equals total offline only when keywords are the source. */
  aiAnswered: number;
  errors: { id: string; expected: string; got: string; review: boolean }[];
}

export function score(cases: Case[], results: TriageResult[]): Report {
  const r: Report = {
    total: cases.length,
    departmentCorrect: 0,
    priorityCorrect: 0,
    bothCorrect: 0,
    emergencyCaught: 0,
    emergencyTotal: 0,
    falseAlarms: [],
    needsReview: 0,
    aiAnswered: 0,
    errors: [],
  };
  cases.forEach((c, i) => {
    const t = results[i]!;
    const dept = t.department === c.expected_department;
    const prio = t.priority === c.expected_priority;
    if (dept) r.departmentCorrect++;
    if (prio) r.priorityCorrect++;
    if (dept && prio) r.bothCorrect++;
    if (c.expected_department === 'emergency') {
      r.emergencyTotal++;
      if (t.emergency) r.emergencyCaught++;
    } else if (t.emergency) r.falseAlarms.push(c.id);
    if (t.needs_review) r.needsReview++;
    if (t.source === 'ai') r.aiAnswered++;
    if (!dept || !prio) {
      r.errors.push({
        id: c.id,
        expected: `${c.expected_priority} ${c.expected_department}`,
        got: `${t.priority} ${t.department}`,
        review: t.needs_review,
      });
    }
  });
  return r;
}

const pct = (a: number, b: number) => `${a}/${b} (${b ? ((a / b) * 100).toFixed(0) : 0}%)`;

export function formatReport(r: Report, title: string): string {
  return [
    `## ${title}`,
    '',
    '| Metric | Result |',
    '|---|---|',
    `| Department correct | ${pct(r.departmentCorrect, r.total)} |`,
    `| Priority correct | ${pct(r.priorityCorrect, r.total)} |`,
    `| Both correct | ${pct(r.bothCorrect, r.total)} |`,
    `| Emergencies caught | ${pct(r.emergencyCaught, r.emergencyTotal)} |`,
    `| False emergency alarms | ${r.falseAlarms.length}${r.falseAlarms.length ? ` (${r.falseAlarms.join(', ')})` : ''} |`,
    `| Sent to human review | ${pct(r.needsReview, r.total)} |`,
    `| Answered by the AI | ${pct(r.aiAnswered, r.total)} |`,
    '',
    r.errors.length
      ? `Errors (expected → got): ${r.errors.map((e) => `${e.id} ${e.expected} → ${e.got}${e.review ? ' [review]' : ''}`).join('; ')}`
      : 'Errors: none',
  ].join('\n');
}

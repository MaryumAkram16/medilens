import { describe, expect, it } from 'vitest';
import { DEPARTMENT_CODES, PRIORITIES } from '../lib/complaints/catalog.js';
import { dataset, offlineReport } from '../evals/triage/run.js';

describe('triage evaluation dataset', () => {
  it('has 50 unique cases with labels from the allowed lists', () => {
    expect(dataset.cases).toHaveLength(50);
    expect(new Set(dataset.cases.map((c) => c.id)).size).toBe(50);
    for (const c of dataset.cases) {
      expect(DEPARTMENT_CODES).toContain(c.expected_department);
      expect(PRIORITIES).toContain(c.expected_priority);
      if (c.expected_department === 'emergency') expect(c.expected_priority).toBe('High');
    }
  });
});

describe('triage without AI (regression floor)', () => {
  // Floors are the recorded offline results. Raise them when triage improves;
  // a drop fails CI. The emergency floor is absolute.
  const r = offlineReport();

  it('catches every emergency', () => {
    expect(r.emergencyCaught).toBe(r.emergencyTotal);
    expect(r.emergencyTotal).toBe(6);
  });

  it('keeps false emergency alarms to the known past-symptom case', () => {
    expect(r.falseAlarms).toEqual(['C39']);
  });

  it('routes and rates at least as well as recorded', () => {
    expect(r.departmentCorrect).toBeGreaterThanOrEqual(44);
    expect(r.bothCorrect).toBeGreaterThanOrEqual(36);
  });

  it('sends every keyword-only decision to a human', () => {
    expect(r.needsReview).toBe(r.total);
    expect(r.aiAnswered).toBe(0);
  });
});

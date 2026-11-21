/** Fixed vocabularies shared by triage, validation, the database and the AI schema. */

export const PRIORITIES = ['High', 'Medium', 'Low'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const SENTIMENTS = ['Negative', 'Neutral', 'Positive'] as const;
export type Sentiment = (typeof SENTIMENTS)[number];

/** Must match the rows seeded by db/001_complaints.sql. */
export const DEPARTMENTS = {
  emergency: { name: 'Emergency Department', slaHours: 1 },
  clinical_care: { name: 'Doctor & Clinical Care', slaHours: 24 },
  nursing: { name: 'Nursing & Ward Care', slaHours: 24 },
  pharmacy: { name: 'Pharmacy', slaHours: 24 },
  laboratory: { name: 'Laboratory & Diagnostics', slaHours: 48 },
  appointments: { name: 'Appointments & Scheduling', slaHours: 48 },
  billing: { name: 'Billing & Insurance', slaHours: 72 },
  facilities: { name: 'Facilities & Cleanliness', slaHours: 72 },
  patient_relations: { name: 'Patient Relations (triage desk)', slaHours: 48 },
} as const;

export type DepartmentCode = keyof typeof DEPARTMENTS;
export const DEPARTMENT_CODES = Object.keys(DEPARTMENTS) as DepartmentCode[];

/** Where a complaint goes when nobody can route it confidently. */
export const REVIEW_DEPARTMENT: DepartmentCode = 'patient_relations';

/** Below this AI confidence the complaint goes to the triage desk for a human to route. */
export const REVIEW_CONFIDENCE = 0.6;

export const EMERGENCY_NOTICE =
  'If this is a medical emergency, call 1122 or go to the nearest emergency department now. ' +
  'This complaint form is not monitored for emergencies.';

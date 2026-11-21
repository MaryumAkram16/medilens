/**
 * Complaint triage: decides priority and department, never trusting the AI alone.
 *
 * Order of authority:
 *   1. Emergency rule (code): danger words force High priority, the Emergency
 *      department, an emergency notice and human review, whatever the AI says.
 *   2. AI (Gemini): priority, department, category, sentiment, suggested action,
 *      confidence. Below REVIEW_CONFIDENCE it goes to the triage desk instead.
 *   3. Keyword rules: used when the AI is unavailable or returns something
 *      invalid; always flagged for review.
 */
import {
  DEPARTMENTS,
  EMERGENCY_NOTICE,
  REVIEW_CONFIDENCE,
  REVIEW_DEPARTMENT,
  type DepartmentCode,
  type Priority,
  type Sentiment,
} from './catalog.js';

export interface AiTriage {
  priority: Priority;
  department: DepartmentCode;
  category: string;
  sentiment: Sentiment;
  suggested_action: string;
  confidence: number;
}

export interface TriageResult extends AiTriage {
  source: 'ai' | 'keywords';
  emergency: boolean;
  needs_review: boolean;
  /** Why a human must look at it, when needs_review is true. */
  review_reason: string | null;
  emergency_notice: string | null;
}

// English and Roman Urdu phrases that can mean someone is in danger right now.
// Deliberately broad: a false alarm costs a human a minute, a miss could cost a life.
const EMERGENCY_PATTERNS: RegExp[] = [
  /\bchest pain\b/,
  /\bheart attack\b/,
  /\b(can'?t|cannot|can not|unable to) breathe\b/,
  /\b(difficulty|trouble|struggling) breathing\b/,
  /\b(not|stopped) breathing\b/,
  /\bunconscious\b/,
  /\bunresponsive\b/,
  /\bpassed out\b/,
  /\bseizures?\b/,
  /\bstroke\b/,
  /\b(severe|heavy|heavily|uncontrolled) bleeding\b/,
  /\bbleeding (heavily|a lot|badly)\b/,
  /\bwon'?t stop bleeding\b/,
  /\boverdose\b/,
  /\btook too many (pills|tablets)\b/,
  /\bsuicid/,
  /\bkill (myself|himself|herself)\b/,
  /\bend (my|his|her) life\b/,
  /\bself[- ]harm\b/,
  /\banaphyla/,
  /\b(throat|tongue|face) (is )?swell/,
  /\bchoking\b/,
  /\bpoison(ed|ing)\b/,
  // Roman Urdu
  /\bsaa?ns nahi?n?\b/,
  /\bse+n[ae]y? m[ae]i?n dard\b/,
  /\bbehosh\b/,
  /\bkhoon (beh|bah) raha\b/,
  /\bkhud ?kushi\b/,
];

export function normalize(text: string): string {
  return text.toLowerCase().replace(/[’`]/g, "'").replace(/\s+/g, ' ').trim();
}

export function detectEmergency(text: string): string[] {
  const t = normalize(text);
  return EMERGENCY_PATTERNS.filter((p) => p.test(t)).map((p) => p.source);
}

// Keyword routing, used only as the fallback. Order breaks ties.
const DEPARTMENT_KEYWORDS: [DepartmentCode, RegExp][] = [
  ['pharmacy', /\b(medicines?|medications?|prescriptions?|pharmacy|pharmacist|dose|dosage|drugs?|tablets?|capsules?|syrup|injection)\b/g],
  ['laboratory', /\b(lab|laboratory|test results?|reports?|blood tests?|samples?|x-?rays?|scans?|mri|ct|ultrasound|biopsy)\b/g],
  ['billing', /\b(bills?|billing|billed|charges?|charged|overcharg\w*|invoices?|payments?|paid|refunds?|insurance|fees?|receipt)\b/g],
  ['appointments', /\b(appointments?|bookings?|booked|schedul\w*|reschedul\w*|cancel\w*|waiting|waited|queue|token|slot|opd)\b/g],
  ['nursing', /\b(nurses?|nursing|ward|beds?|night staff|drip|cannula|call bell)\b/g],
  ['clinical_care', /\b(doctors?|dr|consultant|surgeon|surgery|operation|diagnos\w*|misdiagnos\w*|treatment|checkup|examined|specialist)\b/g],
  ['facilities', /\b(clean\w*|dirty|filthy|toilets?|washrooms?|bathrooms?|parking|lift|elevator|air ?condition\w*|fans?|food|canteen|smell\w*|cockroach\w*|water|wifi|noise|noisy|lights?)\b/g],
];

const HIGH_PRIORITY =
  /\b(wrong (medicine|medication|dose|dosage|drug|patient|blood|report|limb|side)|misdiagnos\w*|negligen\w*|infection|infected|fell|fall from|dropped|abus\w*|harass\w*|assault\w*|discriminat\w*|refused (treatment|to treat)|ignored|no one came|nobody came|left alone|allerg\w*|wrong report)\b/;
const LOW_PRIORITY = /\b(parking|food|canteen|wifi|tv|television|noise|noisy|signage|magazine|chairs?|vending)\b/;

const POSITIVE = /\b(thank\w*|grateful|excellent|appreciat\w*|great care|very kind|wonderful)\b/;
const NEGATIVE =
  /\b(rude|terrible|worst|awful|angry|unacceptable|disappointed|disgusting|horrible|careless|ignored|never again|waste|pathetic|bad)\b/;

const DEFAULT_ACTIONS: Record<DepartmentCode, string> = {
  emergency: 'Call the patient immediately to confirm they are safe and direct them to emergency care.',
  clinical_care: 'Have the department head review the case notes and call the patient within 24 hours.',
  nursing: 'Ward manager to review the shift record and speak with the patient within 24 hours.',
  pharmacy: 'Pharmacist to check the prescription and dispensing record and contact the patient within 24 hours.',
  laboratory: 'Lab supervisor to trace the sample and report status, then update the patient within 48 hours.',
  appointments: 'Check the booking record, offer the next available slot and confirm with the patient.',
  billing: 'Compare the bill with the recorded services, correct any error and reply within 72 hours.',
  facilities: 'Send the facilities team to inspect the area and confirm the fix with the patient.',
  patient_relations: 'Triage desk to read the complaint, assign the right department and acknowledge the patient.',
};

function count(re: RegExp, text: string): number {
  return text.match(re)?.length ?? 0;
}

function keywordSentiment(t: string): Sentiment {
  if (NEGATIVE.test(t)) return 'Negative';
  if (POSITIVE.test(t)) return 'Positive';
  return 'Neutral';
}

/** Rule-based triage. Deterministic, so it is also the offline baseline in the evaluation. */
export function keywordTriage(text: string): AiTriage {
  const t = normalize(text);
  let best: DepartmentCode = REVIEW_DEPARTMENT;
  let bestHits = 0;
  for (const [code, re] of DEPARTMENT_KEYWORDS) {
    const hits = count(re, t);
    if (hits > bestHits) {
      best = code;
      bestHits = hits;
    }
  }
  const priority: Priority = HIGH_PRIORITY.test(t) ? 'High' : LOW_PRIORITY.test(t) ? 'Low' : 'Medium';
  return {
    priority,
    department: best,
    category: bestHits ? `${DEPARTMENTS[best].name} issue` : 'General complaint',
    sentiment: keywordSentiment(t),
    suggested_action: DEFAULT_ACTIONS[best],
    confidence: bestHits === 0 ? 0.2 : bestHits === 1 ? 0.4 : 0.5,
  };
}

/**
 * Combines the AI answer (or its absence) with the safety rules.
 * `ai` is null when the AI call failed or returned something invalid.
 */
export function finalizeTriage(text: string, ai: AiTriage | null): TriageResult {
  const base = ai ?? keywordTriage(text);
  const source: TriageResult['source'] = ai ? 'ai' : 'keywords';
  const emergencyHits = detectEmergency(text);

  if (emergencyHits.length > 0) {
    return {
      ...base,
      priority: 'High',
      department: 'emergency',
      suggested_action: DEFAULT_ACTIONS.emergency,
      source,
      emergency: true,
      needs_review: true,
      review_reason: 'Emergency words detected; a person must confirm the patient is safe.',
      emergency_notice: EMERGENCY_NOTICE,
    };
  }

  if (!ai) {
    return {
      ...base,
      source,
      emergency: false,
      needs_review: true,
      review_reason: 'AI triage unavailable; routed by keyword rules.',
      emergency_notice: null,
    };
  }

  if (ai.confidence < REVIEW_CONFIDENCE) {
    return {
      ...ai,
      department: REVIEW_DEPARTMENT,
      suggested_action: DEFAULT_ACTIONS[REVIEW_DEPARTMENT],
      source,
      emergency: false,
      needs_review: true,
      review_reason: `AI confidence ${ai.confidence.toFixed(2)} is below ${REVIEW_CONFIDENCE}; AI suggested ${DEPARTMENTS[ai.department].name}.`,
      emergency_notice: null,
    };
  }

  return { ...ai, source, emergency: false, needs_review: false, review_reason: null, emergency_notice: null };
}

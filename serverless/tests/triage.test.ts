import { describe, expect, it } from 'vitest';
import { DEPARTMENTS, EMERGENCY_NOTICE, REVIEW_CONFIDENCE } from '../lib/complaints/catalog.js';
import { detectEmergency, finalizeTriage, keywordTriage, type AiTriage } from '../lib/complaints/triage.js';

const ai = (over: Partial<AiTriage> = {}): AiTriage => ({
  priority: 'Medium',
  department: 'billing',
  category: 'Billing error',
  sentiment: 'Negative',
  suggested_action: 'Correct the bill within 72 hours.',
  confidence: 0.9,
  ...over,
});

describe('detectEmergency', () => {
  it.each([
    'My father has chest pain and nobody is attending him',
    "She can't breathe properly since the injection",
    'He is unconscious in the waiting area',
    'The wound is bleeding heavily after discharge',
    'I took too many pills last night',
    'I want to kill myself',
    'Her throat is swelling after the new medicine',
    'Abbu ko seenay mein dard hai',
    'Ammi ko saans nahi aa rahi',
    'Mareez behosh ho gaya',
  ])('flags "%s"', (text) => {
    expect(detectEmergency(text).length).toBeGreaterThan(0);
  });

  it.each([
    'The bill charged me twice for the same blood test',
    'Parking was full and the guard was rude',
    'My appointment was cancelled without notice',
    'The doctor did not explain my diagnosis clearly',
    'Breathing exercises class was cancelled',
  ])('does not flag "%s"', (text) => {
    expect(detectEmergency(text)).toEqual([]);
  });
});

describe('keywordTriage (fallback)', () => {
  it.each([
    ['I was charged twice on my bill and the refund never came', 'billing'],
    ['My blood test report has been missing for a week', 'laboratory'],
    ['The pharmacy gave me the wrong medicine', 'pharmacy'],
    ['My appointment was cancelled and rescheduled three times', 'appointments'],
    ['The nurse on the night ward never answered the call bell', 'nursing'],
    ['The doctor refused to examine me properly', 'clinical_care'],
    ['The washroom was dirty and smelled terrible', 'facilities'],
  ] as const)('routes "%s" to %s', (text, department) => {
    expect(keywordTriage(text).department).toBe(department);
  });

  it('sends text with no known keyword to the triage desk with low confidence', () => {
    const t = keywordTriage('I am not happy with how things went yesterday.');
    expect(t.department).toBe('patient_relations');
    expect(t.confidence).toBeLessThan(REVIEW_CONFIDENCE);
  });

  it('rates safety problems High, comfort problems Low, the rest Medium', () => {
    expect(keywordTriage('The pharmacy gave me the wrong medicine').priority).toBe('High');
    expect(keywordTriage('My mother fell from the bed in the ward').priority).toBe('High');
    expect(keywordTriage('Parking was full again').priority).toBe('Low');
    expect(keywordTriage('I was charged twice on my bill').priority).toBe('Medium');
  });

  it('reads sentiment from the wording', () => {
    expect(keywordTriage('The staff were rude and it was unacceptable').sentiment).toBe('Negative');
    expect(keywordTriage('Thank you, the nurses were very kind').sentiment).toBe('Positive');
    expect(keywordTriage('I would like a copy of my bill').sentiment).toBe('Neutral');
  });
});

describe('finalizeTriage', () => {
  it('keeps a confident AI answer as it is', () => {
    const t = finalizeTriage('I was charged twice on my bill', ai());
    expect(t).toMatchObject({ source: 'ai', department: 'billing', priority: 'Medium', needs_review: false, emergency: false });
    expect(t.emergency_notice).toBeNull();
  });

  it('lets the emergency rule override the AI, even a confident one', () => {
    const t = finalizeTriage('I was charged twice. Also my father has chest pain right now.', ai({ priority: 'Low', confidence: 0.99 }));
    expect(t).toMatchObject({ priority: 'High', department: 'emergency', emergency: true, needs_review: true });
    expect(t.emergency_notice).toBe(EMERGENCY_NOTICE);
  });

  it('applies the emergency rule when the AI is down too', () => {
    const t = finalizeTriage('Ammi ko saans nahi aa rahi', null);
    expect(t).toMatchObject({ source: 'keywords', department: 'emergency', priority: 'High', emergency: true });
  });

  it('falls back to keyword rules when the AI fails, and asks for review', () => {
    const t = finalizeTriage('My blood test report has been missing for a week', null);
    expect(t).toMatchObject({ source: 'keywords', department: 'laboratory', needs_review: true });
    expect(t.review_reason).toMatch(/unavailable/);
  });

  it('sends a low-confidence AI answer to the triage desk instead of guessing', () => {
    const t = finalizeTriage('Something went wrong with my visit', ai({ department: 'nursing', confidence: 0.45 }));
    expect(t).toMatchObject({ department: 'patient_relations', needs_review: true, source: 'ai' });
    expect(t.review_reason).toContain(DEPARTMENTS.nursing.name);
  });

  it('treats exactly the threshold as confident', () => {
    expect(finalizeTriage('bill problem', ai({ confidence: REVIEW_CONFIDENCE })).needs_review).toBe(false);
  });
});

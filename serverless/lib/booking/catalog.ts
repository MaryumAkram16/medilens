/** Specialties the voice agent can book. Must match db/002_appointments.sql. */
export const SPECIALTIES = {
  general_medicine: 'General Medicine',
  cardiology: 'Cardiology',
  pediatrics: 'Pediatrics',
  dermatology: 'Dermatology',
  orthopedics: 'Orthopedics',
  gynecology: 'Gynecology',
} as const;

export type SpecialtyCode = keyof typeof SPECIALTIES;
export const SPECIALTY_CODES = Object.keys(SPECIALTIES) as SpecialtyCode[];

/** The hospital's clock: slots, "today" and "past" are all Pakistan time. */
export const TIME_ZONE = 'Asia/Karachi';

// How callers actually say it, in English and Roman Urdu.
const ALIASES: [SpecialtyCode, RegExp][] = [
  ['cardiology', /\b(cardio\w*|heart|dil)\b/],
  ['pediatrics', /\b(paediatric\w*|pediatric\w*|child(ren)?|kids?|baby|babies|bach(a|ay|on|e)?|bachon)\b/],
  ['dermatology', /\b(dermatolog\w*|skin|jild|acne|rash)\b/],
  ['orthopedics', /\b(orthop(a)?edic\w*|ortho|bones?|haddi|haddiy?on|joints?|fracture|knee|back pain)\b/],
  ['gynecology', /\b(gyn(a)?ecolog\w*|gyn(a)?e|obstetric\w*|women'?s health|pregnan\w*|lady doctor)\b/],
  ['general_medicine', /\b(general( medicine| physician| practitioner)?|gp|family (doctor|medicine)|medicine|fever|bukhar|checkup|check-up)\b/],
];

/** Maps what the caller said to a specialty, or null when it is unclear. */
export function resolveSpecialty(spoken: string | undefined | null): SpecialtyCode | null {
  if (!spoken) return null;
  const t = spoken.toLowerCase().replace(/[_-]+/g, ' ').trim();
  for (const code of SPECIALTY_CODES) {
    if (t === code.replace('_', ' ') || t === SPECIALTIES[code].toLowerCase()) return code;
  }
  for (const [code, re] of ALIASES) if (re.test(t)) return code;
  return null;
}

export const SPECIALTY_LIST_SPOKEN = Object.values(SPECIALTIES).join(', ');

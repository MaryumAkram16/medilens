import { describe, expect, it } from 'vitest';
import { resolveSpecialty } from '../lib/booking/catalog.js';
import { addDays, isoWeekday, karachiParts, spokenDate, spokenTime } from '../lib/booking/clock.js';
import { newAppointmentCode, normalizeCode, spellCode } from '../lib/booking/service.js';
import { phoneKey } from '../lib/booking/types.js';

describe('resolveSpecialty', () => {
  it.each([
    ['Cardiology', 'cardiology'],
    ['cardiology', 'cardiology'],
    ['heart doctor', 'cardiology'],
    ['dil ka doctor', 'cardiology'],
    ['children', 'pediatrics'],
    ['bachon ka doctor', 'pediatrics'],
    ['skin problem', 'dermatology'],
    ['haddi ka doctor', 'orthopedics'],
    ['knee pain', 'orthopedics'],
    ['lady doctor', 'gynecology'],
    ['general physician', 'general_medicine'],
    ['bukhar hai', 'general_medicine'],
    ['general_medicine', 'general_medicine'],
  ] as const)('maps "%s" to %s', (spoken, code) => {
    expect(resolveSpecialty(spoken)).toBe(code);
  });

  it('returns null when it is unclear', () => {
    expect(resolveSpecialty('I need help')).toBeNull();
    expect(resolveSpecialty('')).toBeNull();
    expect(resolveSpecialty(undefined)).toBeNull();
  });
});

describe('codes', () => {
  it.each([
    ['APT-7K2QXM', 'APT-7K2QXM'],
    ['apt 7k2qxm', 'APT-7K2QXM'],
    ['A P T 7 K 2 Q X M', 'APT-7K2QXM'],
    ['7k2qxm', 'APT-7K2QXM'],
  ])('normalises "%s"', (raw, code) => {
    expect(normalizeCode(raw, 'APT')).toBe(code);
  });

  it('rejects things that are not codes, including old numeric slot ids', () => {
    expect(normalizeCode('12', 'APT')).toBeNull();
    expect(normalizeCode('APT-7K2', 'APT')).toBeNull();
    expect(normalizeCode({}, 'APT')).toBeNull();
    expect(normalizeCode('cmp abc234', 'CMP')).toBe('CMP-ABC234');
  });

  it('makes readable codes and spells them for speech', () => {
    for (let i = 0; i < 100; i++) expect(newAppointmentCode()).toMatch(/^APT-[A-HJ-NP-Z2-9]{6}$/);
    expect(spellCode('APT-7K2QXM')).toBe('A P T, 7 K 2 Q X M');
  });

  it('treats local and international forms of a phone as the same', () => {
    expect(phoneKey('0300 1234567')).toBe(phoneKey('+92-300-1234567'));
  });
});

describe('Pakistan clock', () => {
  it('uses Asia/Karachi (UTC+5), including across UTC midnight', () => {
    expect(karachiParts(new Date('2026-11-23T04:00:00Z'))).toEqual({ date: '2026-11-23', time: '09:00' });
    expect(karachiParts(new Date('2026-11-22T20:30:00Z'))).toEqual({ date: '2026-11-23', time: '01:30' });
  });

  it('formats dates and times for speech', () => {
    expect(spokenDate('2026-11-23')).toBe('Monday 23 November');
    expect(spokenTime('09:30:00')).toBe('9:30 AM');
    expect(spokenTime('12:00')).toBe('12:00 PM');
    expect(spokenTime('00:15')).toBe('12:15 AM');
  });

  it('does date arithmetic without time-zone drift', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(isoWeekday('2026-11-22')).toBe(7);
    expect(isoWeekday('2026-11-23')).toBe(1);
  });
});

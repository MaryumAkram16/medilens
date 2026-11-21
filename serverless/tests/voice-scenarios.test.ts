import { describe, expect, it } from 'vitest';
import { SPEECH_RULES, formatResults, runScenario, type Scenario } from '../evals/voice/runner.js';
import { SCENARIOS } from '../evals/voice/scenarios.js';

describe('voice agent scenarios', () => {
  it.each(SCENARIOS.map((s) => [s.id, s] as const))('%s passes', async (_id, scenario) => {
    const result = await runScenario(scenario);
    expect(result.steps.filter((s) => s.problems.length).map((s) => `${s.say}: ${s.problems.join('; ')}`)).toEqual([]);
  });

  it('has unique ids and covers every voice tool', () => {
    expect(new Set(SCENARIOS.map((s) => s.id)).size).toBe(SCENARIOS.length);
    const tools = new Set(SCENARIOS.flatMap((s) => s.steps.map((st) => st.tool)));
    expect([...tools].sort()).toEqual(
      ['appointmentCheck', 'bookAppointment', 'cancelStatus', 'complaintCheck', 'confirmCancellation', 'confirmReschedule', 'doctorAvailability', 'submitVoiceComplaint'].sort(),
    );
  });
});

describe('the grader catches failures (so a pass means something)', () => {
  it('fails a step whose reply does not match', async () => {
    const wrong: Scenario = {
      id: 'X01',
      title: 'deliberately wrong expectation',
      steps: [{ say: 'heart doctor', tool: 'doctorAvailability', args: { department: 'heart' }, expect: { success: false, message: /Dermatology/ } }],
    };
    const r = await runScenario(wrong);
    expect(r.passed).toBe(false);
    expect(r.steps[0]!.problems).toEqual(expect.arrayContaining([expect.stringMatching(/^success=true, expected false$/), expect.stringMatching(/does not match/)]));
    expect(formatResults([r])).toMatch(/0\/1 passed[\s\S]*X01 deliberately wrong expectation[\s\S]*does not match/);
  });

  it('fails on a custom check and on an unexpected HTTP status', async () => {
    const r = await runScenario({
      id: 'X02',
      title: 'check and status',
      steps: [{ say: 'x', tool: 'doctorAvailability', args: { department: 'heart' }, expect: { status: 429, check: () => 'custom problem' } }],
    });
    expect(r.steps[0]!.problems).toEqual(expect.arrayContaining(['HTTP 200, expected 429', 'custom problem']));
  });

  it('speech rules reject what a voice must never say', () => {
    const broken = (sentence: string) => SPEECH_RULES.filter((rule) => !rule.test(sentence)).map((rule) => rule.name);
    expect(broken('Your appointment APT-7K2QXM is booked.')).toEqual(['codes spelled out, not raw']);
    expect(broken('See you on 2026-11-24.')).toEqual(['no machine dates (YYYY-MM-DD)']);
    expect(broken('Your slot is at 14:30.')).toEqual(['times say AM or PM']);
    expect(broken('Doctor: undefined')).toEqual(['no programming values']);
    expect(broken('{"ok":true}')).toEqual(['no programming values']);
    expect(broken('')).toEqual(['not empty']);
    expect(broken('word '.repeat(80))).toEqual(['at most 70 words']);
    expect(broken('Your appointment A P T, 7 K 2 Q X M is on Monday 23 November at 9:30 AM.')).toEqual([]);
  });
});

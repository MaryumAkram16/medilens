import { describe, expect, it } from 'vitest';
import { routeFromHash } from '../src/App';
import { blobToBase64, pickAudioType, tabStore, toLines } from '../src/lib';

describe('toLines', () => {
  it('keeps caller and agent speech, drops backchannels and joins same-speaker turns', () => {
    expect(
      toLines([
        { role: 'agent', content: 'Hello, MediLens here.' },
        { role: 'user', content: 'Hi' },
        { role: 'agent', content: 'mm-hmm', metadata: { is_backchannel: true } },
        { role: 'user', content: 'I need a cardiologist.' },
        { role: 'tool_call_invocation', content: '{}' },
        { role: 'agent', content: '  ' },
        null,
        { role: 'agent', content: 'Sure.' },
      ]),
    ).toEqual([
      { speaker: 'agent', text: 'Hello, MediLens here.' },
      { speaker: 'you', text: 'Hi I need a cardiologist.' },
      { speaker: 'agent', text: 'Sure.' },
    ]);
  });
});

describe('pickAudioType', () => {
  it('prefers webm/opus and falls back to mp4 (Safari)', () => {
    expect(pickAudioType(() => true)).toBe('audio/webm;codecs=opus');
    expect(pickAudioType((t) => t === 'audio/mp4')).toBe('audio/mp4');
    expect(pickAudioType(() => false)).toBeNull();
  });
});

describe('blobToBase64', () => {
  it('encodes bytes exactly', async () => {
    const bytes = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 255]);
    expect(await blobToBase64(new Blob([bytes]))).toBe(btoa(String.fromCharCode(...bytes)));
  });
});

describe('tabStore', () => {
  it('stores and removes values', () => {
    tabStore.set('k', 'v');
    expect(tabStore.get('k')).toBe('v');
    tabStore.set('k', null);
    expect(tabStore.get('k')).toBeNull();
  });
});

describe('routeFromHash', () => {
  it('maps hashes to pages and defaults to home', () => {
    expect(routeFromHash('')).toBe('home');
    expect(routeFromHash('#/')).toBe('home');
    expect(routeFromHash('#/complaints')).toBe('complaints');
    expect(routeFromHash('#/status?x=1')).toBe('status');
    expect(routeFromHash('#/staff/')).toBe('staff');
    expect(routeFromHash('#/nope')).toBe('home');
  });
});

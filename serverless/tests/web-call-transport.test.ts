import { describe, expect, it } from 'vitest';
import { toWebCall } from '../lib/voice/web-call.js';

describe('toWebCall (what the browser gets from Retell create-web-call)', () => {
  it('passes the gateway transport, call id and ICE servers through', () => {
    expect(
      toWebCall({
        call_id: 'call_1',
        access_token: 'tok',
        transport: 'gateway',
        expires_at: 123,
        agent_id: 'agent_secret_detail',
        ice_servers: [{ urls: ['stun:stun.example.test'] }, { urls: 'turn:turn.example.test', username: 'u', credential: 'c', extra: 1 }, { urls: 5 }],
      }),
    ).toEqual({
      call_id: 'call_1',
      access_token: 'tok',
      transport: 'gateway',
      ice_servers: [{ urls: ['stun:stun.example.test'] }, { urls: 'turn:turn.example.test', username: 'u', credential: 'c' }],
    });
  });

  it('treats a missing transport as livekit and keeps only a wss url', () => {
    expect(toWebCall({ call_id: 'c', access_token: 't' })).toEqual({ call_id: 'c', access_token: 't', transport: 'livekit' });
    expect(toWebCall({ call_id: 'c', access_token: 't', transport: 'livekit', url: 'wss://lk.example.test' }).url).toBe('wss://lk.example.test');
    expect(toWebCall({ call_id: 'c', access_token: 't', transport: 'livekit', url: 'http://evil.test' }).url).toBeUndefined();
  });

  it('rejects a response without a call id or token', () => {
    expect(() => toWebCall({ access_token: 't' })).toThrow('retell_bad_response');
    expect(() => toWebCall({ call_id: 'c' })).toThrow('retell_bad_response');
  });
});

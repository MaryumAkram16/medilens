import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api';
import { VoiceCall, startConfig, type CallClient } from '../src/components/VoiceCall';

function fakeClient() {
  const handlers = new Map<string, (...a: unknown[]) => void>();
  const client: CallClient & { emit: (e: string, ...a: unknown[]) => void } = {
    startCall: vi.fn(async () => {}),
    stopCall: vi.fn(() => handlers.get('call_ended')?.()),
    mute: vi.fn(),
    unmute: vi.fn(),
    on: (e, fn) => handlers.set(e, fn as (...a: unknown[]) => void),
    removeAllListeners: vi.fn(),
    emit: (e, ...a) => handlers.get(e)?.(...a),
  };
  return client;
}

const webCall = { success: true as const, call_id: 'call_1', access_token: 'tok', summary_token: 'sum', transport: 'gateway' as const, ice_servers: [{ urls: 'turn:turn.example.test', username: 'u', credential: 'c' }] };

describe('VoiceCall', () => {
  it('runs a call: connect, live transcript, end, summary', async () => {
    const user = userEvent.setup();
    const client = fakeClient();
    const getSummary = vi.fn(async () => ({
      success: true as const,
      call_id: 'call_1',
      actions: [{ action: 'booked', reference: 'APT-1', text: 'Booked Dr. Test, Thursday 10:00.' }],
      text: '',
    }));
    render(<VoiceCall createCall={async () => webCall} loadClient={async () => client} getSummary={getSummary} />);

    await user.click(screen.getByRole('button', { name: 'Call the MediLens agent' }));
    expect(client.startCall).toHaveBeenCalledWith({ accessToken: 'tok', callId: 'call_1', transport: 'gateway', iceServers: [{ urls: 'turn:turn.example.test', username: 'u', credential: 'c' }] });

    act(() => client.emit('call_started'));
    expect(screen.getByText('LISTENING · TAP TO END')).toBeTruthy();

    act(() =>
      client.emit('update', {
        transcript: [
          { role: 'agent', content: 'MediLens, how can I help?' },
          { role: 'user', content: 'Book a cardiologist.' },
        ],
      }),
    );
    expect(screen.getByText('Book a cardiologist.')).toBeTruthy();

    act(() => client.emit('agent_start_talking'));
    expect(screen.getByText('AGENT IS SPEAKING')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Mute' }));
    expect(client.mute).toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'End call' }));
    expect(client.stopCall).toHaveBeenCalled();
    expect(await screen.findByText('Booked Dr. Test, Thursday 10:00.')).toBeTruthy();
    expect(getSummary).toHaveBeenCalledWith('call_1', 'sum');
    expect(screen.getByText('TAP TO CALL AGENT')).toBeTruthy();
  });

  it('asks for the demo code when the API requires one, then retries with it', async () => {
    const user = userEvent.setup();
    const createCall = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(401, 'PASSCODE_REQUIRED', 'code needed'))
      .mockResolvedValueOnce(webCall);
    const client = fakeClient();
    render(<VoiceCall createCall={createCall} loadClient={async () => client} />);

    await user.click(screen.getByRole('button', { name: 'Call the MediLens agent' }));
    await user.type(await screen.findByLabelText('This demo needs a code'), 'demo-123');
    await user.click(screen.getByRole('button', { name: 'Start call' }));
    expect(createCall).toHaveBeenLastCalledWith('demo-123');
    expect(client.startCall).toHaveBeenCalled();
  });

  it('shows a clear error when calls are not available', async () => {
    const user = userEvent.setup();
    render(
      <VoiceCall
        createCall={async () => {
          throw new ApiError(503, 'WEB_CALL_DISABLED', 'Voice calls are not switched on yet.');
        }}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Call the MediLens agent' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Voice calls are not switched on yet.');
  });

  it('explains a microphone problem if the call cannot start', async () => {
    const user = userEvent.setup();
    const client = fakeClient();
    client.startCall = vi.fn(async () => {
      throw new DOMException('denied', 'NotAllowedError');
    });
    render(<VoiceCall createCall={async () => webCall} loadClient={async () => client} />);
    await user.click(screen.getByRole('button', { name: 'Call the MediLens agent' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Allow the microphone');
  });
});

describe('startConfig', () => {
  it('uses the transport Retell named, and LiveKit when it named none', () => {
    expect(startConfig({ call_id: 'c', access_token: 't', transport: 'gateway', ice_servers: [{ urls: 'stun:s.example.test' }] })).toEqual({
      accessToken: 't',
      callId: 'c',
      transport: 'gateway',
      iceServers: [{ urls: 'stun:s.example.test' }],
    });
    expect(startConfig({ call_id: 'c', access_token: 't' })).toEqual({ accessToken: 't', callId: 'c', transport: 'livekit' });
  });

  it('shows the reason Retell gives when the call cannot connect', async () => {
    const user = userEvent.setup();
    const client = fakeClient();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    client.startCall = vi.fn(async () => client.emit('error', 'gateway WHIP POST failed: 401'));
    render(<VoiceCall createCall={async () => webCall} loadClient={async () => client} />);
    await user.click(screen.getByRole('button', { name: 'Call the MediLens agent' }));
    expect((await screen.findByRole('alert')).textContent).toContain('gateway WHIP POST failed: 401');
  });
});

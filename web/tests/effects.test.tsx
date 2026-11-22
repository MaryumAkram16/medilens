import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api';
import { VoiceCall, type CallClient } from '../src/components/VoiceCall';

// Newer Chrome returns a Promise from scrollIntoView. An effect that passes it back
// to React crashed the whole page after the demo code was entered.
describe('browser APIs that return promises', () => {
  it('survives scrollIntoView returning a Promise through passcode, call and hang-up', async () => {
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = vi.fn(() => Promise.resolve()) as unknown as typeof original;
    const errors: unknown[] = [];
    const onError = (e: ErrorEvent) => errors.push(e.error);
    window.addEventListener('error', onError);
    try {
      const user = userEvent.setup();
      const handlers = new Map<string, (...a: unknown[]) => void>();
      const client: CallClient = {
        startCall: vi.fn(async () => {}),
        stopCall: vi.fn(() => handlers.get('call_ended')?.()),
        mute: vi.fn(),
        unmute: vi.fn(),
        on: (e, fn) => handlers.set(e, fn as (...a: unknown[]) => void),
        removeAllListeners: vi.fn(),
      };
      const createCall = vi
        .fn()
        .mockRejectedValueOnce(new ApiError(401, 'PASSCODE_REQUIRED', 'code'))
        .mockResolvedValueOnce({ success: true, call_id: 'c', access_token: 't', summary_token: 's' });
      render(<VoiceCall createCall={createCall} loadClient={async () => client} getSummary={async () => ({ success: true, call_id: 'c', actions: [], text: 'Nothing done.' })} />);
      await user.click(screen.getByRole('button', { name: 'Call the MediLens agent' }));
      await user.type(await screen.findByLabelText('This demo needs a code'), 'demo');
      await user.click(screen.getByRole('button', { name: 'Start call' }));
      act(() => handlers.get('call_started')?.());
      act(() => handlers.get('update')?.({ transcript: [{ role: 'agent', content: 'Hello' }] }));
      act(() => handlers.get('update')?.({ transcript: [{ role: 'agent', content: 'Hello' }, { role: 'user', content: 'Hi' }] }));
      await user.click(screen.getByRole('button', { name: 'End call' }));
      expect(await screen.findByText('Nothing done.')).toBeTruthy();
      expect(screen.getByText('Hi')).toBeTruthy();
      expect(errors).toEqual([]);
    } finally {
      Element.prototype.scrollIntoView = original;
      window.removeEventListener('error', onError);
    }
  });
});

describe('ErrorBoundary', () => {
  it('shows a reload message instead of a blank page when something crashes', async () => {
    const { ErrorBoundary } = await import('../src/components/ErrorBoundary');
    const Boom = () => {
      throw new Error('boom');
    };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('alert').textContent).toContain('Something went wrong');
    expect(screen.getByRole('button', { name: 'Reload the page' })).toBeTruthy();
  });
});

import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CopyButton } from '../src/components/CopyButton';
import { VoiceCall, type CallClient } from '../src/components/VoiceCall';
import { ComplaintForm } from '../src/components/ComplaintForm';
import { transcriptText } from '../src/lib';

describe('transcriptText', () => {
  it('labels speakers and appends the summary', () => {
    expect(transcriptText([{ speaker: 'agent', text: 'Hi' }, { speaker: 'you', text: 'Book me' }], '• Booked')).toBe(
      'MediLens: Hi\nYou: Book me\n\nCall summary:\n• Booked',
    );
    expect(transcriptText([{ speaker: 'you', text: 'Hello' }])).toBe('You: Hello');
  });
});

describe('CopyButton', () => {
  it('copies and confirms, or tells the user to select the text', async () => {
    const user = userEvent.setup();
    const copy = vi.fn(async () => true);
    const { rerender } = render(<CopyButton label="Copy" text="CMP-TEST01" copy={copy} />);
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(copy).toHaveBeenCalledWith('CMP-TEST01');
    expect(screen.getByRole('button', { name: '✓ Copied' })).toBeTruthy();
    rerender(<CopyButton label="Copy" text="x" copy={async () => false} />);
    await user.click(screen.getByRole('button'));
    expect(screen.getByRole('button', { name: 'Select the text to copy' })).toBeTruthy();
  });
});

describe('copying in the app', () => {
  it('copies the whole call transcript with the summary after the call', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const handlers = new Map<string, (...a: unknown[]) => void>();
    const client: CallClient = {
      startCall: vi.fn(async () => {}),
      stopCall: vi.fn(() => handlers.get('call_ended')?.()),
      mute: vi.fn(),
      unmute: vi.fn(),
      on: (e, fn) => handlers.set(e, fn as (...a: unknown[]) => void),
      removeAllListeners: vi.fn(),
    };
    render(
      <VoiceCall
        createCall={async () => ({ success: true, call_id: 'c', access_token: 't', summary_token: 's' })}
        loadClient={async () => client}
        getSummary={async () => ({ success: true, call_id: 'c', actions: [{ action: 'complaint_filed', reference: 'CMP-TEST01', text: 'Filed CMP-TEST01 with Billing.' }], text: '' })}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Call the MediLens agent' }));
    act(() => handlers.get('call_started')?.());
    act(() => handlers.get('update')?.({ transcript: [{ role: 'agent', content: 'How can I help?' }, { role: 'user', content: 'I was charged twice.' }] }));
    await user.click(screen.getByRole('button', { name: 'End call' }));
    await screen.findByText('Filed CMP-TEST01 with Billing.');
    await user.click(screen.getByRole('button', { name: '📋 Copy transcript' }));
    expect(writeText).toHaveBeenCalledWith('MediLens: How can I help?\nYou: I was charged twice.\n\nCall summary:\n• Filed CMP-TEST01 with Billing.');
  });

  it('shows the written answer after a complaint and copies it', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(
      <ComplaintForm
        submit={async () => ({
          success: true, message: 'ok', complaint_code: 'CMP-TEST01', priority: 'Medium', department: 'billing', department_name: 'Billing & Insurance',
          expected_response_hours: 48, needs_review: false, emergency: false, emergency_notice: null,
          spoken_message: 'Your complaint went to Billing and Insurance.',
        })}
      />,
    );
    await user.type(screen.getByLabelText('Name'), 'Test Patient');
    await user.type(screen.getByLabelText('Phone'), '03001234567');
    await user.type(screen.getByLabelText('Email'), 'p@example.test');
    await user.type(screen.getByLabelText('Details'), 'Charged twice for one test.');
    await user.click(screen.getByRole('button', { name: 'Submit Complaint' }));
    expect(await screen.findByText('Your complaint went to Billing and Insurance.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '📋 Copy answer' }));
    expect(writeText).toHaveBeenCalledWith('Your complaint went to Billing and Insurance.\nComplaint code: CMP-TEST01');
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenLastCalledWith('CMP-TEST01');
  });
});

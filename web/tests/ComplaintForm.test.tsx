import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, type ComplaintResult } from '../src/api';
import { ComplaintForm } from '../src/components/ComplaintForm';
import { StatusLookup } from '../src/components/StatusLookup';

const ok = (over: Partial<ComplaintResult> = {}): ComplaintResult => ({
  success: true,
  message: 'ok',
  complaint_code: 'CMP-TEST01',
  priority: 'Medium',
  department: 'billing',
  department_name: 'Billing & Insurance',
  expected_response_hours: 48,
  needs_review: false,
  emergency: false,
  emergency_notice: null,
  spoken_message: 'Your complaint CMP-TEST01 was received.',
  ...over,
});

async function fill(user: ReturnType<typeof userEvent.setup>, details = 'I was charged twice for the same lab test.') {
  await user.type(screen.getByLabelText('Name'), 'Test Patient');
  await user.type(screen.getByLabelText('Phone'), '03001234567');
  await user.type(screen.getByLabelText('Email'), 'patient@example.test');
  await user.selectOptions(screen.getByLabelText('Type'), 'Billing Problems');
  await user.type(screen.getByLabelText('Details'), details);
}

describe('ComplaintForm', () => {
  it('submits the form and shows where the complaint went', async () => {
    const user = userEvent.setup();
    const submit = vi.fn(async (_input: unknown) => ok());
    render(<ComplaintForm submit={submit} />);
    await fill(user);
    await user.click(screen.getByRole('button', { name: 'High' }));
    await user.click(screen.getByRole('button', { name: 'Submit Complaint' }));

    expect(submit).toHaveBeenCalledWith({
      name: 'Test Patient',
      phone: '03001234567',
      email: 'patient@example.test',
      details: 'I was charged twice for the same lab test.',
      type: 'Billing Problems',
      priority: 'High',
      channel: 'web',
    });
    expect(await screen.findByText('Complaint received')).toBeTruthy();
    expect(screen.getByText('Sent to Billing & Insurance')).toBeTruthy();
    expect(screen.getByText('CMP-TEST01')).toBeTruthy();
    expect(screen.getByText('48 hours')).toBeTruthy();
  });

  it('leaves out the priority when the patient does not pick one', async () => {
    const user = userEvent.setup();
    const submit = vi.fn(async (_input: unknown) => ok());
    render(<ComplaintForm submit={submit} />);
    await fill(user);
    await user.click(screen.getByRole('button', { name: 'Submit Complaint' }));
    expect(submit.mock.calls[0]![0]).not.toHaveProperty('priority');
  });

  it('shows the emergency notice first for emergencies', async () => {
    const user = userEvent.setup();
    render(<ComplaintForm submit={async () => ok({ emergency: true, priority: 'High', department_name: 'Emergency Department', emergency_notice: 'If this is happening now, call 1122.' })} />);
    await fill(user, 'My father has chest pain and nobody is helping.');
    await user.click(screen.getByRole('button', { name: 'Submit Complaint' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('call 1122');
  });

  it('shows the API error and keeps what was typed', async () => {
    const user = userEvent.setup();
    render(
      <ComplaintForm
        submit={async () => {
          throw new ApiError(409, 'DUPLICATE', 'We already received this complaint.');
        }}
      />,
    );
    await fill(user);
    await user.click(screen.getByRole('button', { name: 'Submit Complaint' }));
    expect((await screen.findByRole('alert')).textContent).toBe('We already received this complaint.');
    expect((screen.getByLabelText('Details') as HTMLTextAreaElement).value).toContain('charged twice');
  });

  it('marks the complaint as voice when the details came from a recording', async () => {
    const user = userEvent.setup();
    const submit = vi.fn(async (_input: unknown) => ok());
    // jsdom has no MediaRecorder; give it a minimal fake.
    class FakeRecorder {
      static isTypeSupported = () => true;
      state = 'inactive';
      ondataavailable: ((e: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      start() {
        this.state = 'recording';
      }
      stop() {
        this.state = 'inactive';
        this.ondataavailable?.({ data: new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])]) });
        this.onstop?.();
      }
    }
    vi.stubGlobal('MediaRecorder', FakeRecorder);
    Object.defineProperty(navigator, 'mediaDevices', { value: {}, configurable: true });
    const stream = { getTracks: () => [{ stop: vi.fn() }] } as unknown as MediaStream;
    const transcribe = vi.fn(async () => ({ success: true as const, transcript: 'The ward was dirty all night.', language: 'en' }));

    render(<ComplaintForm submit={submit} transcribe={transcribe} />);
    // Recorder needs getStream; ComplaintForm passes the default, so stub getUserMedia.
    (navigator.mediaDevices as unknown as { getUserMedia: () => Promise<MediaStream> }).getUserMedia = async () => stream;

    await user.type(screen.getByLabelText('Name'), 'Test Patient');
    await user.type(screen.getByLabelText('Phone'), '03001234567');
    await user.type(screen.getByLabelText('Email'), 'patient@example.test');
    await user.click(screen.getByRole('button', { name: /Speak instead/ }));
    await user.click(await screen.findByRole('button', { name: /Stop recording/ }));
    expect(await screen.findByDisplayValue('The ward was dirty all night.')).toBeTruthy();
    expect(transcribe).toHaveBeenCalledWith(expect.any(String), 'audio/webm;codecs=opus');

    await user.click(screen.getByRole('button', { name: 'Submit Complaint' }));
    expect(submit.mock.calls[0]![0]).toMatchObject({ channel: 'voice', details: 'The ward was dirty all night.' });
    vi.unstubAllGlobals();
  });
});

describe('StatusLookup', () => {
  it('looks up by email or phone and shows the status', async () => {
    const user = userEvent.setup();
    const lookup = vi.fn(async () => ({
      success: true as const,
      complaint_code: 'CMP-TEST01',
      status: 'In Review' as const,
      priority: 'Medium' as const,
      department_name: 'Billing & Insurance',
      submitted_at: '2026-11-20T10:00:00Z',
      spoken_message: 'In review.',
    }));
    render(<StatusLookup lookup={lookup} />);
    await user.type(screen.getByLabelText('Complaint code'), 'cmp-test01');
    await user.type(screen.getByLabelText('Email or phone you used'), 'patient@example.test');
    await user.click(screen.getByRole('button', { name: 'Check status' }));
    expect(lookup).toHaveBeenCalledWith('CMP-TEST01', { email: 'patient@example.test' });
    expect(await screen.findByText('In Review')).toBeTruthy();

    await user.clear(screen.getByLabelText('Email or phone you used'));
    await user.type(screen.getByLabelText('Email or phone you used'), '03001234567');
    await user.click(screen.getByRole('button', { name: 'Check status' }));
    expect(lookup).toHaveBeenLastCalledWith('CMP-TEST01', { phone: '03001234567' });
  });

  it('gives a friendly message when nothing matches', async () => {
    const user = userEvent.setup();
    render(
      <StatusLookup
        lookup={async () => {
          throw new ApiError(404, 'NOT_FOUND', 'not found');
        }}
      />,
    );
    await user.type(screen.getByLabelText('Complaint code'), 'CMP-NOPE00');
    await user.type(screen.getByLabelText('Email or phone you used'), 'x@example.test');
    await user.click(screen.getByRole('button', { name: 'Check status' }));
    expect((await screen.findByRole('alert')).textContent).toBe('No complaint matches that code and contact detail.');
  });
});

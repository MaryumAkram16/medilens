import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, type Accuracy, type ComplaintRow, type Summary } from '../src/api';
import { StaffDesk } from '../src/components/StaffDesk';

const row = (over: Partial<ComplaintRow>): ComplaintRow => ({
  complaint_code: 'CMP-TEST01',
  patient_name: 'Test Patient',
  email: 'patient@example.test',
  phone: '03001234567',
  details: 'Charged twice for a lab test.',
  channel: 'web',
  priority: 'Medium',
  priority_hint: null,
  department_code: 'billing',
  category: 'Billing',
  sentiment: 'negative',
  suggested_action: 'Refund the duplicate charge.',
  confidence: 0.92,
  triage_source: 'ai',
  emergency: false,
  needs_review: false,
  status: 'Pending',
  created_at: '2026-11-20T10:00:00Z',
  ...over,
});

const summaryData: Summary = {
  summary: { total: 2, pending: 2, resolved: 0, highPriority: 1, needsReview: 1, emergency: 0, byDepartment: { billing: 1, nursing: 1 } },
  data: [row({}), row({ complaint_code: 'CMP-TEST02', patient_name: 'Second Patient', details: 'Ward was noisy', department_code: 'patient_relations', needs_review: true, confidence: 0.4, priority: 'High' })],
};
const accuracyData: Accuracy = {
  reviewed: 4,
  by_source: { ai: { reviewed: 4, both_correct: 3, accuracy: 0.75 }, keywords: { reviewed: 0, both_correct: 0, accuracy: null } },
  recent_corrections: [{ complaint_code: 'CMP-OLD001', triage_source: 'ai', from: 'billing', to: 'pharmacy' }],
};

describe('StaffDesk', () => {
  it('asks for the key, then shows KPIs, rows and corrections', async () => {
    const user = userEvent.setup();
    const summary = vi.fn(async () => summaryData);
    render(<StaffDesk summary={summary} accuracy={async () => accuracyData} update={vi.fn()} />);

    await user.type(screen.getByLabelText('Staff key'), 'test-key');
    await user.click(screen.getByRole('button', { name: 'Open desk' }));
    expect(summary).toHaveBeenCalledWith('test-key');
    expect(await screen.findByText('Second Patient')).toBeTruthy();
    expect(screen.getByText('75%')).toBeTruthy();
    expect(screen.getByText('3/4 confirmed')).toBeTruthy();
    expect(screen.getByText('CMP-OLD001')).toBeTruthy();
    expect(window.sessionStorage.getItem('medilens.staffKey')).toBe('test-key');
  });

  it('filters to complaints that need review', async () => {
    const user = userEvent.setup();
    window.sessionStorage.setItem('medilens.staffKey', 'test-key');
    render(<StaffDesk summary={async () => summaryData} accuracy={async () => accuracyData} update={vi.fn()} />);
    await screen.findByText('Second Patient');
    await user.selectOptions(screen.getByLabelText('Filter'), 'review');
    expect(screen.queryByText('Test Patient')).toBeNull();
    expect(screen.getByText('Second Patient')).toBeTruthy();
  });

  it('confirms a row, or saves only the fields that changed', async () => {
    const user = userEvent.setup();
    window.sessionStorage.setItem('medilens.staffKey', 'test-key');
    const update = vi.fn(async () => ({ success: true as const, review: 'corrected', notified: ['patient'] }));
    render(<StaffDesk summary={async () => summaryData} accuracy={async () => accuracyData} update={update} />);
    await screen.findByText('Second Patient');

    const first = screen.getByText('CMP-TEST01').closest('tr')!;
    await user.click(within(first).getByRole('button', { name: 'Confirm' }));
    expect(update).toHaveBeenLastCalledWith('test-key', { complaint_code: 'CMP-TEST01', confirm: true });

    const second = screen.getByText('CMP-TEST02').closest('tr')!;
    await user.selectOptions(within(second).getByLabelText('Department for CMP-TEST02'), 'facilities');
    await user.click(within(second).getByRole('button', { name: 'Save' }));
    expect(update).toHaveBeenLastCalledWith('test-key', { complaint_code: 'CMP-TEST02', department: 'facilities' });
    expect(await screen.findByText(/CMP-TEST02: corrected · notified patient/)).toBeTruthy();
  });

  it('forgets a rejected key and asks again', async () => {
    window.sessionStorage.setItem('medilens.staffKey', 'wrong');
    render(
      <StaffDesk
        summary={async () => {
          throw new ApiError(401, 'UNAUTHORIZED', 'nope');
        }}
        accuracy={async () => accuracyData}
        update={vi.fn()}
      />,
    );
    expect((await screen.findByRole('alert')).textContent).toBe('That staff key was not accepted.');
    expect(screen.getByLabelText('Staff key')).toBeTruthy();
    expect(window.sessionStorage.getItem('medilens.staffKey')).toBeNull();
  });
});

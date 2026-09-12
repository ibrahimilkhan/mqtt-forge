import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { PanelShell } from './PanelShell';
import { QosSelect } from './QosSelect';

describe('PanelShell', () => {
  it('names its close button after the panel, so screen readers can tell them apart', async () => {
    const onClose = vi.fn();
    render(
      <PanelShell title="Broker" onClose={onClose}>
        <p>body</p>
      </PanelShell>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Close Broker panel' }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('QosSelect', () => {
  it('marks the current level and reports the one clicked', async () => {
    const onChange = vi.fn();
    render(<QosSelect name="qos" value={0} onChange={onChange} />);

    expect(screen.getByRole('radio', { name: 'QoS 0' })).toBeChecked();
    await userEvent.click(screen.getByRole('radio', { name: 'QoS 2' }));

    expect(onChange).toHaveBeenCalledWith(2);
  });

  /**
   * The word once, then the levels.
   *
   * Every option used to carry the whole name — QoS 0, QoS 1, QoS 2 — which is the name of the
   * thing printed on every value of it. What a reader chooses between is 0, 1 and 2.
   */
  it('says QoS once, in front of the three it is about', () => {
    render(<QosSelect name="qos" value={1} onChange={vi.fn()} />);

    const group = screen.getByRole('radiogroup', { name: 'QoS' });
    expect(group).toHaveTextContent(/^QoS\s*0\s*1\s*2$/);
    expect(within(group).getAllByRole('radio').map((radio) => radio.parentElement?.textContent?.trim()))
      .toEqual(['0', '1', '2']);
  });

  // And a control announced as '0' is a control nobody can place, so each keeps the full name for
  // anyone who is not looking at the row.
  it('leaves every level nameable on its own', () => {
    render(<QosSelect name="qos" value={1} onChange={vi.fn()} />);

    expect(screen.getByRole('radio', { name: 'QoS 1' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'QoS 0' })).not.toBeChecked();
    expect(screen.getByRole('radio', { name: 'QoS 2' })).not.toBeChecked();
  });
});

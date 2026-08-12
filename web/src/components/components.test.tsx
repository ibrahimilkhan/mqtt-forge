import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { PanelShell } from './PanelShell';
import { QosSelect } from './QosSelect';
import { StatusReadout } from './StatusReadout';

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
});

describe('StatusReadout', () => {
  it('shows the state in upper case', () => {
    render(<StatusReadout state="Connected" />);

    expect(screen.getByText('CONNECTED')).toBeInTheDocument();
  });

  it('says it is reconnecting whatever the broker state was', () => {
    render(<StatusReadout state="Connected" reconnecting />);

    expect(screen.getByText('RECONNECTING')).toBeInTheDocument();
  });

  it('shows the bare state when there is no connection', () => {
    render(<StatusReadout state="Faulted" />);

    expect(screen.getByText('FAULTED')).toBeInTheDocument();
  });
});

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MobilePanel } from './MobilePanel';

// The address normally comes from the dev server through the virtual module, which has
// nothing to report under the test runner; the getter lets each test choose.
const network = vi.hoisted(() => ({ url: null as string | null }));
vi.mock('virtual:network-url', () => ({
  get networkUrl() {
    return network.url;
  },
}));

beforeEach(() => {
  network.url = 'https://mq.local:5173/';
});

describe('MobilePanel', () => {
  it('encodes the address the dev server is reachable at', () => {
    render(<MobilePanel onClose={vi.fn()} />);

    expect(screen.getByRole('img', { name: 'QR code for https://mq.local:5173/' })).toBeInTheDocument();
    expect(screen.getByText('https://mq.local:5173/')).toBeInTheDocument();
  });

  it('copies the address so it can be sent to a device that cannot scan', async () => {
    const user = userEvent.setup();
    render(<MobilePanel onClose={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Copy address' }));

    await expect(navigator.clipboard.readText()).resolves.toBe('https://mq.local:5173/');
    expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument();
  });

  it('explains itself instead of encoding a loopback address', () => {
    network.url = null;
    render(<MobilePanel onClose={vi.fn()} />);

    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getByText(/no other device can reach/)).toBeInTheDocument();
  });
});

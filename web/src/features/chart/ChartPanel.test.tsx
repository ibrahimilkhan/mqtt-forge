import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
// The panel reads where saved readings go through react-query, so it needs a client.
import { renderWithClient as render } from '../../test/renderWithClient';
import { useAppearanceStore } from '../../stores/appearanceStore';
import { CHIP, CONTROL_IDS, CONTROLS } from '../appearance/controls';
import { SCALES } from '../../lib/scale';
import { READING_IDS, READINGS } from '../appearance/readings';
import { ChartPanel } from './ChartPanel';

beforeEach(() => {
  localStorage.clear();
  useAppearanceStore.getState().reset();
});

const panel = () => render(<ChartPanel onClose={() => {}} />);

describe('ChartPanel', () => {
  it('keeps the chosen range', async () => {
    panel();

    await userEvent.selectOptions(screen.getByLabelText('Range'), 'extremes');

    expect(useAppearanceStore.getState().scale).toBe('extremes');
  });

  // How much of the note to draw used to be a second control beside the switches below, asking
  // the same question in fewer words. The switches are the answer, so the select went.
  it('leaves how much to draw to the switches, not to a second control', () => {
    panel();

    expect(screen.queryByLabelText('Detail')).not.toBeInTheDocument();
  });
});

describe('the chips over the plot, and what they do', () => {
  // Each is three or four characters, because the row shares a pane that can be 200px wide. A
  // `title` is the only explanation they had, and a tooltip is a thing you have to already
  // suspect is there.
  it('says in words what every chip over the plot does', () => {
    panel();

    for (const id of CONTROL_IDS) {
      expect(screen.getByText(CONTROLS[id].what, { exact: false })).toBeInTheDocument();
    }
  });

  it('prints each chip exactly as the chart prints it', () => {
    panel();

    for (const id of CONTROL_IDS) {
      expect(screen.getByText(CONTROLS[id].label)).toBeInTheDocument();
    }
  });

  // The ranges already describe themselves where the chart draws them from, so the panel prints
  // that rather than a second copy that can drift.
  it('takes the ranges from the same catalogue the chart draws them from', () => {
    panel();

    for (const [id, range] of Object.entries(SCALES)) {
      expect(screen.getByText(CHIP[id as keyof typeof CHIP])).toBeInTheDocument();
      expect(screen.getByText(range.hint)).toBeInTheDocument();
    }
  });
});

describe('the readings, and what they mean', () => {
  // The note prints labels three or four characters long. A reader who does not already know what
  // 'spread' or 'duty' stands for has nowhere else to find out.
  it('says in words what every reading the note can make means', () => {
    panel();

    for (const id of READING_IDS) {
      expect(screen.getByText(READINGS[id].what)).toBeInTheDocument();
    }
  });

  it('groups them by the kind of run they apply to', () => {
    panel();

    const events = screen.getByRole('group', { name: /A switch or a pulse/ });
    expect(within(events).getByText(READINGS.duty.what)).toBeInTheDocument();
    expect(within(events).queryByText(READINGS.mean.what)).not.toBeInTheDocument();
  });

  it('switches one off and remembers it', async () => {
    panel();

    await userEvent.click(screen.getByRole('checkbox', { name: 'mean' }));

    expect(useAppearanceStore.getState().readings.mean).toBe(false);
  });

  // Only what the reader has actually touched is stored, so a reading added in a later release
  // does not need every stored preference rewritten to know whether to draw it.
  it('stores only the readings that were switched', async () => {
    panel();

    await userEvent.click(screen.getByRole('checkbox', { name: 'skipped' }));

    expect(useAppearanceStore.getState().readings).toEqual({ skipped: false });
  });

  it('puts every reading back', async () => {
    panel();

    await userEvent.click(screen.getByRole('checkbox', { name: 'median' }));
    await userEvent.click(screen.getByRole('button', { name: 'Restore every reading' }));

    expect(useAppearanceStore.getState().readings).toEqual({});
    expect(screen.getByRole('checkbox', { name: 'median' })).toBeChecked();
  });

  // The numbers behind the fences the chart already draws — most readers never need them
  // spelled out, and the switch beside them is right there for the ones who do.
  it('shows the quartile readings as off until the reader asks for them', async () => {
    panel();
    expect(screen.getByRole('checkbox', { name: 'quartiles' })).not.toBeChecked();

    await userEvent.click(screen.getByRole('checkbox', { name: 'quartiles' }));

    expect(screen.getByRole('checkbox', { name: 'quartiles' })).toBeChecked();
  });
});

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

    await userEvent.click(screen.getByRole('radio', { name: 'Extremes' }));

    expect(useAppearanceStore.getState().scale).toBe('extremes');
  });

  // All three stand open, so the one that is on has to say so itself — a select did that by
  // being the only one printed.
  it('marks the range that is on', async () => {
    panel();
    expect(screen.getByRole('radio', { name: 'Typical' })).toBeChecked();

    await userEvent.click(screen.getByRole('radio', { name: 'Logarithmic' }));

    expect(screen.getByRole('radio', { name: 'Logarithmic' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Typical' })).not.toBeChecked();
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
      expect(screen.getByText(range.hint, { exact: false })).toBeInTheDocument();
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

    const events = screen.getByRole('group', { name: /Switches and pulses/ });
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
    await userEvent.click(screen.getByRole('button', { name: 'Restore defaults' }));

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

describe('finding one reading among two dozen', () => {
  // The name is the part a reader is here for not knowing, so the filter has to look in the
  // meanings too: someone after the standard deviation does not know to type 'spread'.
  it('finds a reading by what it means as well as by what it is called', async () => {
    panel();

    await userEvent.type(screen.getByRole('searchbox', { name: 'Filter readings' }), 'deviation');

    expect(screen.getByRole('checkbox', { name: 'spread' })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'mean' })).not.toBeInTheDocument();
    // A group with nothing left in it goes with its readings rather than standing empty.
    expect(screen.queryByRole('group', { name: /Switches and pulses/ })).not.toBeInTheDocument();
  });

  it('says so when nothing matches', async () => {
    panel();

    await userEvent.type(screen.getByRole('searchbox', { name: 'Filter readings' }), 'zzz');

    expect(screen.getByText('No reading matches the filter.')).toBeInTheDocument();
  });
});

describe('what has been changed, and putting it back', () => {
  // A reset that is always live says nothing about whether there is anything to reset.
  it('offers the reset only once something has been changed', async () => {
    panel();
    expect(screen.getByRole('button', { name: 'Restore defaults' })).toBeDisabled();

    await userEvent.click(screen.getByRole('checkbox', { name: 'mean' }));

    expect(screen.getByRole('button', { name: 'Restore defaults' })).toBeEnabled();
    expect(screen.getByText(/1 changed/)).toBeInTheDocument();
  });

  // Switched off and then on again is back as it shipped, whatever the store now holds for it.
  it('counts a reading put back by hand as not changed', async () => {
    panel();

    await userEvent.click(screen.getByRole('checkbox', { name: 'mean' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'mean' }));

    expect(screen.queryByText(/changed/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Restore defaults' })).toBeDisabled();
  });

  it('switches a whole group off, and stores only the ones that moved', async () => {
    panel();

    await userEvent.click(screen.getByRole('button', { name: 'None on — Switches and pulses' }));

    expect(useAppearanceStore.getState().readings).toEqual({
      levels: false,
      events: false,
      duty: false,
      width: false,
      period: false,
    });
  });

  // quartiles and fences ship off, so they are the only two 'all' has to touch.
  it('switches a whole group on, and stores only the ones that moved', async () => {
    panel();

    await userEvent.click(screen.getByRole('button', { name: 'All on — Measurements' }));

    expect(useAppearanceStore.getState().readings).toEqual({ quartiles: true, fences: true });
  });
});

describe('the preview, since the panel covers the chart', () => {
  const preview = () => within(screen.getByTestId('chart-preview'));
  const sampleRadio = (name: string) => screen.getByRole('radio', { name });

  // It is the chart's own note, so a switch does to it exactly what it does to the real one.
  it('prints a reading under the sample when its switch goes on, and not before', async () => {
    panel();
    expect(preview().queryByTestId('reading-quartiles')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('checkbox', { name: 'quartiles' }));

    expect(preview().getByTestId('reading-quartiles')).toBeInTheDocument();
  });

  // A switch pressed with nothing to show for it reads as a switch that is broken.
  it('brings up the sample a reading appears under when that reading is switched on', async () => {
    panel();
    expect(sampleRadio('Measurement')).toBeChecked();

    await userEvent.click(screen.getByRole('checkbox', { name: 'duty' }));
    expect(sampleRadio('Measurement')).toBeChecked();

    await userEvent.click(screen.getByRole('checkbox', { name: 'duty' }));

    expect(sampleRadio('Switch')).toBeChecked();
    expect(preview().getByTestId('reading-duty')).toBeInTheDocument();
    expect(preview().getByText(/Showing the switch sample/)).toBeInTheDocument();
  });

  it('draws a switch on its extremes whatever range was chosen', async () => {
    panel();

    await userEvent.click(screen.getByRole('radio', { name: 'Logarithmic' }));
    await userEvent.click(sampleRadio('Switch'));

    expect(preview().getByText(/drawn on their extremes/)).toBeInTheDocument();
    // The note names a fallback only when the range asked for could not be used. Nothing was
    // asked of a switch but its extremes, so there is nothing to name.
    expect(preview().getByTestId('reading-scale')).toHaveTextContent('—');
  });

  it('points at the cell a switch puts away while the pointer is on that switch', async () => {
    panel();

    await userEvent.hover(screen.getByRole('checkbox', { name: 'median' }));

    expect(preview().getByTestId('reading-median').parentElement).toHaveAttribute('data-hot');
    expect(preview().getByTestId('reading-mean').parentElement).not.toHaveAttribute('data-hot');
  });
});

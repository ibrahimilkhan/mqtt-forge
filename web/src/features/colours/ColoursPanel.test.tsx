import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useLogStore } from '../../stores/logStore';
import { renderWithClient as render } from '../../test/renderWithClient';
import { server } from '../../test/server';
import { ColoursPanel } from './ColoursPanel';
import { PALETTE, SUGGESTED } from './palette';

const stored = (...rules: Array<{ filter: string; colour: string }>) =>
  server.use(http.get('/api/colour-rules', () => HttpResponse.json({ rules })));

/**
 * Captures what the panel sends, so a test can assert on the saved list — and answers the next
 * GET with it, the way the API does. Without that the refetch after a save hands back the list
 * from before it, and the panel is right to say the edits are still unsaved.
 */
function capturePut() {
  const sent: Array<Array<{ filter: string; colour: string }>> = [];

  server.use(
    http.put('/api/colour-rules', async ({ request }) => {
      const body = (await request.json()) as { rules: Array<{ filter: string; colour: string }> };
      sent.push(body.rules);
      server.use(http.get('/api/colour-rules', () => HttpResponse.json({ rules: body.rules })));
      return new HttpResponse(null, { status: 204 });
    }),
  );

  return sent;
}

const renderPanel = () => render(<ColoursPanel onClose={vi.fn()} />);

const rows = () => screen.getAllByTestId('colour-rule');
const filterBox = (row: HTMLElement) => within(row).getByRole('textbox');
const saveButton = () => screen.getByRole('button', { name: 'Save' });
const addButton = () => screen.getByRole('button', { name: 'Add rule' });

beforeEach(() => useLogStore.getState().clear());

describe('ColoursPanel', () => {
  it('says so plainly when no rule has been made yet', async () => {
    renderPanel();

    expect(await screen.findByText(/No colour rules yet/)).toBeInTheDocument();
  });

  it('lists the stored rules', async () => {
    stored({ filter: 'sensors/+/temp', colour: '#b45309' }, { filter: 'alerts/#', colour: '#ab3520' });
    renderPanel();

    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(filterBox(rows()[0])).toHaveValue('sensors/+/temp');
    expect(filterBox(rows()[1])).toHaveValue('alerts/#');
  });

  it('adds a row carrying the first unused suggested colour', async () => {
    stored({ filter: 'alerts/#', colour: SUGGESTED[0] });
    renderPanel();
    await waitFor(() => expect(rows()).toHaveLength(1));

    await userEvent.click(addButton());

    expect(rows()).toHaveLength(2);
    expect(within(rows()[1]).getByTestId('swatch')).toHaveStyle({ background: SUGGESTED[1] });
  });

  it('saves what was typed', async () => {
    const sent = capturePut();
    renderPanel();
    await waitFor(() => expect(addButton()).toBeEnabled());

    await userEvent.click(addButton());
    await userEvent.type(filterBox(rows()[0]), 'sensors/+/temp');
    await userEvent.click(saveButton());

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual([{ filter: 'sensors/+/temp', colour: SUGGESTED[0] }]);
  });

  it('picks a colour from the suggestions', async () => {
    const sent = capturePut();
    renderPanel();
    await waitFor(() => expect(addButton()).toBeEnabled());
    await userEvent.click(addButton());
    await userEvent.type(filterBox(rows()[0]), 'alerts/#');

    await userEvent.click(within(rows()[0]).getByRole('button', { name: /Choose a colour/ }));
    await userEvent.click(screen.getByRole('button', { name: PALETTE[3].name }));
    await userEvent.click(saveButton());

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual([{ filter: 'alerts/#', colour: SUGGESTED[3] }]);
  });

  it('takes a colour the picker offers that the suggestions do not', async () => {
    const sent = capturePut();
    renderPanel();
    await waitFor(() => expect(addButton()).toBeEnabled());
    await userEvent.click(addButton());
    await userEvent.type(filterBox(rows()[0]), 'alerts/#');

    await userEvent.click(within(rows()[0]).getByRole('button', { name: /Choose a colour/ }));
    // Typed rather than clicked in a real browser; a colour input takes its value whole, and
    // userEvent cannot drive the native picker jsdom does not have.
    fireEvent.input(screen.getByLabelText('Custom colour'), { target: { value: '#123456' } });
    await userEvent.click(saveButton());

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual([{ filter: 'alerts/#', colour: '#123456' }]);
  });

  it('removes a rule', async () => {
    const sent = capturePut();
    stored({ filter: 'a/#', colour: '#b45309' }, { filter: 'b/#', colour: '#ab3520' });
    renderPanel();
    await waitFor(() => expect(rows()).toHaveLength(2));

    await userEvent.click(within(rows()[0]).getByRole('button', { name: /Remove/ }));
    await userEvent.click(saveButton());

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual([{ filter: 'b/#', colour: '#ab3520' }]);
  });

  describe('a rule that cannot be saved', () => {
    it('will not save a filter left empty', async () => {
      renderPanel();
      await waitFor(() => expect(addButton()).toBeEnabled());

      await userEvent.click(addButton());

      expect(saveButton()).toBeDisabled();
      expect(within(rows()[0]).getByText(/cannot be empty/i)).toBeInTheDocument();
    });

    it('says why a malformed filter is refused', async () => {
      renderPanel();
      await waitFor(() => expect(addButton()).toBeEnabled());
      await userEvent.click(addButton());

      await userEvent.type(filterBox(rows()[0]), 'a/#/b');

      expect(saveButton()).toBeDisabled();
      expect(within(rows()[0]).getByText(/'#' can only be the last segment/i)).toBeInTheDocument();
    });

    it('says why a lone + in the middle of a word is refused', async () => {
      renderPanel();
      await waitFor(() => expect(addButton()).toBeEnabled());
      await userEvent.click(addButton());

      await userEvent.type(filterBox(rows()[0]), 'sensor+/x');

      expect(saveButton()).toBeDisabled();
      expect(within(rows()[0]).getByText(/'\+' has to be a whole segment/i)).toBeInTheDocument();
    });

    it('refuses two rules on the same filter', async () => {
      stored({ filter: 'a/#', colour: '#b45309' });
      renderPanel();
      await waitFor(() => expect(rows()).toHaveLength(1));

      await userEvent.click(addButton());
      await userEvent.type(filterBox(rows()[1]), 'a/#');

      expect(saveButton()).toBeDisabled();
      expect(within(rows()[1]).getByText(/already has a colour/i)).toBeInTheDocument();
    });

    it('lets the rule be saved once the filter is fixed', async () => {
      const sent = capturePut();
      renderPanel();
      await waitFor(() => expect(addButton()).toBeEnabled());
      await userEvent.click(addButton());
      await userEvent.type(filterBox(rows()[0]), 'a/#/b');
      expect(saveButton()).toBeDisabled();

      await userEvent.clear(filterBox(rows()[0]));
      await userEvent.type(filterBox(rows()[0]), 'a/#');

      expect(saveButton()).toBeEnabled();
      await userEvent.click(saveButton());
      await waitFor(() => expect(sent).toHaveLength(1));
    });
  });

  describe('reporting', () => {
    it('logs the save', async () => {
      capturePut();
      stored({ filter: 'a/#', colour: '#b45309' });
      renderPanel();
      await waitFor(() => expect(rows()).toHaveLength(1));

      await userEvent.click(saveButton());

      await waitFor(() => expect(useLogStore.getState().entries).toHaveLength(1));
      expect(useLogStore.getState().entries[0]).toMatchObject({ kind: 'ok', verb: 'Colours saved' });
    });

    it('logs a save the server refused, and keeps what was typed', async () => {
      server.use(
        http.put('/api/colour-rules', () =>
          HttpResponse.json({ title: 'Bad Request', detail: 'nope' }, { status: 400 }),
        ),
      );
      renderPanel();
      await waitFor(() => expect(addButton()).toBeEnabled());
      await userEvent.click(addButton());
      await userEvent.type(filterBox(rows()[0]), 'a/#');

      await userEvent.click(saveButton());

      await waitFor(() => expect(useLogStore.getState().entries).toHaveLength(1));
      expect(useLogStore.getState().entries[0]).toMatchObject({ kind: 'fault', verb: 'Colours not saved' });
      expect(filterBox(rows()[0])).toHaveValue('a/#');
    });
  });

  it('leaves Save alone while nothing has been touched', async () => {
    stored({ filter: 'a/#', colour: '#b45309' });
    renderPanel();

    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(saveButton()).toBeEnabled();
  });
});

describe('the colour popover', () => {
  const openPicker = async () => {
    await userEvent.click(addButton());
    await userEvent.click(within(rows()[0]).getByRole('button', { name: /Choose a colour/ }));
  };

  it('closes on Escape, leaving the colour as it was', async () => {
    renderPanel();
    await waitFor(() => expect(addButton()).toBeEnabled());
    await openPicker();
    expect(screen.getByLabelText('Custom colour')).toBeInTheDocument();

    await userEvent.keyboard('{Escape}');

    expect(screen.queryByLabelText('Custom colour')).not.toBeInTheDocument();
    expect(within(rows()[0]).getByTestId('swatch')).toHaveStyle({ background: SUGGESTED[0] });
  });

  it('closes when the click lands somewhere else', async () => {
    renderPanel();
    await waitFor(() => expect(addButton()).toBeEnabled());
    await openPicker();

    await userEvent.click(filterBox(rows()[0]));

    expect(screen.queryByLabelText('Custom colour')).not.toBeInTheDocument();
  });

  it('marks the colour the rule is already wearing', async () => {
    stored({ filter: 'a/#', colour: SUGGESTED[2] });
    renderPanel();
    await waitFor(() => expect(rows()).toHaveLength(1));

    await userEvent.click(within(rows()[0]).getByRole('button', { name: /Choose a colour/ }));

    expect(screen.getByRole('button', { name: PALETTE[2].name })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: PALETTE[0].name })).toHaveAttribute('aria-pressed', 'false');
  });
});

describe('the rule ceiling', () => {
  const hundred = Array.from({ length: 100 }, (_, i) => ({ filter: `topic/${i}`, colour: '#1e40af' }));

  // The API refuses the 101st. Saying so here means the answer arrives before the round trip,
  // and as a sentence rather than as a 400.
  it('stops at a hundred rules and says why', async () => {
    stored(...hundred);
    renderPanel();
    await waitFor(() => expect(rows()).toHaveLength(100));

    expect(addButton()).toBeDisabled();
    expect(screen.getByText(/hundred colour rules/i)).toBeInTheDocument();
  });

  it('lets one be added again once a rule is removed', async () => {
    stored(...hundred);
    renderPanel();
    await waitFor(() => expect(rows()).toHaveLength(100));

    await userEvent.click(within(rows()[0]).getByRole('button', { name: /Remove/ }));

    expect(addButton()).toBeEnabled();
    expect(screen.queryByText(/hundred colour rules/i)).not.toBeInTheDocument();
  });
});

// The save is not idempotent from the user's side: two PUTs mean two log entries and two
// round trips for one intention.
it('sends one request when Save is clicked twice in the same tick', async () => {
  const sent = capturePut();
  stored({ filter: 'a/#', colour: '#b45309' });
  renderPanel();
  await waitFor(() => expect(rows()).toHaveLength(1));

  fireEvent.click(saveButton());
  fireEvent.click(saveButton());

  await waitFor(() => expect(sent).toHaveLength(1));
  expect(sent).toHaveLength(1);
});

// The file can be hand-edited past the API's validation, and what it then holds must not reach
// an inline style or a colour input. The tree already refuses such a rule; the panel is where
// it can be repaired.
describe('a stored colour the panel cannot use', () => {
  it('shows a usable colour instead of the nonsense in the file', async () => {
    stored({ filter: 'a/#', colour: 'red; background: url(x)' });
    renderPanel();

    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(within(rows()[0]).getByTestId('swatch')).toHaveStyle({ background: SUGGESTED[0] });
  });

  it('keeps the filter, which is the part worth keeping', async () => {
    stored({ filter: 'a/#', colour: 'nonsense' });
    renderPanel();

    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(filterBox(rows()[0])).toHaveValue('a/#');
  });

  it('saves the repaired colour rather than writing the nonsense back', async () => {
    const sent = capturePut();
    stored({ filter: 'a/#', colour: 'nonsense' });
    renderPanel();
    await waitFor(() => expect(rows()).toHaveLength(1));

    await userEvent.click(saveButton());

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual([{ filter: 'a/#', colour: SUGGESTED[0] }]);
  });

  it('gives two broken rules different colours rather than the same one', async () => {
    stored({ filter: 'a/#', colour: 'nonsense' }, { filter: 'b/#', colour: 'also nonsense' });
    renderPanel();

    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(within(rows()[0]).getByTestId('swatch')).toHaveStyle({ background: SUGGESTED[0] });
    expect(within(rows()[1]).getByTestId('swatch')).toHaveStyle({ background: SUGGESTED[1] });
  });

  it('normalises a colour written in capitals', async () => {
    stored({ filter: 'a/#', colour: '#B45309' });
    renderPanel();

    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(within(rows()[0]).getByTestId('swatch')).toHaveStyle({ background: '#b45309' });
  });
});

// Closing the panel throws the draft away — the edits live in component state, not the cache.
// Saying so is what makes that honest.
describe('unsaved edits', () => {
  it('says nothing while the rows match what is stored', async () => {
    stored({ filter: 'a/#', colour: '#b45309' });
    renderPanel();

    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(screen.queryByText(/not saved/i)).not.toBeInTheDocument();
  });

  it('says so once a filter has been typed into', async () => {
    stored({ filter: 'a/#', colour: '#b45309' });
    renderPanel();
    await waitFor(() => expect(rows()).toHaveLength(1));

    await userEvent.type(filterBox(rows()[0]), 'b');

    expect(screen.getByText(/not saved/i)).toBeInTheDocument();
  });

  it('says so once a rule has been removed', async () => {
    stored({ filter: 'a/#', colour: '#b45309' });
    renderPanel();
    await waitFor(() => expect(rows()).toHaveLength(1));

    await userEvent.click(within(rows()[0]).getByRole('button', { name: /Remove/ }));

    expect(screen.getByText(/not saved/i)).toBeInTheDocument();
  });

  it('stops saying so once the save lands', async () => {
    capturePut();
    // A filter that is still a filter after the edit; appending to 'a/#' would only prove that
    // Save stays disabled for a malformed one.
    stored({ filter: 'sensors/a', colour: '#b45309' });
    renderPanel();
    await waitFor(() => expect(rows()).toHaveLength(1));
    await userEvent.type(filterBox(rows()[0]), 'b');

    await userEvent.click(saveButton());

    await waitFor(() => expect(screen.queryByText(/not saved/i)).not.toBeInTheDocument());
  });

  // A file edited by hand arrives already needing a save; the repaired colour is a real change.
  it('says so straight away when a stored colour had to be repaired', async () => {
    stored({ filter: 'a/#', colour: 'nonsense' });
    renderPanel();

    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(screen.getByText(/not saved/i)).toBeInTheDocument();
  });
});

import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useLogStore } from '../../stores/logStore';
import { useSelectionStore } from '../../stores/selectionStore';
import { useTopicTreeStore } from '../../stores/topicTreeStore';
import { renderWithClient as render } from '../../test/renderWithClient';
import { server } from '../../test/server';
import { ColoursPanel } from './ColoursPanel';
import { PALETTE, SUGGESTED } from './palette';

type Wire = { filter: string; colour: string; bodyColour?: string | null };

const stored = (...rules: Wire[]) =>
  server.use(http.get('/api/colour-rules', () => HttpResponse.json({ rules })));

/**
 * Captures what the panel sends, so a test can assert on the saved list — and answers the next
 * GET with it, the way the API does. Without that the refetch after a save hands back the list
 * from before it, and the panel is right to say the edits are still unsaved.
 */
function capturePut() {
  const sent: Wire[][] = [];

  server.use(
    http.put('/api/colour-rules', async ({ request }) => {
      const body = (await request.json()) as { rules: Wire[] };
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
// 'Add rule' at the foot of the panel until the list became a page: it is 'New rule' now, on the
// heading's own line, the way the alerts panel offers the same thing.
const addButton = () => screen.getByRole('button', { name: 'New rule' });

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
    expect(sent[0]).toEqual([{ filter: 'sensors/+/temp', colour: SUGGESTED[0], bodyColour: null }]);
  });

  it('picks a colour from the suggestions', async () => {
    const sent = capturePut();
    renderPanel();
    await waitFor(() => expect(addButton()).toBeEnabled());
    await userEvent.click(addButton());
    await userEvent.type(filterBox(rows()[0]), 'alerts/#');

    await userEvent.click(within(rows()[0]).getByRole('button', { name: /Choose a topic colour/ }));
    await userEvent.click(screen.getByRole('button', { name: PALETTE[3].name }));
    await userEvent.click(saveButton());

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual([{ filter: 'alerts/#', colour: SUGGESTED[3], bodyColour: null }]);
  });

  it('takes a colour the picker offers that the suggestions do not', async () => {
    const sent = capturePut();
    renderPanel();
    await waitFor(() => expect(addButton()).toBeEnabled());
    await userEvent.click(addButton());
    await userEvent.type(filterBox(rows()[0]), 'alerts/#');

    await userEvent.click(within(rows()[0]).getByRole('button', { name: /Choose a topic colour/ }));
    // Typed rather than clicked in a real browser; a colour input takes its value whole, and
    // userEvent cannot drive the native picker jsdom does not have.
    fireEvent.input(screen.getByLabelText('Custom colour'), { target: { value: '#123456' } });
    await userEvent.click(saveButton());

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual([{ filter: 'alerts/#', colour: '#123456', bodyColour: null }]);
  });

  it('removes a rule', async () => {
    const sent = capturePut();
    stored({ filter: 'a/#', colour: '#b45309' }, { filter: 'b/#', colour: '#ab3520' });
    renderPanel();
    await waitFor(() => expect(rows()).toHaveLength(2));

    await userEvent.click(within(rows()[0]).getByRole('button', { name: /Remove/ }));
    await userEvent.click(saveButton());

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual([{ filter: 'b/#', colour: '#ab3520', bodyColour: null }]);
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

      await waitFor(() => expect(useLogStore.getState().commands).toHaveLength(1));
      expect(useLogStore.getState().commands[0]).toMatchObject({ kind: 'ok', verb: 'Colours saved' });
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

      await waitFor(() => expect(useLogStore.getState().commands).toHaveLength(1));
      expect(useLogStore.getState().commands[0]).toMatchObject({ kind: 'fault', verb: 'Colours not saved' });
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

/*
 * A colour rule's effect is somewhere else — it paints rows in a tree this panel now covers — so
 * the panel had no way of saying whether a rule was doing anything at all. A filter with a typo
 * in it and a filter painting forty topics were the same row.
 */
describe('what each rule is painting', () => {
  beforeEach(() => {
    useTopicTreeStore.getState().reset();
    act(() =>
      useTopicTreeStore.getState().apply([
        { topic: 'plant/boiler/temp', payload: '1' },
        { topic: 'plant/boiler/flow', payload: '2' },
        { topic: 'plant/kiln/temp', payload: '3' },
        { topic: 'site/gateway/status', payload: '4' },
      ] as never),
    );
  });

  it('counts the topics the rule has taken', async () => {
    stored({ filter: 'plant/#', colour: '#ab3520' });
    renderPanel();

    expect(await screen.findByText('3 topics')).toBeInTheDocument();
  });

  it('counts one topic in the singular', async () => {
    stored({ filter: 'site/gateway/status', colour: '#ab3520' });
    renderPanel();

    expect(await screen.findByText('1 topic')).toBeInTheDocument();
  });

  // The commonest way a colour rule quietly does nothing, and the one thing a list of filters
  // cannot show you: another rule says more about every topic this one covers.
  it('says none for a rule a more specific one has taken every topic off', async () => {
    stored(
      { filter: 'plant/#', colour: '#ab3520' },
      { filter: 'plant/+/+', colour: '#0d7a63' },
    );
    renderPanel();

    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(within(rows()[0]).getByText('none')).toBeInTheDocument();
    expect(within(rows()[1]).getByText('3 topics')).toBeInTheDocument();
  });

  it('answers the filter being typed rather than the one that was saved', async () => {
    stored({ filter: 'plant/#', colour: '#ab3520' });
    renderPanel();

    await waitFor(() => expect(rows()).toHaveLength(1));
    await userEvent.clear(filterBox(rows()[0]));
    await userEvent.type(filterBox(rows()[0]), 'site/#');

    expect(within(rows()[0]).getByText('1 topic')).toBeInTheDocument();
  });

  it('says nothing at all about a row with no filter in it yet', async () => {
    renderPanel();
    await waitFor(() => expect(addButton()).toBeEnabled());
    await userEvent.click(addButton());

    expect(within(rows()[0]).queryByText('none')).not.toBeInTheDocument();
  });
});

/*
 * The panel takes the workspace now, so the tree a colour rule used to be read against is behind
 * it. This is the way back to it: the same glass the alert editor wears, opening the same tree.
 */
describe('reaching the tree from inside the panel', () => {
  // Either wording: the mark is named for what pressing it will do, so it renames itself when
  // the tree under it opens.
  const glass = (row: number) =>
    screen.getByRole('button', {
      name: new RegExp(`^(Show|Hide) topics on the broker for rule ${row}$`),
    });

  beforeEach(() => {
    useTopicTreeStore.getState().reset();
    act(() =>
      useTopicTreeStore.getState().apply([
        { topic: 'plant/boiler/temp', payload: '1' },
        { topic: 'plant/kiln/temp', payload: '2' },
      ] as never),
    );
  });

  it('stays shut until it is asked for', async () => {
    stored({ filter: 'plant/#', colour: '#ab3520' });
    renderPanel();

    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(screen.queryByRole('group', { name: 'Topics on the broker' })).not.toBeInTheDocument();
  });

  it('writes what was picked into that row, and shuts', async () => {
    stored({ filter: 'plant/#', colour: '#ab3520' }, { filter: 'site/#', colour: '#0d7a63' });
    renderPanel();

    await waitFor(() => expect(rows()).toHaveLength(2));
    await userEvent.click(glass(2));
    await userEvent.click(
      within(screen.getByRole('group', { name: 'Topics on the broker' })).getByRole('button', {
        name: 'kiln/#',
      }),
    );

    expect(filterBox(rows()[1])).toHaveValue('plant/kiln/#');
    // And the row above it is untouched.
    expect(filterBox(rows()[0])).toHaveValue('plant/#');
    expect(screen.queryByRole('group', { name: 'Topics on the broker' })).not.toBeInTheDocument();
  });

  it('has one open at a time, so the tree always belongs to a row you can see', async () => {
    stored({ filter: 'plant/#', colour: '#ab3520' }, { filter: 'site/#', colour: '#0d7a63' });
    renderPanel();

    await waitFor(() => expect(rows()).toHaveLength(2));
    await userEvent.click(glass(1));
    await userEvent.click(glass(2));

    expect(screen.getAllByRole('group', { name: 'Topics on the broker' })).toHaveLength(1);
    expect(glass(1)).toHaveAttribute('aria-expanded', 'false');
    expect(glass(2)).toHaveAttribute('aria-expanded', 'true');
  });

  it('takes the tree away with the row it was opened on', async () => {
    stored({ filter: 'plant/#', colour: '#ab3520' });
    renderPanel();

    await waitFor(() => expect(rows()).toHaveLength(1));
    await userEvent.click(glass(1));
    await userEvent.click(screen.getByRole('button', { name: 'Remove the rule for plant/#' }));

    expect(screen.queryByRole('group', { name: 'Topics on the broker' })).not.toBeInTheDocument();
  });
});

describe('the colour popover', () => {
  const openPicker = async () => {
    await userEvent.click(addButton());
    await userEvent.click(within(rows()[0]).getByRole('button', { name: /Choose a topic colour/ }));
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

    await userEvent.click(within(rows()[0]).getByRole('button', { name: /Choose a topic colour/ }));

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
    expect(sent[0]).toEqual([{ filter: 'a/#', colour: SUGGESTED[0], bodyColour: null }]);
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

// Without the stored list there is nothing to edit and nothing safe to send: a save from an
// empty panel would replace rules it never managed to read.
describe('when the rules cannot be read', () => {
  const unreadable = () =>
    server.use(http.get('/api/colour-rules', () => new HttpResponse(null, { status: 500 })));

  it('says so rather than showing an empty list', async () => {
    unreadable();
    renderPanel();

    expect(await screen.findByText(/could not be read/i)).toBeInTheDocument();
    expect(screen.queryByText(/No colour rules yet/)).not.toBeInTheDocument();
  });

  it('offers neither adding nor saving', async () => {
    unreadable();
    renderPanel();

    await screen.findByText(/could not be read/i);
    expect(addButton()).toBeDisabled();
    expect(saveButton()).toBeDisabled();
  });

  it('recovers once the request succeeds', async () => {
    unreadable();
    const { unmount } = renderPanel();
    await screen.findByText(/could not be read/i);
    unmount();

    stored({ filter: 'a/#', colour: '#b45309' });
    renderPanel();

    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(screen.queryByText(/could not be read/i)).not.toBeInTheDocument();
  });
});

// The tree sits beside this panel, so the topic you are looking at is the one you want a rule
// for. Typing it back out by hand is the step worth removing.
describe('adding a rule for what is selected', () => {
  beforeEach(() => useSelectionStore.getState().clear());

  const selectTopic = (topic: string) =>
    act(() => useSelectionStore.getState().select({ label: topic, filter: topic, topic }));

  it('fills the new row with the selected topic', async () => {
    renderPanel();
    await waitFor(() => expect(addButton()).toBeEnabled());
    selectTopic('sensors/attic/temp');

    await userEvent.click(addButton());

    expect(filterBox(rows()[0])).toHaveValue('sensors/attic/temp');
  });

  it('saves it without anything else being typed', async () => {
    const sent = capturePut();
    renderPanel();
    await waitFor(() => expect(addButton()).toBeEnabled());
    selectTopic('sensors/#');

    await userEvent.click(addButton());
    await userEvent.click(saveButton());

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual([{ filter: 'sensors/#', colour: SUGGESTED[0], bodyColour: null }]);
  });

  it('leaves the row empty when nothing is selected', async () => {
    renderPanel();
    await waitFor(() => expect(addButton()).toBeEnabled());

    await userEvent.click(addButton());

    expect(filterBox(rows()[0])).toHaveValue('');
  });

  // The broker row is a connection, not a topic; it records no topic to colour.
  it('leaves the row empty when the selection is not a topic', async () => {
    renderPanel();
    await waitFor(() => expect(addButton()).toBeEnabled());
    act(() => useSelectionStore.getState().select({ label: 'broker:1883', filter: '#' }));

    await userEvent.click(addButton());

    expect(filterBox(rows()[0])).toHaveValue('');
  });

  // Only the new row: an edit in progress somewhere above it is not the selection's business.
  it('leaves the rows already there alone', async () => {
    stored({ filter: 'alerts/#', colour: '#b45309' });
    renderPanel();
    await waitFor(() => expect(rows()).toHaveLength(1));
    selectTopic('sensors/attic/temp');

    await userEvent.click(addButton());

    expect(filterBox(rows()[0])).toHaveValue('alerts/#');
    expect(filterBox(rows()[1])).toHaveValue('sensors/attic/temp');
  });

  // Prefilled all the same: the duplicate message is the useful answer — that topic is
  // already coloured, and here is the rule doing it.
  it('says so when the selected topic already has a rule', async () => {
    stored({ filter: 'sensors/#', colour: '#b45309' });
    renderPanel();
    await waitFor(() => expect(rows()).toHaveLength(1));
    selectTopic('sensors/#');

    await userEvent.click(addButton());

    expect(within(rows()[1]).getByText(/already has a colour/i)).toBeInTheDocument();
    expect(saveButton()).toBeDisabled();
  });
});

// The other order: the row is added first, and the topic picked afterwards. An empty filter is
// a slot waiting to be told what it covers, so a selection fills it.
describe('picking a topic after the row is there', () => {
  beforeEach(() => useSelectionStore.getState().clear());

  const selectTopic = (topic: string) =>
    act(() => useSelectionStore.getState().select({ label: topic, filter: topic, topic }));

  const addEmptyRow = async () => {
    await waitFor(() => expect(addButton()).toBeEnabled());
    await userEvent.click(addButton());
  };

  it('fills the row that was waiting', async () => {
    renderPanel();
    await addEmptyRow();

    selectTopic('sensors/attic/temp');

    expect(filterBox(rows()[0])).toHaveValue('sensors/attic/temp');
  });

  it('fills the newest empty row when more than one is waiting', async () => {
    renderPanel();
    await addEmptyRow();
    await userEvent.click(addButton());

    selectTopic('sensors/attic/temp');

    expect(filterBox(rows()[0])).toHaveValue('');
    expect(filterBox(rows()[1])).toHaveValue('sensors/attic/temp');
  });

  it('leaves a row that already says something alone', async () => {
    stored({ filter: 'alerts/#', colour: '#b45309' });
    renderPanel();
    await waitFor(() => expect(rows()).toHaveLength(1));

    selectTopic('sensors/attic/temp');

    expect(rows()).toHaveLength(1);
    expect(filterBox(rows()[0])).toHaveValue('alerts/#');
  });

  it('adds nothing when no row is waiting', async () => {
    stored({ filter: 'alerts/#', colour: '#b45309' });
    renderPanel();
    await waitFor(() => expect(rows()).toHaveLength(1));

    selectTopic('sensors/attic/temp');

    expect(rows()).toHaveLength(1);
  });

  it('ignores a selection that is not a topic', async () => {
    renderPanel();
    await addEmptyRow();

    act(() => useSelectionStore.getState().select({ label: 'broker:1883', filter: '#' }));

    expect(filterBox(rows()[0])).toHaveValue('');
  });

  // Clearing a box is an edit, not a request for the selection to be put back.
  it('does not put the topic back once the box has been cleared', async () => {
    renderPanel();
    await addEmptyRow();
    selectTopic('sensors/attic/temp');

    await userEvent.clear(filterBox(rows()[0]));

    expect(filterBox(rows()[0])).toHaveValue('');
  });

  it('fills the waiting row again on the next pick', async () => {
    renderPanel();
    await addEmptyRow();
    selectTopic('sensors/attic/temp');
    await userEvent.clear(filterBox(rows()[0]));

    selectTopic('alerts/water');

    expect(filterBox(rows()[0])).toHaveValue('alerts/water');
  });
});

// A row that has not been saved is still being decided on, so it keeps following the tree. Once
// saved it is a rule someone meant, and clicking around the tree must not rewrite it.
describe('an unsaved row follows the selection', () => {
  beforeEach(() => useSelectionStore.getState().clear());

  const selectTopic = (topic: string) =>
    act(() => useSelectionStore.getState().select({ label: topic, filter: topic, topic }));

  it('replaces what a new row says when the topic changes', async () => {
    renderPanel();
    await waitFor(() => expect(addButton()).toBeEnabled());
    await userEvent.click(addButton());

    selectTopic('sensors/attic/temp');
    expect(filterBox(rows()[0])).toHaveValue('sensors/attic/temp');

    selectTopic('alerts/water');

    expect(filterBox(rows()[0])).toHaveValue('alerts/water');
  });

  it('replaces a filter typed by hand into a row that was never saved', async () => {
    renderPanel();
    await waitFor(() => expect(addButton()).toBeEnabled());
    await userEvent.click(addButton());
    await userEvent.type(filterBox(rows()[0]), 'typed/by/hand');

    selectTopic('sensors/attic/temp');

    expect(filterBox(rows()[0])).toHaveValue('sensors/attic/temp');
  });

  it('leaves the row alone once it has been saved', async () => {
    capturePut();
    renderPanel();
    await waitFor(() => expect(addButton()).toBeEnabled());
    await userEvent.click(addButton());
    selectTopic('sensors/attic/temp');

    await userEvent.click(saveButton());
    await waitFor(() => expect(useLogStore.getState().commands).toHaveLength(1));
    selectTopic('alerts/water');

    expect(filterBox(rows()[0])).toHaveValue('sensors/attic/temp');
  });

  it('leaves a stored rule alone and follows only the row added beside it', async () => {
    stored({ filter: 'alerts/#', colour: '#b45309' });
    renderPanel();
    await waitFor(() => expect(rows()).toHaveLength(1));
    await userEvent.click(addButton());

    selectTopic('sensors/attic/temp');
    selectTopic('sensors/hall/temp');

    expect(filterBox(rows()[0])).toHaveValue('alerts/#');
    expect(filterBox(rows()[1])).toHaveValue('sensors/hall/temp');
  });

  // A save the server refused leaves the row unsaved, so it goes on following.
  it('goes on following after a save the server refused', async () => {
    server.use(
      http.put('/api/colour-rules', () =>
        HttpResponse.json({ title: 'Bad Request', detail: 'nope' }, { status: 400 }),
      ),
    );
    renderPanel();
    await waitFor(() => expect(addButton()).toBeEnabled());
    await userEvent.click(addButton());
    selectTopic('sensors/attic/temp');

    await userEvent.click(saveButton());
    await waitFor(() => expect(useLogStore.getState().commands).toHaveLength(1));
    selectTopic('alerts/water');

    expect(filterBox(rows()[0])).toHaveValue('alerts/water');
  });
});

/**
 * The second colour: what the message under the topic is drawn in.
 *
 * The pair is the point. A rule with one colour paints the path and leaves the payload in the
 * console's ink, which is what every rule written before this said and what most of them still
 * mean; a rule with two is somebody who wanted the body told apart as well. So 'none' has to be a
 * real answer, reachable in both directions, and it has to survive a save.
 */
describe('the message colour', () => {
  const topicSwatch = (row: HTMLElement) => within(row).getByRole('button', { name: /Choose a topic colour/ });
  const messageSwatch = (row: HTMLElement) =>
    within(row).getByRole('button', { name: /Choose a message colour/ });

  it('is none on a rule nobody has given one', async () => {
    stored({ filter: 'plant/#', colour: '#b45309' });
    renderPanel();

    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(within(rows()[0]).getByTestId('body-swatch')).toHaveAttribute('data-none');
  });

  it('wears the stored one where there is one', async () => {
    stored({ filter: 'plant/#', colour: '#b45309', bodyColour: '#1e40af' });
    renderPanel();

    await waitFor(() => expect(rows()).toHaveLength(1));
    const swatch = within(rows()[0]).getByTestId('body-swatch');
    expect(swatch).not.toHaveAttribute('data-none');
    expect(swatch).toHaveStyle({ background: '#1e40af' });
  });

  it('is saved beside the topic colour, and the topic keeps its own', async () => {
    stored({ filter: 'plant/#', colour: '#b45309' });
    const sent = capturePut();
    renderPanel();
    await waitFor(() => expect(rows()).toHaveLength(1));

    await userEvent.click(messageSwatch(rows()[0]));
    await userEvent.click(screen.getByRole('button', { name: PALETTE[4].name }));
    await userEvent.click(saveButton());

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual([{ filter: 'plant/#', colour: '#b45309', bodyColour: SUGGESTED[4] }]);
  });

  it('can be taken back off', async () => {
    stored({ filter: 'plant/#', colour: '#b45309', bodyColour: '#1e40af' });
    const sent = capturePut();
    renderPanel();
    await waitFor(() => expect(rows()).toHaveLength(1));

    await userEvent.click(messageSwatch(rows()[0]));
    await userEvent.click(screen.getByRole('button', { name: 'No colour' }));

    expect(within(rows()[0]).getByTestId('body-swatch')).toHaveAttribute('data-none');
    await userEvent.click(saveButton());
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual([{ filter: 'plant/#', colour: '#b45309', bodyColour: null }]);
  });

  // The two controls sit next to each other and paint different halves of a row. A click on one
  // that moved the other would be the panel quietly rewriting a rule somebody had settled.
  it('is a different colour from the topic', async () => {
    stored({ filter: 'plant/#', colour: '#b45309' });
    renderPanel();
    await waitFor(() => expect(rows()).toHaveLength(1));

    await userEvent.click(messageSwatch(rows()[0]));
    await userEvent.click(screen.getByRole('button', { name: PALETTE[5].name }));

    expect(within(rows()[0]).getByTestId('swatch')).toHaveStyle({ background: '#b45309' });
    expect(within(rows()[0]).getByTestId('body-swatch')).toHaveStyle({ background: SUGGESTED[5] });
  });

  // A topic is always painted, so its picker offers no way out — the row would otherwise be a
  // rule that exists and does nothing.
  it('is the only one of the two that can be cleared', async () => {
    stored({ filter: 'plant/#', colour: '#b45309' });
    renderPanel();
    await waitFor(() => expect(rows()).toHaveLength(1));

    await userEvent.click(topicSwatch(rows()[0]));

    expect(screen.queryByRole('button', { name: 'No colour' })).not.toBeInTheDocument();
  });

  // A rule the server sends without the second colour and a row holding null are the same rule.
  // Read as different, the panel would greet a reader with edits they had not made.
  it('is not an unsaved edit when the server never sent one', async () => {
    stored({ filter: 'plant/#', colour: '#b45309' });
    renderPanel();

    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(screen.queryByText(/Not saved yet/)).not.toBeInTheDocument();
  });

  // A file edited by hand past the API's validation. The row can only show 'no colour', and the
  // panel says so is a change — which is what offers to write the repair back.
  it('is an unsaved edit when the stored one cannot be used', async () => {
    stored({ filter: 'plant/#', colour: '#b45309', bodyColour: 'blue' });
    renderPanel();

    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(within(rows()[0]).getByTestId('body-swatch')).toHaveAttribute('data-none');
    expect(screen.getByText(/Not saved yet/)).toBeInTheDocument();
  });
});

import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';
// The tree reads its colour rules through react-query, so every render here needs a client.
import { renderWithClient as render } from '../../test/renderWithClient';
import { server } from '../../test/server';
import { MAX_TREE_ROWS } from '../../lib/topicTree';
import { useComposeStore } from '../../stores/composeStore';
import { useSelectionStore } from '../../stores/selectionStore';
import { useTopicTreeStore } from '../../stores/topicTreeStore';
import type { DecodedMessage } from '../../realtime/decodeIncoming';
import { ACTIVE_WINDOW_MS, TopicTree } from './TopicTree';

const message = (topic: string, payload = '1'): DecodedMessage => ({
  topic,
  payload,
  mode: 'text',
  size: payload.length,
  qos: 0,
  retain: false,
  receivedAt: '2026-07-26T10:00:00Z',
});

beforeEach(() => {
  useTopicTreeStore.setState({ defaultOpen: false });
  useTopicTreeStore.getState().reset();
  useSelectionStore.getState().clear();
  useComposeStore.setState({ draft: null });
});

describe('rooted at the broker', () => {
  const brokerRow = () => screen.getByRole('button', { name: /^test\.mosquitto\.org/ });

  it('puts every topic under one row named after the broker', () => {
    useTopicTreeStore.getState().apply([message('sensors/temp'), message('lights/hall')]);
    render(<TopicTree broker="test.mosquitto.org:1883" />);

    // The broker is the only row at the top; the topics sit one level in.
    const rows = screen.getAllByTestId('tree-row');
    expect(rows[0]).toHaveAttribute('data-depth', '0');
    expect(rows[0]).toHaveTextContent('test.mosquitto.org:1883');
    expect(rows.slice(1).every((row) => row.getAttribute('data-depth') !== '0')).toBe(true);
  });

  it('reports how many topics and messages sit beneath it', () => {
    useTopicTreeStore
      .getState()
      .apply([message('a/b'), message('a/b'), message('a/c'), message('x/y')]);
    render(<TopicTree broker="test.mosquitto.org:1883" />);

    expect(screen.getByText('3 topics · 4 messages')).toBeInTheDocument();
  });

  it('folds the whole tree away when the broker row is collapsed', async () => {
    useTopicTreeStore.getState().apply([message('sensors/temp')]);
    render(<TopicTree broker="test.mosquitto.org:1883" />);
    expect(screen.getByText('sensors')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /^Collapse test\.mosquitto\.org/ }));

    expect(screen.queryByText('sensors')).not.toBeInTheDocument();
    expect(brokerRow()).toBeInTheDocument();
  });

  it('points the wire log at everything when the broker row is picked', async () => {
    useTopicTreeStore.getState().apply([message('sensors/temp')]);
    render(<TopicTree broker="test.mosquitto.org:1883" />);

    await userEvent.click(brokerRow());

    expect(useSelectionStore.getState().selected).toEqual({
      label: 'test.mosquitto.org:1883',
      filter: '#',
    });
  });

  // Nothing to publish to: the broker is not a topic.
  it('leaves the publish form alone when the broker row is picked', async () => {
    useTopicTreeStore.getState().apply([message('sensors/temp')]);
    render(<TopicTree broker="test.mosquitto.org:1883" />);

    await userEvent.click(brokerRow());

    expect(useComposeStore.getState().draft).toBeNull();
  });

  it('says so plainly when no broker is connected', () => {
    useTopicTreeStore.getState().apply([message('sensors/temp')]);
    render(<TopicTree />);

    expect(screen.getByText('Not connected')).toBeInTheDocument();
  });
});

describe('TopicTree', () => {
  it('explains itself while empty', () => {
    render(<TopicTree broker="broker:1883" />);

    expect(
      screen.getByText('No topics yet. Connect to a broker and its tree builds here.'),
    ).toBeInTheDocument();
  });

  const branchOf = (name: string) => screen.getByText(name).closest('[data-open]');

  it('keeps a branch closed until it is opened', async () => {
    useTopicTreeStore.getState().apply([message('sensors/temp', '21.5')]);
    render(<TopicTree broker="broker:1883" />);

    expect(branchOf('sensors')).toHaveAttribute('data-open', 'false');
    await userEvent.click(screen.getByRole('button', { name: 'Expand sensors' }));

    expect(branchOf('sensors')).toHaveAttribute('data-open', 'true');
    expect(screen.getByText('temp')).toBeInTheDocument();
  });

  // The whole point of the flattening: a broker with 20k topics must not put 20k rows in the DOM.
  it('leaves the rows beneath a closed branch out of the document', () => {
    useTopicTreeStore.getState().apply([message('sensors/temp', '21.5')]);
    render(<TopicTree broker="broker:1883" />);

    expect(screen.queryByText('temp')).not.toBeInTheDocument();
  });

  it('drops the rows again when the branch is collapsed', async () => {
    useTopicTreeStore.getState().apply([message('sensors/temp', '21.5')]);
    render(<TopicTree broker="broker:1883" />);

    await userEvent.click(screen.getByRole('button', { name: 'Expand sensors' }));
    await userEvent.click(screen.getByRole('button', { name: 'Collapse sensors' }));

    expect(screen.queryByText('temp')).not.toBeInTheDocument();
  });

  it('stops drawing past its row ceiling and says how many it held back', () => {
    const topics = Array.from({ length: MAX_TREE_ROWS + 3 }, (_, i) => message(`t${i}`));
    useTopicTreeStore.getState().apply(topics);
    render(<TopicTree broker="broker:1883" />);

    expect(screen.getByText('3 more topics not shown')).toBeInTheDocument();
  });

  it('summarises a branch and shows the payload on a leaf', async () => {
    useTopicTreeStore.getState().apply([message('sensors/temp', '21.5'), message('sensors/humidity', '54')]);
    render(<TopicTree broker="broker:1883" />);

    // Scoped to the branch: the broker row above it reports the same totals for the whole tree.
    const sensorsRow = screen.getByText('sensors').closest('[data-testid="tree-row"]')!;
    expect(within(sensorsRow as HTMLElement).getByText('2 topics · 2 messages')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Expand sensors' }));
    expect(screen.getByText('21.5')).toBeInTheDocument();
  });

  it('opens every branch at once, including ones that arrive later', async () => {
    useTopicTreeStore.getState().apply([message('a/x')]);
    render(<TopicTree broker="broker:1883" />);

    await userEvent.click(screen.getByRole('button', { name: 'Expand all' }));
    useTopicTreeStore.getState().apply([message('b/y')]);

    await waitFor(() => expect(branchOf('a')).toHaveAttribute('data-open', 'true'));
    expect(branchOf('b')).toHaveAttribute('data-open', 'true');
  });

  // Traffic reads as a steady tint on the row, held while messages keep coming.
  const rowOf = (name: string) => screen.getByText(name).closest('[data-branch]');

  it('tints a closed branch when a message lands on something beneath it', () => {
    useTopicTreeStore.getState().apply([message('sensors/temp', '1')]);
    render(<TopicTree broker="broker:1883" />);

    expect(rowOf('sensors')).toHaveAttribute('data-active', 'true');
  });

  it('leaves an open branch untinted when the message was for a descendant', async () => {
    useTopicTreeStore.getState().apply([message('sensors/temp', '1')]);
    render(<TopicTree broker="broker:1883" />);
    await userEvent.click(screen.getByRole('button', { name: 'Expand sensors' }));

    expect(rowOf('temp')).toHaveAttribute('data-active', 'true');
    expect(rowOf('sensors')).toHaveAttribute('data-active', 'false');
  });

  it('tints an open branch when the message was addressed to it', async () => {
    useTopicTreeStore.getState().apply([message('sensors/temp', '1'), message('sensors', 'own')]);
    render(<TopicTree broker="broker:1883" />);
    await userEvent.click(screen.getByRole('button', { name: 'Expand sensors' }));

    expect(rowOf('sensors')).toHaveAttribute('data-active', 'true');
  });

  // The point of the change: a row under constant traffic holds one colour instead of
  // restarting a fade per message, which was what made a busy broker strobe.
  it('holds the tint through a second message rather than restarting anything', () => {
    useTopicTreeStore.getState().apply([message('sensors/temp', '1')]);
    render(<TopicTree broker="broker:1883" />);
    const row = rowOf('sensors');

    useTopicTreeStore.getState().apply([message('sensors/temp', '2')]);

    expect(rowOf('sensors')).toBe(row);
    expect(rowOf('sensors')).toHaveAttribute('data-active', 'true');
  });

  it('drops the tint once the topic falls quiet', async () => {
    vi.useFakeTimers();
    try {
      useTopicTreeStore.getState().apply([message('sensors/temp', '1')]);
      render(<TopicTree broker="broker:1883" />);
      expect(rowOf('sensors')).toHaveAttribute('data-active', 'true');

      await act(async () => {
        vi.advanceTimersByTime(ACTIVE_WINDOW_MS + 50);
      });

      expect(rowOf('sensors')).toHaveAttribute('data-active', 'false');
    } finally {
      vi.useRealTimers();
    }
  });

  it('has no fade animation left to stack up', () => {
    useTopicTreeStore.getState().apply([message('sensors/temp', '1')]);
    render(<TopicTree broker="broker:1883" />);

    expect(getComputedStyle(rowOf('sensors')!).animationName).toBe('none');
  });

  it('focuses the wire log on the clicked node and everything beneath it', async () => {
    useTopicTreeStore.getState().apply([message('sensors/temp', '21.5')]);
    render(<TopicTree broker="broker:1883" />);

    await userEvent.click(screen.getByText('sensors'));

    expect(useSelectionStore.getState().selected).toEqual({ label: 'sensors', filter: 'sensors/#' });
  });

  it('focuses a leaf on its own full path', async () => {
    useTopicTreeStore.getState().apply([message('sensors/temp', '21.5')]);
    render(<TopicTree broker="broker:1883" />);
    await userEvent.click(screen.getByRole('button', { name: 'Expand sensors' }));

    await userEvent.click(screen.getByText('temp'));

    expect(useSelectionStore.getState().selected).toEqual({
      label: 'sensors/temp',
      filter: 'sensors/temp/#',
    });
  });

  it('leaves the branch closed when the row is clicked', async () => {
    useTopicTreeStore.getState().apply([message('sensors/temp', '21.5')]);
    render(<TopicTree broker="broker:1883" />);

    await userEvent.click(screen.getByText('sensors'));

    expect(branchOf('sensors')).toHaveAttribute('data-open', 'false');
  });

  // The twisty is a 24px target at the far left of the row. Double-clicking the row itself is
  // the same instruction, given to the part of the row that is easy to hit.
  it('opens a branch on a double click, the way the twisty does', async () => {
    useTopicTreeStore.getState().apply([message('sensors/temp', '21.5')]);
    render(<TopicTree broker="broker:1883" />);

    await userEvent.dblClick(screen.getByText('sensors'));

    expect(branchOf('sensors')).toHaveAttribute('data-open', 'true');
    expect(screen.getByText('temp')).toBeInTheDocument();
  });

  it('closes an open branch on a second double click', async () => {
    useTopicTreeStore.getState().apply([message('sensors/temp', '21.5')]);
    render(<TopicTree broker="broker:1883" />);

    await userEvent.dblClick(screen.getByText('sensors'));
    await userEvent.dblClick(screen.getByText('sensors'));

    expect(branchOf('sensors')).toHaveAttribute('data-open', 'false');
  });

  // With the pointer held still a browser does not start the count over — the second double
  // click arrives as clicks three and four, and it need not re-announce them as a double click.
  it('closes the branch on a second double click in the very same spot', () => {
    useTopicTreeStore.getState().apply([message('sensors/temp', '21.5')]);
    render(<TopicTree broker="broker:1883" />);

    fireEvent.click(screen.getByText('sensors'), { detail: 1 });
    fireEvent.click(screen.getByText('sensors'), { detail: 2 });
    expect(branchOf('sensors')).toHaveAttribute('data-open', 'true');

    fireEvent.click(screen.getByText('sensors'), { detail: 3 });
    fireEvent.click(screen.getByText('sensors'), { detail: 4 });

    expect(branchOf('sensors')).toHaveAttribute('data-open', 'false');
  });

  // Enter on a focused row arrives as a click with no count at all. That is a pick, not a
  // double click, and counting alone would read the zero as an even number and open the branch.
  it('picks the row from the keyboard rather than opening it', async () => {
    useTopicTreeStore.getState().apply([message('sensors/temp', '21.5')]);
    render(<TopicTree broker="broker:1883" />);

    screen.getByText('sensors').closest('button')!.focus();
    await userEvent.keyboard('{Enter}');

    expect(useSelectionStore.getState().selected).toEqual({ label: 'sensors', filter: 'sensors/#' });
    expect(branchOf('sensors')).toHaveAttribute('data-open', 'false');
  });

  it('leaves the wire log pointed at the branch it just opened', async () => {
    useTopicTreeStore.getState().apply([message('sensors/temp', '21.5')]);
    render(<TopicTree broker="broker:1883" />);

    await userEvent.dblClick(screen.getByText('sensors'));

    expect(useSelectionStore.getState().selected).toEqual({ label: 'sensors', filter: 'sensors/#' });
  });

  // The repeat click belongs to the double click, not to the user. Passing it on would load the
  // topic into publish a second time, overwriting whatever had been typed there since the first.
  it('loads a double-clicked topic into publish once, not twice', async () => {
    useTopicTreeStore.getState().apply([message('sensors/temp', '21.5')]);
    render(<TopicTree broker="broker:1883" />);

    await userEvent.click(screen.getByText('sensors'));
    const loaded = useComposeStore.getState().draft!.serial;
    await userEvent.dblClick(screen.getByText('sensors'));

    expect(useComposeStore.getState().draft!.serial).toBe(loaded + 1);
  });

  it('folds the whole tree away on a double click of the broker row', async () => {
    useTopicTreeStore.getState().apply([message('sensors/temp', '21.5')]);
    render(<TopicTree broker="broker:1883" />);

    await userEvent.dblClick(screen.getByText('broker:1883'));

    expect(screen.queryByText('sensors')).not.toBeInTheDocument();
  });

  it('keeps the focus when the selected node is clicked again', async () => {
    useTopicTreeStore.getState().apply([message('sensors/temp', '21.5')]);
    render(<TopicTree broker="broker:1883" />);

    await userEvent.click(screen.getByText('sensors'));
    await userEvent.click(screen.getByText('sensors'));

    expect(useSelectionStore.getState().selected).toEqual({ label: 'sensors', filter: 'sensors/#' });
  });

  it('loads the clicked topic into publish, settings and all', async () => {
    const retained: DecodedMessage = { ...message('sensors/temp', '21.5'), qos: 2, retain: true };
    useTopicTreeStore.getState().apply([retained]);
    render(<TopicTree broker="broker:1883" />);
    await userEvent.click(screen.getByRole('button', { name: 'Expand sensors' }));

    await userEvent.click(screen.getByText('temp'));

    // The node's own path, not the '/#' filter the wire log focuses on.
    expect(useComposeStore.getState().draft).toMatchObject({
      topic: 'sensors/temp',
      payload: '21.5',
      qos: 2,
      retain: true,
    });
  });

  // A branch that has never carried a message of its own has no payload to offer.
  it('sends a branch topic to publish without inventing a payload', async () => {
    useTopicTreeStore.getState().apply([message('sensors/temp', '21.5')]);
    render(<TopicTree broker="broker:1883" />);

    await userEvent.click(screen.getByText('sensors'));

    expect(useComposeStore.getState().draft).toMatchObject({ topic: 'sensors' });
    expect(useComposeStore.getState().draft?.payload).toBeUndefined();
  });

  // Same rule as the payload above: a branch with no message of its own has no mode to offer
  // either, so the form must stay in whatever mode it was already in rather than jumping to text.
  it('sends a branch topic to publish without inventing a mode', async () => {
    useTopicTreeStore.getState().apply([message('sensors/temp', '21.5')]);
    render(<TopicTree broker="broker:1883" />);

    await userEvent.click(screen.getByText('sensors'));

    expect(useComposeStore.getState().draft?.mode).toBeUndefined();
  });

  // A leaf that did receive a message of its own must still pass its real mode through.
  it('sends a leaf topic to publish with the mode its message arrived in', async () => {
    useTopicTreeStore.getState().apply([{ ...message('device/cmd', '01a4ff'), mode: 'hex' }]);
    render(<TopicTree broker="broker:1883" />);
    await userEvent.click(screen.getByRole('button', { name: 'Expand device' }));

    await userEvent.click(screen.getByText('cmd'));

    expect(useComposeStore.getState().draft?.mode).toBe('hex');
  });

  it('marks the focused row', async () => {
    useTopicTreeStore.getState().apply([message('sensors/temp', '21.5')]);
    render(<TopicTree broker="broker:1883" />);

    await userEvent.click(screen.getByText('sensors'));

    expect(screen.getByText('sensors').closest('[data-branch]')).toHaveAttribute('data-selected', 'true');
  });

  it('collapses every branch', async () => {
    useTopicTreeStore.getState().apply([message('a/x')]);
    render(<TopicTree broker="broker:1883" />);

    await userEvent.click(screen.getByRole('button', { name: 'Expand all' }));
    await userEvent.click(screen.getByRole('button', { name: 'Collapse all' }));

    expect(branchOf('a')).toHaveAttribute('data-open', 'false');
  });

  // Collapse has to beat both a per-branch choice and the branches that arrive afterwards,
  // otherwise a firehose keeps unfolding itself the moment you fold it.
  it('collapses branches opened one at a time, and keeps later ones folded too', async () => {
    useTopicTreeStore.getState().apply([message('a/x'), message('b/y')]);
    render(<TopicTree broker="broker:1883" />);
    await userEvent.click(screen.getByRole('button', { name: 'Expand a' }));
    await userEvent.click(screen.getByRole('button', { name: 'Expand b' }));

    await userEvent.click(screen.getByRole('button', { name: 'Collapse all' }));
    useTopicTreeStore.getState().apply([message('c/z')]);

    await waitFor(() => expect(branchOf('c')).toHaveAttribute('data-open', 'false'));
    expect(branchOf('a')).toHaveAttribute('data-open', 'false');
    expect(branchOf('b')).toHaveAttribute('data-open', 'false');
    expect(screen.queryByText('x')).not.toBeInTheDocument();
  });

  // Glyph-only buttons were there but nobody found them.
  it('names the expand and collapse controls in words', () => {
    render(<TopicTree broker="broker:1883" />);

    expect(screen.getByRole('button', { name: 'Expand all' })).toHaveTextContent(/expand all/i);
    expect(screen.getByRole('button', { name: 'Collapse all' })).toHaveTextContent(/collapse all/i);
  });

  // Already safe: synchronous store writes, no network call, so no guard needed here.
  it('settles on a consistent state when the twisty is clicked rapidly with no waits', () => {
    useTopicTreeStore.getState().apply([message('sensors/temp')]);
    render(<TopicTree broker="broker:1883" />);
    const twisty = screen.getByRole('button', { name: 'Expand sensors' });

    fireEvent.click(twisty);
    fireEvent.click(twisty);
    fireEvent.click(twisty);

    expect(branchOf('sensors')).toHaveAttribute('data-open', 'true');
  });

  it('settles on a consistent state when expand/collapse all are hammered with no waits', () => {
    useTopicTreeStore.getState().apply([message('a/x')]);
    render(<TopicTree broker="broker:1883" />);

    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));
    fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }));
    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));

    expect(branchOf('a')).toHaveAttribute('data-open', 'true');
  });
});

describe('colour rules', () => {
  const rules = (...rules: Array<{ filter: string; colour: string }>) =>
    server.use(http.get('/api/colour-rules', () => HttpResponse.json({ rules })));

  const dotOf = (segment: string) =>
    within(screen.getByText(segment).closest('[data-testid="tree-row"]')!).getByTestId('dot');

  it('marks a row whose topic a rule covers', async () => {
    rules({ filter: 'sensors/+/temp', colour: '#b45309' });
    useTopicTreeStore.setState({ defaultOpen: true });
    useTopicTreeStore.getState().apply([message('sensors/a/temp')]);
    render(<TopicTree broker="broker:1883" />);

    await waitFor(() => expect(dotOf('temp')).toHaveStyle({ background: '#b45309' }));
  });

  it('leaves a row no rule covers unmarked, but still drawn', async () => {
    rules({ filter: 'sensors/+/temp', colour: '#b45309' });
    useTopicTreeStore.setState({ defaultOpen: true });
    useTopicTreeStore.getState().apply([message('sensors/a/temp'), message('sensors/a/hum')]);
    render(<TopicTree broker="broker:1883" />);

    // Drawn either way: a dot that appears and disappears would shift every segment beside it.
    await waitFor(() => expect(dotOf('temp')).toHaveStyle({ background: '#b45309' }));
    expect(dotOf('hum')).toHaveStyle({ background: 'transparent' });
  });

  it('gives a row the colour of the most specific rule that covers it', async () => {
    rules({ filter: 'sensors/#', colour: '#111111' }, { filter: 'sensors/+/temp', colour: '#222222' });
    useTopicTreeStore.setState({ defaultOpen: true });
    useTopicTreeStore.getState().apply([message('sensors/a/temp')]);
    render(<TopicTree broker="broker:1883" />);

    await waitFor(() => expect(dotOf('temp')).toHaveStyle({ background: '#222222' }));
  });

  it('colours a branch by its own path, not by what sits under it', async () => {
    rules({ filter: 'sensors/a', colour: '#333333' });
    useTopicTreeStore.setState({ defaultOpen: true });
    useTopicTreeStore.getState().apply([message('sensors/a/temp')]);
    render(<TopicTree broker="broker:1883" />);

    await waitFor(() => expect(dotOf('a')).toHaveStyle({ background: '#333333' }));
    expect(dotOf('temp')).toHaveStyle({ background: 'transparent' });
  });

  it('is unmarked throughout when there are no rules', async () => {
    useTopicTreeStore.setState({ defaultOpen: true });
    useTopicTreeStore.getState().apply([message('sensors/a/temp')]);
    render(<TopicTree broker="broker:1883" />);

    await waitFor(() => expect(screen.getAllByTestId('dot').length).toBeGreaterThan(0));
    expect(screen.getAllByTestId('dot').every((dot) => dot.style.background === 'transparent')).toBe(true);
  });

  // A hand-edited file can hold anything; it must not reach a style attribute.
  it('ignores a rule whose colour is not a hex triple', async () => {
    rules({ filter: 'sensors/#', colour: 'red; background: url(x)' });
    useTopicTreeStore.setState({ defaultOpen: true });
    useTopicTreeStore.getState().apply([message('sensors/a/temp')]);
    render(<TopicTree broker="broker:1883" />);

    await waitFor(() => expect(dotOf('temp')).toBeInTheDocument());
    expect(dotOf('temp')).toHaveStyle({ background: 'transparent' });
  });

  it('carries on drawing the tree when the rules cannot be fetched', async () => {
    server.use(http.get('/api/colour-rules', () => new HttpResponse(null, { status: 500 })));
    useTopicTreeStore.setState({ defaultOpen: true });
    useTopicTreeStore.getState().apply([message('sensors/a/temp')]);
    render(<TopicTree broker="broker:1883" />);

    expect(screen.getByText('temp')).toBeInTheDocument();
    await waitFor(() => expect(dotOf('temp')).toHaveStyle({ background: 'transparent' }));
  });
});

describe('which rule painted a row', () => {
  it('names the filter that won, not the topic already on the row', async () => {
    server.use(
      http.get('/api/colour-rules', () =>
        HttpResponse.json({
          rules: [
            { filter: 'sensors/#', colour: '#111111' },
            { filter: 'sensors/+/temp', colour: '#222222' },
          ],
        }),
      ),
    );
    useTopicTreeStore.setState({ defaultOpen: true });
    useTopicTreeStore.getState().apply([message('sensors/a/temp')]);
    render(<TopicTree broker="broker:1883" />);

    const dot = () =>
      within(screen.getByText('temp').closest('[data-testid="tree-row"]')!).getByTestId('dot');

    await waitFor(() => expect(dot()).toHaveAttribute('title', 'Coloured by sensors/+/temp'));
  });

  it('leaves an unmatched row with no tooltip at all', async () => {
    useTopicTreeStore.setState({ defaultOpen: true });
    useTopicTreeStore.getState().apply([message('sensors/a/temp')]);
    render(<TopicTree broker="broker:1883" />);

    const dot = () =>
      within(screen.getByText('temp').closest('[data-testid="tree-row"]')!).getByTestId('dot');

    await waitFor(() => expect(dot()).toBeInTheDocument());
    expect(dot()).not.toHaveAttribute('title');
  });
});

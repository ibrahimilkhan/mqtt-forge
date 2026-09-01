import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderWithClient as render } from '../../test/renderWithClient';
import { useSelectionStore } from '../../stores/selectionStore';
import { useTopicTreeStore } from '../../stores/topicTreeStore';
import { RuleEditor } from './RuleEditor';
import { forgetDraft, startRuleDraft } from './ruleDraft';

/**
 * The two things a rule editor now knows that its reader does not have to.
 *
 * A topic filter and a field path are the two boxes on this form where a typo does not fail — it
 * produces a rule that saves, sits in the list looking correct, and never fires. Both of them are
 * now answerable by pressing a mark and choosing, and what these pin down is that choosing puts
 * exactly the right string in exactly the right box.
 */

function editor() {
  const draftId = startRuleDraft();

  return { draftId, ...render(<RuleEditor draftId={draftId} onDone={() => {}} onBack={() => {}} />) };
}

/** The broker has spoken on four topics, three of them carrying documents. */
function seedTree() {
  act(() =>
    useTopicTreeStore.getState().apply([
      { topic: 'plant/boiler/temp', payload: '{"temp": 91.2, "pump": {"state": "RUN"}}' },
      { topic: 'plant/boiler/flow', payload: '12.5' },
      { topic: 'plant/kiln/temp', payload: '{"temp": 1180}' },
      { topic: 'site/gateway/status', payload: '{"rssi": -67}' },
    ] as never),
  );
}

beforeEach(() => {
  useSelectionStore.getState().clear();
  useTopicTreeStore.getState().reset();
  forgetDraft('rule:new');
});

afterEach(() => {
  useTopicTreeStore.getState().reset();
});

describe('picking a topic filter off the broker', () => {
  it('is offered on the field, and stays shut until it is asked for', async () => {
    editor();

    expect(screen.getByRole('button', { name: 'Show topics on the broker' })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Topics on the broker' })).not.toBeInTheDocument();
  });

  it('says so plainly when the broker has sent nothing yet', async () => {
    editor();

    await userEvent.click(screen.getByRole('button', { name: 'Show topics on the broker' }));

    expect(screen.getByText(/Nothing has arrived yet/)).toBeInTheDocument();
  });

  it('writes a leaf into the filter box as the topic itself', async () => {
    seedTree();
    editor();

    await userEvent.click(screen.getByRole('button', { name: 'Show topics on the broker' }));
    const tree = screen.getByRole('group', { name: 'Topics on the broker' });

    // Two leaves are called 'temp'; the one under boiler is the first of them.
    await userEvent.click(within(tree).getAllByRole('button', { name: /^temp/ })[0]);

    expect(screen.getByLabelText('Topic filter')).toHaveValue('plant/boiler/temp');
  });

  it('writes a branch into the filter box as everything under it', async () => {
    seedTree();
    editor();

    await userEvent.click(screen.getByRole('button', { name: 'Show topics on the broker' }));
    const tree = screen.getByRole('group', { name: 'Topics on the broker' });

    await userEvent.click(within(tree).getByRole('button', { name: 'boiler/#' }));

    expect(screen.getByLabelText('Topic filter')).toHaveValue('plant/boiler/#');
  });

  it('closes itself once something has been picked', async () => {
    seedTree();
    editor();

    await userEvent.click(screen.getByRole('button', { name: 'Show topics on the broker' }));
    await userEvent.click(
      within(screen.getByRole('group', { name: 'Topics on the broker' })).getByRole('button', {
        name: 'plant/#',
      }),
    );

    expect(screen.queryByRole('group', { name: 'Topics on the broker' })).not.toBeInTheDocument();
  });

  it('narrows the list to what the search says, keeping the branches above a match', async () => {
    seedTree();
    editor();

    await userEvent.click(screen.getByRole('button', { name: 'Show topics on the broker' }));
    await userEvent.type(screen.getByLabelText('Find a topic'), 'kiln');

    const tree = screen.getByRole('group', { name: 'Topics on the broker' });

    expect(within(tree).getByRole('button', { name: 'kiln/#' })).toBeInTheDocument();
    // The branch above it survives, or the indent would describe a parent that is not there.
    expect(within(tree).getByRole('button', { name: 'plant/#' })).toBeInTheDocument();
    expect(within(tree).queryByRole('button', { name: 'boiler/#' })).not.toBeInTheDocument();
  });
});

describe('picking a field out of a message', () => {
  it('lists the paths in the newest body the filter covers', async () => {
    seedTree();
    editor();

    await userEvent.type(screen.getByLabelText('Topic filter'), 'plant/boiler/temp');
    await userEvent.click(screen.getByRole('button', { name: 'Show fields in a message' }));

    const picker = screen.getByRole('group', { name: 'Fields in a message' });

    expect(within(picker).getByRole('button', { name: /\$\.temp/ })).toBeInTheDocument();
    expect(within(picker).getByRole('button', { name: /\$\.pump\.state/ })).toBeInTheDocument();
  });

  it('writes the pressed path into the Field box, and shuts', async () => {
    seedTree();
    editor();

    await userEvent.type(screen.getByLabelText('Topic filter'), 'plant/boiler/temp');
    await userEvent.click(screen.getByRole('button', { name: 'Show fields in a message' }));
    await userEvent.click(
      within(screen.getByRole('group', { name: 'Fields in a message' })).getByRole('button', {
        name: /\$\.pump\.state/,
      }),
    );

    expect(screen.getByLabelText('Field')).toHaveValue('$.pump.state');
    expect(screen.queryByRole('group', { name: 'Fields in a message' })).not.toBeInTheDocument();
  });

  it('takes a body pasted in when the broker has sent nothing to read', async () => {
    editor();

    await userEvent.click(screen.getByRole('button', { name: 'Show fields in a message' }));

    const picker = screen.getByRole('group', { name: 'Fields in a message' });
    await userEvent.type(
      within(picker).getByLabelText('Paste one message'),
      '{{"level": 3, "door": "OPEN"}',
    );

    await userEvent.click(within(picker).getByRole('button', { name: /\$\.door/ }));

    expect(screen.getByLabelText('Field')).toHaveValue('$.door');
  });

  it('says a pasted body is not a document rather than listing nothing', async () => {
    editor();

    await userEvent.click(screen.getByRole('button', { name: 'Show fields in a message' }));
    await userEvent.type(
      within(screen.getByRole('group', { name: 'Fields in a message' })).getByLabelText(
        'Paste one message',
      ),
      'not json at all',
    );

    expect(screen.getByText(/That is not a JSON document/)).toBeInTheDocument();
  });

  it('falls back to a body it can still show when the filter stops covering the one it had', async () => {
    seedTree();
    editor();

    const filter = screen.getByLabelText('Topic filter');
    await userEvent.type(filter, 'plant/boiler/temp');
    await userEvent.click(screen.getByRole('button', { name: 'Show fields in a message' }));

    // The reader goes back to the filter and narrows it onto a different topic entirely.
    await userEvent.clear(filter);
    await userEvent.type(filter, 'site/gateway/status');

    const picker = screen.getByRole('group', { name: 'Fields in a message' });

    expect(within(picker).getByRole('button', { name: /\$\.rssi/ })).toBeInTheDocument();
  });

  it('offers the paste box once the filter covers nothing the broker has sent', async () => {
    seedTree();
    editor();

    await userEvent.type(screen.getByLabelText('Topic filter'), 'plant/boiler/temp');
    await userEvent.click(screen.getByRole('button', { name: 'Show fields in a message' }));

    await userEvent.clear(screen.getByLabelText('Topic filter'));
    await userEvent.type(screen.getByLabelText('Topic filter'), 'nothing/here');

    expect(
      within(screen.getByRole('group', { name: 'Fields in a message' })).getByLabelText(
        'Paste one message',
      ),
    ).toBeInTheDocument();
  });

  it('only ever has one picker open, so the box being filled in stays on screen', async () => {
    seedTree();
    editor();

    await userEvent.click(screen.getByRole('button', { name: 'Show topics on the broker' }));
    await userEvent.click(screen.getByRole('button', { name: 'Show fields in a message' }));

    expect(screen.queryByRole('group', { name: 'Topics on the broker' })).not.toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Fields in a message' })).toBeInTheDocument();
  });
});

describe('the marks that explain the form', () => {
  it.each([
    ['What it watches', /Topic filter/],
    ['When it fires', /neither true nor false/],
    ['Everything else', /Cooldown/],
  ])('opens the help behind %s', async (heading, inside) => {
    editor();

    const mark = screen.getByRole('button', { name: `What ${heading} means` });
    expect(mark).toHaveAttribute('aria-expanded', 'false');

    await userEvent.click(mark);

    expect(screen.getByRole('button', { name: `Hide what ${heading} means` })).toBeInTheDocument();
    expect(within(screen.getByRole('note')).getByText(inside)).toBeInTheDocument();
  });

  it('shows the path syntax with a worked example behind the Field mark', async () => {
    editor();

    await userEvent.click(screen.getByRole('button', { name: 'What Field means' }));

    const help = screen.getByRole('note');

    expect(within(help).getByText('$.radios[0].crc')).toBeInTheDocument();
    expect(within(help).getByText('the same 3, written the other way')).toBeInTheDocument();
  });

  it('names the clear switch in three words and puts the sentence behind a mark', async () => {
    editor();

    expect(screen.getByLabelText('Its own clear rule')).toBeInTheDocument();
    expect(screen.queryByText(/Clear on a condition of its own/)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'What its own clear rule means' }));

    expect(screen.getByText(/Fire above 80 and clear below 70/)).toBeInTheDocument();
  });

  it('does not toggle the switch when the mark beside it is pressed', async () => {
    editor();

    const box = screen.getByLabelText('Its own clear rule');
    expect(box).not.toBeChecked();

    await userEvent.click(screen.getByRole('button', { name: 'What its own clear rule means' }));

    expect(box).not.toBeChecked();
  });
});

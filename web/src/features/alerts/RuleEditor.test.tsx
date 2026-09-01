import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderWithClient as render } from '../../test/renderWithClient';
import { useSelectionStore } from '../../stores/selectionStore';
import type { AlertRuleDto } from '../../types/api';
import { Windows } from '../monitor/Windows';
import { useWindows } from '../monitor/useWindows';
import { forgetDraft, openRuleEditor } from './ruleDraft';

const boiler: AlertRuleDto = {
  id: 'boiler',
  name: 'Boiler temperature',
  enabled: true,
  filter: 'plant/+/temp',
  field: '$.temp',
  condition: { type: 'threshold', op: 'gt', value: 90 },
  clear: null,
  for: 30,
  cooldown: 60,
  severity: 'critical',
  actions: [{ type: 'screen' }],
};

const door: AlertRuleDto = { ...boiler, id: 'door', name: 'Door left open', filter: 'plant/door' };

const kiln = { label: 'sensors/kiln', filter: 'sensors/kiln', topic: 'sensors/kiln' };
const room = { label: 'sensors/room', filter: 'sensors/room', topic: 'sensors/room' };

/** jsdom's viewport is a property like any other, and the window store reads it at open. */
function viewport(width: number) {
  const was = window.innerWidth;
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });

  return () => Object.defineProperty(window, 'innerWidth', { configurable: true, value: was });
}

beforeEach(() => {
  useSelectionStore.getState().clear();
  useWindows.setState({ windows: [] });
  forgetDraft('rule:boiler');
  forgetDraft('rule:door');
});

afterEach(() => useWindows.setState({ windows: [] }));

describe('the rule editor window', () => {
  it('brings the window it already has forward rather than opening a second on one draft', async () => {
    render(<Windows />);

    act(() => openRuleEditor(boiler));
    act(() => openRuleEditor(door));
    act(() => openRuleEditor(boiler));

    expect(screen.getAllByTestId('rule-window')).toHaveLength(2);
    // The array IS the z-order, so the one asked for twice is the one on top.
    expect(useWindows.getState().windows.at(-1)?.pane).toEqual({
      kind: 'rule',
      draftId: 'rule:boiler',
    });
  });

  it('opens filling the screen where a window would be narrower than the column it replaces', async () => {
    const back = viewport(600);
    render(<Windows />);

    act(() => openRuleEditor(boiler));

    expect(screen.getByTestId('rule-window')).toHaveAttribute('data-full');
    back();
  });

  it('stands over the rail and the panel column when it fills a narrow screen', async () => {
    const back = viewport(600);
    render(<Windows />);

    act(() => openRuleEditor(boiler));

    // At this width the rail lying over the workspace climbs to 300 and throws a scrim across the
    // whole viewport. A form under that scrim cannot be read, let alone filled in — and a window
    // nobody can see is the same as no window at all.
    expect(Number(screen.getByTestId('rule-window').style.zIndex)).toBeGreaterThan(300);
    back();
  });

  it('puts a window opened full back to the size a window opens at', async () => {
    const back = viewport(600);
    render(<Windows />);
    act(() => openRuleEditor(boiler));

    await userEvent.click(
      screen.getByRole('button', { name: 'Put Boiler temperature editor back' }),
    );

    expect(screen.getByTestId('rule-window')).not.toHaveAttribute('data-full');
    expect(screen.getByTestId('rule-window').style.width).not.toBe(`${window.innerWidth}px`);
    back();
  });

  it('takes the picked topic as the filter of a new rule, once, at the moment it opens', async () => {
    act(() => useSelectionStore.getState().select(kiln));
    render(<Windows />);

    act(() => openRuleEditor());

    expect(screen.getByLabelText('Topic filter')).toHaveValue('sensors/kiln');

    // Clicking about the tree with a window open must not rewrite the form under the reader.
    act(() => useSelectionStore.getState().select(room));

    expect(screen.getByLabelText('Topic filter')).toHaveValue('sensors/kiln');
  });

  it('never prefills a rule that already exists', async () => {
    act(() => useSelectionStore.getState().select(kiln));
    render(<Windows />);

    act(() => openRuleEditor(boiler));

    expect(screen.getByLabelText('Topic filter')).toHaveValue('plant/+/temp');
    expect(screen.getByLabelText('Name')).toHaveValue('Boiler temperature');
    expect(screen.getByLabelText('For, seconds')).toHaveValue('30');
  });

  it('keeps what has been typed when the window is closed', async () => {
    render(<Windows />);
    act(() => openRuleEditor(boiler));

    await userEvent.clear(screen.getByLabelText('Name'));
    await userEvent.type(screen.getByLabelText('Name'), 'Kiln temperature');
    await userEvent.click(
      screen.getByRole('button', { name: 'Close the Boiler temperature editor' }),
    );

    expect(screen.queryByTestId('rule-window')).not.toBeInTheDocument();

    act(() => openRuleEditor(boiler));

    expect(screen.getByLabelText('Name')).toHaveValue('Kiln temperature');
  });

  it('gives two editors open at once fields of their own', async () => {
    render(<Windows />);

    act(() => openRuleEditor(boiler));
    act(() => openRuleEditor(door));

    // One id on two boxes would point every label in the second window at the first window's
    // field, and a click on a label would put the focus in the wrong window entirely.
    const names = screen.getAllByLabelText('Name');
    expect(names).toHaveLength(2);
    expect(names[0].id).not.toBe(names[1].id);
  });
});

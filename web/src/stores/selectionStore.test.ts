import { beforeEach, describe, expect, it } from 'vitest';
import { applyMessages, emptyTree, nodeAt } from '../lib/topicTree';
import { brokerSelection, selectionFor, useSelectionStore } from './selectionStore';

const chip = { label: 'sensors/#', filter: 'sensors/#' };
const node = { label: 'sensors/room', filter: 'sensors/room/#' };

beforeEach(() => useSelectionStore.getState().clear());

describe('selectionStore', () => {
  it('starts with nothing selected', () => {
    expect(useSelectionStore.getState().selected).toBeNull();
  });

  it('holds what was selected', () => {
    useSelectionStore.getState().select(chip);

    expect(useSelectionStore.getState().selected).toEqual(chip);
  });

  // Picking is not a switch. Clicking a topic you are already reading means nothing, and it
  // certainly does not mean put the log away — the × on the wire log is what does that.
  it('stays where it is when the same filter is picked again', () => {
    useSelectionStore.getState().select(chip);
    useSelectionStore.getState().select(chip);

    expect(useSelectionStore.getState().selected).toEqual(chip);
  });

  it('does not churn the selection when the same filter is picked again', () => {
    useSelectionStore.getState().select(chip);
    const first = useSelectionStore.getState().selected;
    useSelectionStore.getState().select({ ...chip });

    expect(useSelectionStore.getState().selected).toBe(first);
  });

  // Same filter, different label: the tree's 'sensors' node and the 'sensors/#' chip both point
  // the log at the same traffic, and the heading has to name whichever was clicked.
  it('takes a new label for a filter it is already on', () => {
    useSelectionStore.getState().select({ label: 'sensors/#', filter: 'sensors/#' });
    useSelectionStore.getState().select({ label: 'sensors', filter: 'sensors/#' });

    expect(useSelectionStore.getState().selected).toEqual({ label: 'sensors', filter: 'sensors/#' });
  });

  it('replaces the selection when a different filter is picked', () => {
    useSelectionStore.getState().select(chip);
    useSelectionStore.getState().select(node);

    expect(useSelectionStore.getState().selected).toEqual(node);
  });

  it('clears on demand', () => {
    useSelectionStore.getState().select(node);
    useSelectionStore.getState().clear();

    expect(useSelectionStore.getState().selected).toBeNull();
  });
});

describe('the selection a tree row makes', () => {
  it('names the empty first level /', () => {
    expect(selectionFor('', null)).toEqual({ label: '/', filter: '/#', topic: '/#' });
  });

  it('gives a leaf its own topic and a branch its subtree', () => {
    const tree = applyMessages(emptyTree(), [{ topic: 'plant/boiler/temp', payload: '81' }], 1);

    expect(selectionFor('plant/boiler/temp', nodeAt(tree, 'plant/boiler/temp'))).toEqual({
      label: 'plant/boiler/temp',
      filter: 'plant/boiler/temp/#',
      topic: 'plant/boiler/temp',
    });
    expect(selectionFor('plant/boiler', nodeAt(tree, 'plant/boiler'))).toEqual({
      label: 'plant/boiler',
      filter: 'plant/boiler/#',
      topic: 'plant/boiler/#',
    });
  });

  it('names the broker row by the broker, or says there is none', () => {
    expect(brokerSelection('mqtt.hsl.fi:8883')).toEqual({ label: 'mqtt.hsl.fi:8883', filter: '#' });
    expect(brokerSelection(undefined)).toEqual({ label: 'Not connected', filter: '#' });
  });
});

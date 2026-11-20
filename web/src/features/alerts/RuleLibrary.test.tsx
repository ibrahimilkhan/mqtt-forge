import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { RuleLibrary } from './RuleLibrary';
import { CONDITION_LABELS, CONDITION_TYPES, type DraftRule } from './ruleDraft';
import { TEMPLATE_GROUPS } from './templates';

const library = (onUse = vi.fn<(draft: DraftRule) => void>()) => {
  const onBlank = vi.fn();
  const onBack = vi.fn();

  render(<RuleLibrary onUse={onUse} onBlank={onBlank} onBack={onBack} />);

  return { onUse, onBlank, onBack };
};

/** Choose a kind in the picker at the top, as a reader does before any card is shown. */
const pick = (label: string) => userEvent.click(screen.getByRole('radio', { name: label }));

const cards = () => screen.queryAllByTestId('rule-template');

describe('the rule library', () => {
  it('shows no examples until a kind is picked, and says so', () => {
    library();

    expect(cards()).toHaveLength(0);
    expect(screen.getByText('Pick a kind to see its examples.')).toBeInTheDocument();
    for (const type of CONDITION_TYPES) {
      expect(screen.getByRole('radio', { name: CONDITION_LABELS[type] })).not.toBeChecked();
    }
  });

  it('shows only the picked kind’s examples, and what that kind does', async () => {
    library();

    for (const type of CONDITION_TYPES) {
      const label = CONDITION_LABELS[type];
      const group = TEMPLATE_GROUPS.find((one) => one.type === type)!;

      await pick(label);

      expect(screen.getByRole('radio', { name: label })).toBeChecked();
      const list = screen.getByRole('list', { name: `${label} examples` });
      expect(within(list).getAllByTestId('rule-template')).toHaveLength(group.examples.length);
      expect(cards()).toHaveLength(group.examples.length);
      expect(screen.getByText(group.says)).toBeInTheDocument();
      expect(screen.queryByText('Pick a kind to see its examples.')).not.toBeInTheDocument();
    }
  });

  it('puts the story where the example was, behind the mark, and takes it away again', async () => {
    library();
    await pick('Silence');

    const card = screen.getByRole('heading', { name: 'Battery died' }).closest('li')!;

    expect(within(card).getByText('sensors/loft/temp')).toBeInTheDocument();
    expect(within(card).queryByRole('note')).not.toBeInTheDocument();

    await userEvent.click(within(card).getByRole('button', { name: 'What Battery died means' }));

    expect(within(card).getByRole('note')).toHaveTextContent(/battery dies/);
    expect(within(card).queryByText('sensors/loft/temp')).not.toBeInTheDocument();
    expect(
      within(card).getByRole('button', { name: 'Use the Battery died example (Silence)' }),
    ).toBeInTheDocument();

    await userEvent.click(within(card).getByRole('button', { name: 'Hide what Battery died means' }));

    expect(within(card).queryByRole('note')).not.toBeInTheDocument();
  });

  it('tells one story at a time, and closes it when the kind changes', async () => {
    library();
    await pick('Range');

    await userEvent.click(screen.getByRole('button', { name: 'What Leaves its range means' }));
    await userEvent.click(screen.getByRole('button', { name: 'What Clears with a margin means' }));

    expect(screen.getAllByRole('note')).toHaveLength(1);
    expect(screen.getByRole('note')).toHaveTextContent(/1.2 and 2.3/);

    await pick('Threshold');
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
  });

  it('shows the setting that makes a card different, not only firesOn', async () => {
    library();

    await pick('Threshold');
    const lasts = screen.getByRole('heading', { name: 'Only if it lasts' }).closest('li')!;
    expect(within(lasts).getByText(/for 2 min/)).toBeInTheDocument();

    await pick('Range');
    const margin = screen.getByRole('heading', { name: 'Clears with a margin' }).closest('li')!;
    expect(within(margin).getByText(/clears at/)).toBeInTheDocument();

    await pick('Outlier');
    const memory = screen.getByRole('heading', { name: 'Short memory' }).closest('li')!;
    expect(within(memory).getByText(/last 50 readings/)).toBeInTheDocument();

    await pick('Any');
    const coldOrSilent = screen.getByRole('heading', { name: 'Cold or silent' }).closest('li')!;
    expect(within(coldOrSilent).getByText(/ OR /)).toBeInTheDocument();
  });

  it('starts from the example that was pressed, or from nothing, or goes back', async () => {
    const { onUse, onBlank, onBack } = library();

    await pick('Outlier');
    await userEvent.click(screen.getByRole('button', { name: 'Use the Tukey fence example (Outlier)' }));

    expect(onUse).toHaveBeenCalledTimes(1);
    expect(onUse.mock.calls[0][0]).toMatchObject({
      id: null,
      filter: 'sensors/flow/rate',
      condition: { type: 'outlier', method: 'tukey', k: '1.5' },
    });

    await userEvent.click(screen.getByRole('button', { name: 'Blank rule' }));
    expect(onBlank).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole('button', { name: /Back/ }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});

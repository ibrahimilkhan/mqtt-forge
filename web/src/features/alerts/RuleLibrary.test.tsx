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

const group = (label: string) => screen.getByRole('region', { name: label });

describe('the rule library', () => {
  it('holds a section for every kind, each with its own examples under it', () => {
    library();

    for (const type of CONDITION_TYPES) {
      const label = CONDITION_LABELS[type];
      const expected = TEMPLATE_GROUPS.find((one) => one.type === type)!.examples;

      expect(within(group(label)).getByRole('heading', { name: label, level: 4 })).toBeInTheDocument();
      expect(within(group(label)).getAllByTestId('rule-template')).toHaveLength(expected.length);
    }
    expect(screen.getAllByTestId('rule-template')).toHaveLength(
      TEMPLATE_GROUPS.reduce((sum, one) => sum + one.examples.length, 0),
    );
  });

  it('says what each kind does once, under its heading', () => {
    library();

    expect(within(group('Silence')).getByText('No message for a set time.')).toBeInTheDocument();
  });

  it('moves to a kind from the chips at the top', async () => {
    library();

    const chips = screen.getByRole('navigation', { name: 'Kinds of rule' });
    await userEvent.click(within(chips).getByRole('button', { name: 'Pulse' }));

    expect(within(group('Pulse')).getByRole('heading', { name: 'Pulse', level: 4 })).toHaveFocus();
  });

  it('puts the story where the example was, behind the mark, and takes it away again', async () => {
    library();

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

  it('tells one story at a time, across every kind', async () => {
    library();

    await userEvent.click(screen.getByRole('button', { name: 'What Upper limit means' }));
    await userEvent.click(screen.getByRole('button', { name: 'What Clears with a margin means' }));

    expect(screen.getAllByRole('note')).toHaveLength(1);
    expect(screen.getByRole('note')).toHaveTextContent(/1.2 and 2.3/);
  });

  it('starts from the example that was pressed, or from nothing, or goes back', async () => {
    const { onUse, onBlank, onBack } = library();

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

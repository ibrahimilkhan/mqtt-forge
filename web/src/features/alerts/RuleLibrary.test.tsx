import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { RuleLibrary } from './RuleLibrary';
import { CONDITION_LABELS, CONDITION_TYPES, faultsIn, savable, type DraftRule } from './ruleDraft';
import { TEMPLATES } from './templates';

const WHERE = { topicPrefix: 'mqttforge/alerts/', allowWebhooks: true };

const library = (onUse = vi.fn<(draft: DraftRule) => void>()) => {
  const onBlank = vi.fn();
  const onBack = vi.fn();

  render(<RuleLibrary onUse={onUse} onBlank={onBlank} onBack={onBack} />);

  return { onUse, onBlank, onBack };
};

describe('the rule library', () => {
  it('holds one example for every kind of condition the editor offers', () => {
    library();

    expect(TEMPLATES.map((one) => one.type)).toEqual([...CONDITION_TYPES]);
    expect(screen.getAllByTestId('rule-template')).toHaveLength(CONDITION_TYPES.length);

    for (const type of CONDITION_TYPES) {
      expect(screen.getByRole('heading', { name: CONDITION_LABELS[type] })).toBeInTheDocument();
    }
  });

  // An example that cannot be saved as it stands is not an example.
  it.each(TEMPLATES.map((one) => [CONDITION_LABELS[one.type], one] as const))(
    'hands over a %s rule that would save as it is',
    (_label, template) => {
      expect(faultsIn(template.draft(), WHERE)).toEqual({});
      expect(savable(faultsIn(template.draft(), WHERE))).toBe(true);
    },
  );

  it('gives a fresh copy each time, so two rules from one example share nothing', () => {
    const [first] = TEMPLATES;

    expect(first.draft()).not.toBe(first.draft());
    expect(first.draft().condition).not.toBe(first.draft().condition);
  });

  it('puts the story where the example was, behind the mark, and takes it away again', async () => {
    library();

    const card = screen.getByRole('heading', { name: 'Silence' }).closest('li')!;
    const mark = within(card).getByRole('button', { name: 'What Silence means' });

    expect(within(card).getByText('No message for a set time.')).toBeInTheDocument();
    expect(within(card).getByText('sensors/loft/temp')).toBeInTheDocument();
    expect(within(card).queryByRole('note')).not.toBeInTheDocument();

    await userEvent.click(mark);

    expect(within(card).getByRole('note')).toHaveTextContent(/battery dies/);
    expect(within(card).queryByText('sensors/loft/temp')).not.toBeInTheDocument();
    // The way on is still there with the story open.
    expect(within(card).getByRole('button', { name: 'Use the Silence template' })).toBeInTheDocument();

    await userEvent.click(within(card).getByRole('button', { name: 'Hide what Silence means' }));

    expect(within(card).queryByRole('note')).not.toBeInTheDocument();
    expect(within(card).getByText('sensors/loft/temp')).toBeInTheDocument();
  });

  it('tells one story at a time', async () => {
    library();

    await userEvent.click(screen.getByRole('button', { name: 'What Threshold means' }));
    await userEvent.click(screen.getByRole('button', { name: 'What Range means' }));

    expect(screen.getAllByRole('note')).toHaveLength(1);
    expect(screen.getByRole('note')).toHaveTextContent(/boiler/);
  });

  it('starts from the example that was pressed, or from nothing, or goes back', async () => {
    const { onUse, onBlank, onBack } = library();

    await userEvent.click(screen.getByRole('button', { name: 'Use the Outlier template' }));

    expect(onUse).toHaveBeenCalledTimes(1);
    expect(onUse.mock.calls[0][0]).toMatchObject({
      id: null,
      filter: 'home/energy/meter',
      condition: { type: 'outlier', method: 'sigma', k: '3' },
    });

    await userEvent.click(screen.getByRole('button', { name: 'Blank rule' }));
    expect(onBlank).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole('button', { name: /Back/ }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});

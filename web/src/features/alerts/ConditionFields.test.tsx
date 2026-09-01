import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ConditionFields, ConditionSummary } from './ConditionFields';
import { blankCondition, SIMPLE_TYPES, type DraftCondition } from './ruleDraft';

const draw = (condition: DraftCondition) => {
  const onChange = vi.fn();
  render(<ConditionFields condition={condition} onChange={onChange} id={(name) => `x-${name}`} />);

  return onChange;
};

/** Every box any of the forms can draw, so 'and no others' can be asserted rather than implied. */
const EVERY_FIELD = [
  'Value',
  'Low',
  'High',
  'Expression',
  'One value to a line',
  'Seconds of silence',
  'k',
  'Readings in the window',
  'Metric',
];

const only = (...shown: string[]) => {
  for (const label of shown) expect(screen.getByLabelText(label)).toBeInTheDocument();
  for (const label of EVERY_FIELD.filter((one) => !shown.includes(one))) {
    expect(screen.queryByLabelText(label)).not.toBeInTheDocument();
  }
};

describe('one form per condition', () => {
  it('draws a threshold as an operator and a number', () => {
    draw(blankCondition('threshold'));
    only('Value');
    expect(screen.getByLabelText('Operator')).toBeInTheDocument();
  });

  it('draws a band as two edges and which side is meant', () => {
    draw(blankCondition('band'));
    only('Low', 'High');
    expect(screen.getByLabelText('Inside the range')).toBeInTheDocument();
  });

  it('draws a pattern as an expression', () => {
    draw(blankCondition('pattern'));
    only('Expression');
  });

  it('draws a list as a line each', () => {
    draw(blankCondition('oneOf'));
    only('One value to a line');
  });

  it('draws a silence as its own interval', () => {
    draw(blankCondition('silence'));
    only('Seconds of silence');
  });

  it('draws an outlier as a method, a k and a window', () => {
    draw(blankCondition('outlier'));
    only('k', 'Readings in the window');
    expect(screen.getByLabelText('Method')).toBeInTheDocument();
  });

  it('draws a distribution shift as a window alone', () => {
    draw(blankCondition('distributionShift'));
    only('Readings in the window');
  });

  it('draws a shape change as a window alone', () => {
    draw(blankCondition('shapeChange'));
    only('Readings in the window');
  });

  it('draws a pulse as a metric, an operator, a value and a window', () => {
    draw(blankCondition('pulse'));
    only('Metric', 'Value', 'Readings in the window');
  });
});

describe('k means two things', () => {
  it('resets k to the deviations a sigma outlier is drawn at', async () => {
    const onChange = draw({ type: 'outlier', method: 'tukey', k: '1.5', window: '' });

    await userEvent.selectOptions(screen.getByLabelText('Method'), 'sigma');

    // Carried across, tukey 1.5 would become 1.5σ — a fence a third of the width of the one the
    // rule was written with, and nothing on screen would have said it moved.
    expect(onChange).toHaveBeenCalledWith({ type: 'outlier', method: 'sigma', k: '3', window: '' });
  });

  it('resets k to the box multiplier a tukey outlier is drawn at', async () => {
    const onChange = draw({ type: 'outlier', method: 'sigma', k: '3', window: '200' });

    await userEvent.selectOptions(screen.getByLabelText('Method'), 'tukey');

    expect(onChange).toHaveBeenCalledWith({
      type: 'outlier',
      method: 'tukey',
      k: '1.5',
      window: '200',
    });
  });

  it("says what k is measuring, in the method's own words", () => {
    draw({ type: 'outlier', method: 'sigma', k: '3', window: '' });

    expect(screen.getByText(/deviations/i)).toBeInTheDocument();
  });
});

describe('what the picker no longer has to say', () => {
  // The sentence used to be the option's own text, so eleven of them were a paragraph to choose
  // from and the closed select afterwards was a line of prose. It stands under the select now.
  it('puts the sentence under each child, saying what that child does', () => {
    draw({ type: 'all', of: [blankCondition('band'), blankCondition('silence')] });

    expect(
      screen.getByText('Fires when the reading leaves a range — or while it stays inside one.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Fires when a topic that used to speak stops.')).toBeInTheDocument();
  });

  // The tick decides which way round a range fires, and the sentence above has said both. What
  // is left for the note is what the tick itself changes.
  it('does not say twice what the sentence over the fields has already said', () => {
    draw({ type: 'all', of: [blankCondition('band')] });

    expect(screen.getByText('The 4-20mA question — a reading that has left the pair.')).toBeInTheDocument();
  });

  it('says nothing over a condition it has just admitted it cannot read', () => {
    render(<ConditionSummary type="opaque" />);

    expect(screen.queryByText(/^Fires /)).not.toBeInTheDocument();
  });
});

describe('an all of several conditions', () => {
  const three: DraftCondition = {
    type: 'all',
    of: [blankCondition('threshold'), blankCondition('pattern'), blankCondition('silence')],
  };

  /*
   * Three children used to be a 12px indent behind one continuous 2px hairline. Every child was
   * drawn exactly like its neighbours — select, label, box, select, label, box — so where one
   * ended and the next began was something a reader worked out by counting, and adding a fourth
   * changed nothing on screen but the length of the stripe.
   */
  it('gives every child a block of its own, and numbers it', () => {
    draw(three);

    const cards = document.querySelectorAll('[class*="subField"]:not([class*="subFields"])');

    expect(cards).toHaveLength(3);
    // The ordinal is on the child's own control, so it is what a screen reader hears too.
    expect(screen.getByLabelText('Condition 1')).toBeInTheDocument();
    expect(screen.getByLabelText('Condition 3')).toBeInTheDocument();
  });

  it('puts the way to remove a child at the head of that child, not under it', async () => {
    const onChange = draw(three);

    const remove = screen.getByRole('button', { name: 'Remove condition 2' });

    // In the head of card 2, beside its own label — which is also what proves it belongs to the
    // second child rather than to the block as a whole.
    const head = screen.getByLabelText('Condition 2').closest('[class*="subField"]')!;
    expect(head.contains(remove)).toBe(true);
    expect(remove.previousElementSibling?.tagName).toBe('LABEL');

    await userEvent.click(remove);

    expect(onChange).toHaveBeenCalledWith({
      type: 'all',
      of: [three.of[0], three.of[2]],
    });
  });
});

describe('the conditions this form does not draw', () => {
  it('offers no composite inside a composite', async () => {
    const onChange = draw({ type: 'all', of: [] });

    await userEvent.click(screen.getByRole('button', { name: 'Add a condition' }));

    // What it asked for is one more child, and a child is drawn from SIMPLE_TYPES alone — the
    // union is recursive and the server takes any depth, but this form must never OFFER what it
    // cannot then draw. Read off the call rather than off the screen: this component is
    // controlled, so nothing here changes until its owner hands the new condition back.
    expect(onChange).toHaveBeenCalledWith({
      type: 'all',
      of: [{ type: 'threshold', op: 'gt', value: '' }],
    });
    expect(SIMPLE_TYPES).not.toContain('all');
    expect(SIMPLE_TYPES).not.toContain('any');
  });

  it('shows a condition it cannot draw as the file has it, and does not offer to edit it', () => {
    draw({ type: 'opaque', source: { type: 'all', of: [{ type: 'any', of: [] }] } });

    expect(screen.getByTestId('condition-source')).toHaveTextContent('"type": "any"');
    expect(screen.queryByLabelText('Value')).not.toBeInTheDocument();
  });
});

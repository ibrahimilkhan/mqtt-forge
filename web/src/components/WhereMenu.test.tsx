import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import type { Where } from '../lib/sift';
import { WhereMenu } from './WhereMenu';

function Harness({ start = 'both' as Where }: { start?: Where }) {
  const [where, setWhere] = useState<Where>(start);

  return (
    <>
      <button type="button">something else</button>
      <WhereMenu label="Where to look" value={where} onChange={setWhere} />
      <span data-testid="chosen">{where}</span>
    </>
  );
}

const mark = () => screen.getByRole('button', { name: /^Where to look/ });
const choices = () => screen.queryAllByRole('menuitemradio');

describe('choosing where a search looks', () => {
  it('says which answer is chosen without being opened', () => {
    render(<Harness start="body" />);

    expect(mark()).toHaveAccessibleName('Where to look: Message');
    expect(choices()).toHaveLength(0);
  });

  it('offers the three, with the chosen one marked', async () => {
    render(<Harness />);

    await userEvent.click(mark());

    expect(choices().map((one) => one.textContent)).toEqual(['Both', 'Topic', 'Message']);
    expect(screen.getByRole('menuitemradio', { name: 'Both' })).toBeChecked();
  });

  it('takes the answer and shuts', async () => {
    render(<Harness />);
    await userEvent.click(mark());

    await userEvent.click(screen.getByRole('menuitemradio', { name: 'Topic' }));

    expect(screen.getByTestId('chosen')).toHaveTextContent('topic');
    expect(choices()).toHaveLength(0);
  });

  // A menu that stayed open behind whatever the reader did next would be one they have to come
  // back and dismiss.
  it('shuts on Escape', async () => {
    render(<Harness />);
    await userEvent.click(mark());

    await userEvent.keyboard('{Escape}');

    expect(choices()).toHaveLength(0);
  });

  it('shuts when the reader goes somewhere else', async () => {
    render(<Harness />);
    await userEvent.click(mark());

    await userEvent.click(screen.getByRole('button', { name: 'something else' }));

    expect(choices()).toHaveLength(0);
  });
});

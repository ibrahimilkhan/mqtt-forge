import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useProseSelection } from './useProseSelection';

function Page() {
  useProseSelection();
  return (
    <div>
      <p>Stored in this browser only.</p>
      <p>A second paragraph nobody asked for.</p>
      <button type="button">Connect</button>
    </div>
  );
}

// The browser's own word expansion runs off a second press, so that is what the tests send.
function press(target: Element, detail: number) {
  target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, detail }));
}

function selected() {
  return window.getSelection()?.toString() ?? '';
}

describe('useProseSelection', () => {
  it('takes the whole paragraph, and nothing past it', () => {
    const { getByText } = render(<Page />);

    press(getByText('Stored in this browser only.'), 2);

    expect(selected()).toBe('Stored in this browser only.');
  });

  it('leaves a single click alone, so a caret still lands where it was put', () => {
    const { getByText } = render(<Page />);
    window.getSelection()?.removeAllRanges();

    press(getByText('Stored in this browser only.'), 1);

    expect(selected()).toBe('');
  });

  it('ignores a double click outside prose, where the page has its own meaning for it', () => {
    const { getByRole } = render(<Page />);
    window.getSelection()?.removeAllRanges();

    press(getByRole('button', { name: 'Connect' }), 2);

    expect(selected()).toBe('');
  });
});

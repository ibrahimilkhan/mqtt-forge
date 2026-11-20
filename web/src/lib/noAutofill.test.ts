import { afterEach, describe, expect, it } from 'vitest';
import { stopAutofill } from './noAutofill';

let stop: (() => void) | null = null;

afterEach(() => {
  stop?.();
  stop = null;
  document.body.innerHTML = '';
});

const focus = (element: HTMLElement) =>
  element.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));

describe('the browser does not offer what was typed before', () => {
  it('turns suggestions off on a text box the moment it is focused', () => {
    stop = stopAutofill(document);
    document.body.innerHTML = '<input id="a" /><textarea id="b"></textarea>';

    focus(document.getElementById('a')!);
    focus(document.getElementById('b')!);

    expect(document.getElementById('a')).toHaveAttribute('autocomplete', 'off');
    expect(document.getElementById('b')).toHaveAttribute('autocomplete', 'off');
  });

  it('covers a box drawn after it started, and one inside no form', () => {
    stop = stopAutofill(document);
    const late = document.createElement('input');
    document.body.append(late);

    focus(late);

    expect(late).toHaveAttribute('autocomplete', 'off');
  });

  it('leaves alone a box that already says what it wants', () => {
    stop = stopAutofill(document);
    document.body.innerHTML = '<input id="a" autocomplete="new-password" />';

    focus(document.getElementById('a')!);

    expect(document.getElementById('a')).toHaveAttribute('autocomplete', 'new-password');
  });

  it('does nothing to controls that are not text, and stops when asked', () => {
    stop = stopAutofill(document);
    document.body.innerHTML = '<button id="b"></button><input id="a" />';

    focus(document.getElementById('b')!);
    expect(document.getElementById('b')).not.toHaveAttribute('autocomplete');

    stop();
    stop = null;
    focus(document.getElementById('a')!);
    expect(document.getElementById('a')).not.toHaveAttribute('autocomplete');
  });
});

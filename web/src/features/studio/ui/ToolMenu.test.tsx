import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ToolMenu } from './ToolMenu';

/** A menu of two items beside a button that stands for the rest of the page. */
function Fixture({ onPick = () => {}, onPageKey = () => {} }: { onPick?: (item: string) => void; onPageKey?: (key: string) => void }) {
  return (
    <div onKeyDown={(e) => onPageKey(e.key)}>
      <ToolMenu title="Add a shape" ariaLabel="Add a shape" kind="menu" trigger="+">
        {(close) =>
          ['Box', 'Sphere'].map((item) => (
            <button key={item} type="button" role="menuitem" onClick={() => { onPick(item); close(); }}>
              {item}
            </button>
          ))
        }
      </ToolMenu>
      <button type="button">Elsewhere</button>
    </div>
  );
}

const trigger = () => screen.getByRole('button', { name: 'Add a shape' });

describe('ToolMenu', () => {
  it('is only in the document while it is open, and the trigger names it only then', async () => {
    render(<Fixture />);
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');
    expect(trigger()).not.toHaveAttribute('aria-controls');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    await userEvent.click(trigger());

    const menu = screen.getByRole('menu', { name: 'Add a shape' });
    expect(trigger()).toHaveAttribute('aria-expanded', 'true');
    expect(trigger()).toHaveAttribute('aria-controls', menu.id);
    expect(trigger()).toHaveAttribute('aria-haspopup', 'menu');
  });

  it('puts the keyboard on the first item, and the arrows walk the rest', async () => {
    render(<Fixture />);
    await userEvent.click(trigger());
    expect(screen.getByRole('menuitem', { name: 'Box' })).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: 'Sphere' })).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: 'Box' })).toHaveFocus();
  });

  it('shuts on Escape, gives the keyboard back to the trigger, and the page never sees the key', async () => {
    const onPageKey = vi.fn();
    render(<Fixture onPageKey={onPageKey} />);
    await userEvent.click(trigger());

    await userEvent.keyboard('{Escape}');

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger()).toHaveFocus();
    expect(onPageKey).not.toHaveBeenCalledWith('Escape');
  });

  it('shuts on a press anywhere outside it', async () => {
    render(<Fixture />);
    await userEvent.click(trigger());

    await userEvent.click(screen.getByRole('button', { name: 'Elsewhere' }));

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('shuts once an item is chosen, and the keyboard is back on the trigger', async () => {
    const onPick = vi.fn();
    render(<Fixture onPick={onPick} />);
    await userEvent.click(trigger());

    await userEvent.click(screen.getByRole('menuitem', { name: 'Sphere' }));

    expect(onPick).toHaveBeenCalledWith('Sphere');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger()).toHaveFocus();
  });

  it('opens from the keyboard and shuts on a second press of the trigger', async () => {
    render(<Fixture />);
    trigger().focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getByRole('menu')).toBeInTheDocument();

    await userEvent.click(trigger());
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('opens on a whole real press — pointer down, mouse down, pointer up, mouse up, click — and stays open', () => {
    render(<Fixture />);
    const inner = trigger().firstChild ?? trigger();
    fireEvent.pointerDown(trigger(), { button: 0 });
    fireEvent.mouseDown(trigger(), { button: 0 });
    fireEvent.pointerUp(trigger(), { button: 0 });
    fireEvent.mouseUp(trigger(), { button: 0 });
    fireEvent.click(inner);
    expect(trigger()).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  it('is one toggle per press, even when something opens the popup while the button is held', () => {
    render(<Fixture />);
    fireEvent.pointerDown(trigger(), { button: 0 });
    // Opened in the middle of the press — the click that ends it must not shut it again.
    fireEvent.keyDown(trigger(), { key: 'ArrowDown' });
    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent.pointerUp(trigger(), { button: 0 });
    fireEvent.click(trigger());
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  it('gives the keyboard to the item already in use rather than the first', async () => {
    render(
      <ToolMenu title="Pick" ariaLabel="Pick" kind="dialog" trigger="v">
        <button type="button">First</button>
        <button type="button" aria-current="true">Current</button>
      </ToolMenu>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Pick' }));
    expect(screen.getByRole('button', { name: 'Current' })).toHaveFocus();
  });
});

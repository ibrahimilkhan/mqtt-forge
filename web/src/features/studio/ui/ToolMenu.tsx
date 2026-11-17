import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import styles from './ToolMenu.module.css';

/** Whatever in an open popup a reader can land on, in the order they would Tab through it. */
const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])';

/** The gap between the trigger's lower edge and the popup, and the least room kept to the window's edge. */
const GAP = 4;
const MARGIN = 8;

type Props = {
  /** The tooltip, and the trigger's accessible name when `ariaLabel` is not given and it shows no text. */
  title: string;
  /** For a trigger that is a mark alone; one that prints its own words takes its name from them. */
  ariaLabel?: string;
  /** What the trigger shows: a glyph, a name, and the chevron that says it opens rather than acts. */
  trigger: ReactNode;
  /**
   * A list of things to pick from is a `menu`; a popup holding fields, or a mix of a list and the
   * inline steps scene management needs (a name to type, a delete to confirm), is a `dialog` — a
   * menu may hold nothing but its items, and a screen reader in one would not reach a text box.
   */
  kind: 'menu' | 'dialog';
  triggerClassName?: string;
  /** Held by the caller when something other than a press has to open it — a failure to show. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Handed `close`, which shuts the popup; a keyboard that was in it goes back to the trigger. */
  children: ReactNode | ((close: () => void) => ReactNode);
};

/**
 * A toolbar button that opens a small popup under itself: the studio's one-row toolbar folds
 * everything that is not pressed often into these.
 *
 * The popup is drawn into the document's body rather than inside the toolbar. The toolbar scrolls
 * sideways on a narrow window, and a scrolling box clips whatever hangs out of it on both axes —
 * a popup inside it would be cut off at the toolbar's lower edge, which is the whole of where it
 * has to go. So it is placed with `position: fixed` from where the trigger is on screen. Fixed
 * inside the panel would not do either: a box with layout containment (a container query, of
 * which the console has several) becomes the frame a fixed descendant is placed against. React
 * still bubbles the popup's events through the tree it was written in, so the studio's own key
 * handling sees them as if it were where it is written.
 *
 * It is only in the document while it is open, so the trigger's `aria-controls` never names a
 * popup that is not there. It shuts on Escape (the keyboard goes back to the trigger), on a press
 * anywhere outside it, when the keyboard leaves it, and when an item is chosen — the caller calls
 * `close` for that, so a popup with a field in it can stay open while the field is in use.
 */
export function ToolMenu({ title, ariaLabel, trigger, kind, triggerClassName, open: held, onOpenChange, children }: Props) {
  const [own, setOwn] = useState(false);
  const open = held ?? own;
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<CSSProperties>({});

  const setOpen = useCallback(
    (next: boolean) => {
      if (held === undefined) setOwn(next);
      onOpenChange?.(next);
    },
    [held, onOpenChange],
  );

  const close = useCallback(() => setOpen(false), [setOpen]);

  // Whether the keyboard is in the popup. When the popup goes — Escape, an item chosen, or some
  // slow work that shut it once done — a keyboard that was in it would otherwise fall to the
  // document's body and the next Tab would start from the top of the console; it comes back to
  // the trigger instead. Only then: a reader who has gone somewhere else since is left there.
  const holds = useRef(false);
  useEffect(() => {
    if (open || !holds.current) return;
    holds.current = false;
    const active = document.activeElement;
    if (!active || active === document.body) button.current?.focus();
  }, [open]);

  // Measured before paint, so the popup is never seen at the top of the window for a frame first.
  // Kept to the window: a trigger at the far right of the row opens its popup leftwards instead.
  const measure = useCallback(() => {
    const anchor = button.current?.getBoundingClientRect();
    const body = popup.current;
    if (!anchor || !body) return;
    const room = document.documentElement.clientWidth;
    const left = Math.max(MARGIN, Math.min(anchor.left, room - body.offsetWidth - MARGIN));
    const top = anchor.bottom + GAP;
    setPlace({ top, left, maxHeight: `calc(100vh - ${top + MARGIN}px)` });
  }, []);

  useLayoutEffect(() => {
    if (open) measure();
  }, [open, measure]);

  // The listeners below outlive any one render, and must shut the popup as the latest render
  // would: a caller holding `open` hands a new `onOpenChange` every time it draws.
  const latest = useRef(setOpen);
  useEffect(() => {
    latest.current = setOpen;
  }, [setOpen]);

  // Only on opening: run again on every redraw, it would pull the keyboard back to the first item.
  useEffect(() => {
    // The first thing in it takes the keyboard, so a reader who opened it from the keys is in it.
    if (open) popup.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (popup.current?.contains(target) || button.current?.contains(target)) return;
      // The reader has put the pointer somewhere else, and the keyboard follows it there.
      holds.current = false;
      latest.current(false);
    };
    // Any scroll can move the trigger out from over the popup — the toolbar's own sideways scroll
    // as much as the page's — so the popup follows it. Captured, because scroll does not bubble.
    const follow = () => measure();
    // The window resizing is the document's root resizing; jsdom has no observer to say so.
    const sized = typeof ResizeObserver === 'function' ? new ResizeObserver(follow) : null;
    sized?.observe(document.documentElement);
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('scroll', follow, true);
    return () => {
      sized?.disconnect();
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('scroll', follow, true);
    };
  }, [open, measure]);

  // The keys stay in the popup while it has them: a W typed on a menu item must not swap the tool
  // under it, and an Escape that shuts the menu must not also clear the selection behind it.
  const onPopupKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (kind !== 'menu' || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return;
    event.preventDefault();
    const items = [...(popup.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = event.key === 'ArrowDown' ? at + 1 : at - 1;
    items[(next + items.length) % items.length]?.focus();
  };

  // Keyboard gone somewhere else entirely. A focus with nowhere named — the window losing focus to
  // the file picker the import opens — is not the reader leaving, so that one keeps it open.
  const onPopupBlur = (event: FocusEvent<HTMLDivElement>) => {
    const to = event.relatedTarget as Node | null;
    if (!to || popup.current?.contains(to) || button.current?.contains(to)) return;
    holds.current = false;
    setOpen(false);
  };

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (open && event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    } else if (!open && event.key === 'ArrowDown') {
      event.preventDefault();
      setOpen(true);
    }
  };

  return (
    <>
      <button
        ref={button}
        type="button"
        className={triggerClassName}
        title={title}
        aria-label={ariaLabel}
        aria-haspopup={kind}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen(!open)}
        onKeyDown={onTriggerKeyDown}
      >
        {trigger}
      </button>
      {open &&
        createPortal(
          <div
            ref={popup}
            id={id}
            role={kind}
            aria-label={ariaLabel ?? title}
            className={styles.popup}
            style={place}
            onKeyDown={onPopupKeyDown}
            onFocus={() => {
              holds.current = true;
            }}
            onBlur={onPopupBlur}
          >
            {typeof children === 'function' ? children(close) : children}
          </div>,
          document.body,
        )}
    </>
  );
}

import { useEffect, useRef, useState } from 'react';
import styles from './ColoursPanel.module.css';
import { PALETTE } from './palette';

type Props = {
  /** Null only where `clearable` says one is allowed: the message's colour, left as the ink. */
  colour: string | null;
  filter: string;
  /** Which half of a row this paints, said in the word the control names itself with. */
  what: 'topic' | 'message';
  /** Whether 'none' is one of the answers. It is, for the message; a topic is always painted. */
  clearable?: boolean;
  /** Where the free picker starts when there is no colour yet. The row's other colour, not black. */
  fallback?: string;
  onChange: (colour: string | null) => void;
};

/**
 * The current colour as a swatch; clicking it offers the shortlist first and the whole picker
 * after it. Free choice was the requirement, but a chosen-for-you set is what most rules want,
 * and it keeps a rule one click from a colour that reads at 7px.
 *
 * Two of these stand in a row now — the topic's colour and the message's — so each says which
 * one it is in its own accessible name. Nothing on screen labels them: they sit under two headed
 * columns, and a swatch with a word beside it in a table that already has a header for it is the
 * row saying everything twice.
 */
export function ColourPicker({
  colour,
  filter,
  what,
  clearable = false,
  fallback = '#000000',
  onChange,
}: Props) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);

  // A popover that only closed on its own button would be left hanging over the next row.
  // Escape as well as a click away: the popover covers the row below it, and someone who
  // opened it from the keyboard has no click to dismiss it with.
  useEffect(() => {
    if (!open) return;

    const dismissOnClick = (event: MouseEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };

    document.addEventListener('mousedown', dismissOnClick);
    document.addEventListener('keydown', dismissOnEscape);

    return () => {
      document.removeEventListener('mousedown', dismissOnClick);
      document.removeEventListener('keydown', dismissOnEscape);
    };
  }, [open]);

  const label = filter === '' ? 'this rule' : filter;

  return (
    <div className={styles.picker} ref={container}>
      <button
        type="button"
        className={styles.swatchButton}
        aria-expanded={open}
        aria-label={`Choose a ${what} colour for ${label}`}
        onClick={() => setOpen((wasOpen) => !wasOpen)}
      >
        {/* An unpainted message is drawn as an empty swatch rather than as the ink it will
            actually be: the ink is near-black in one theme and near-white in the other, and a
            swatch showing it would read as somebody's deliberate choice of black. */}
        <span
          className={styles.swatch}
          data-testid={what === 'topic' ? 'swatch' : 'body-swatch'}
          data-none={colour === null ? '' : undefined}
          style={colour ? { background: colour } : undefined}
        />
      </button>

      {open && (
        <div className={styles.popover}>
          <div className={styles.suggestions}>
            {PALETTE.map((suggestion) => (
              <button
                key={suggestion.value}
                type="button"
                className={styles.suggestion}
                aria-label={suggestion.name}
                aria-pressed={suggestion.value === colour?.toLowerCase()}
                style={{ background: suggestion.value }}
                onClick={() => {
                  onChange(suggestion.value);
                  setOpen(false);
                }}
              />
            ))}
          </div>

          {/* The way back out, and only where there is one. Under the shortlist rather than in
              it: it is not a ninth colour, it is the answer 'leave this alone', which is what
              every rule says until somebody says otherwise. */}
          {clearable && (
            <button
              type="button"
              className={styles.noColour}
              aria-pressed={colour === null}
              title="Draw the message in the console's own ink"
              onClick={() => {
                onChange(null);
                setOpen(false);
              }}
            >
              <span className={styles.swatch} data-none="" />
              No colour
            </button>
          )}

          {/* Left open after a custom pick: the swatch is behind the popover, so closing it
              would hide the only feedback that the colour took. */}
          <label className={styles.custom}>
            Custom colour
            <input
              type="color"
              // An unpainted message opens the free picker on the topic's colour rather than on
              // black: black beside a pressed 'No colour' reads as a colour somebody chose, and
              // the two halves of one rule are usually meant to be near each other anyway.
              value={colour ?? fallback}
              onChange={(event) => onChange(event.target.value)}
            />
          </label>
        </div>
      )}
    </div>
  );
}

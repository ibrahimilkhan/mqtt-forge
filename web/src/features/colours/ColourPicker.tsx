import { useEffect, useRef, useState } from 'react';
import styles from './ColoursPanel.module.css';
import { SUGGESTED } from './palette';

type Props = { colour: string; filter: string; onChange: (colour: string) => void };

/**
 * The current colour as a swatch; clicking it offers the shortlist first and the whole picker
 * after it. Free choice was the requirement, but a chosen-for-you set is what most rules want,
 * and it keeps a rule one click from a colour that reads at 7px.
 */
export function ColourPicker({ colour, filter, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);

  // A popover that only closed on its own button would be left hanging over the next row.
  useEffect(() => {
    if (!open) return;

    const dismiss = (event: MouseEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };

    document.addEventListener('mousedown', dismiss);
    return () => document.removeEventListener('mousedown', dismiss);
  }, [open]);

  const label = filter === '' ? 'this rule' : filter;

  return (
    <div className={styles.picker} ref={container}>
      <button
        type="button"
        className={styles.swatchButton}
        aria-expanded={open}
        aria-label={`Choose a colour for ${label}`}
        onClick={() => setOpen((wasOpen) => !wasOpen)}
      >
        <span className={styles.swatch} data-testid="swatch" style={{ background: colour }} />
      </button>

      {open && (
        <div className={styles.popover}>
          <div className={styles.suggestions}>
            {SUGGESTED.map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                className={styles.suggestion}
                aria-label={suggestion}
                aria-pressed={suggestion === colour.toLowerCase()}
                style={{ background: suggestion }}
                onClick={() => {
                  onChange(suggestion);
                  setOpen(false);
                }}
              />
            ))}
          </div>

          {/* Left open after a custom pick: the swatch is behind the popover, so closing it
              would hide the only feedback that the colour took. */}
          <label className={styles.custom}>
            Custom colour
            <input
              type="color"
              value={colour}
              onChange={(event) => onChange(event.target.value)}
            />
          </label>
        </div>
      )}
    </div>
  );
}

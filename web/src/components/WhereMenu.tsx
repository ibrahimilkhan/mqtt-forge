import { useEffect, useRef, useState } from 'react';
import { Funnel } from '../features/brand/icons';
import { WHERE_OPTIONS, type Where } from '../lib/sift';
import styles from './SearchBox.module.css';

/**
 * Where a search looks: the topic, the message, or both.
 *
 * A mark with three answers behind it. It was a select, and a select is a word wide — beside a
 * search box in a pane that is already narrow, the row read as two controls of equal weight when
 * one of them is the search and the other is a detail of it. This one is the size of every other
 * mark in the row it stands in, and it says which answer is chosen where a listener can hear it.
 *
 * It ships on 'Both', which is what a reader who has not thought about it means. The choice is
 * worth having because the two searches genuinely differ: `error` in the topics finds the topics
 * named for errors, and `error` in the messages finds the ones reporting them.
 */
export function WhereMenu({
  label,
  value,
  onChange,
}: {
  /** What is being narrowed — 'Where to look in the log'. The chosen answer is said with it. */
  label: string;
  value: Where;
  onChange: (where: Where) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  const chosen = WHERE_OPTIONS.find((one) => one.value === value) ?? WHERE_OPTIONS[0];

  // Shuts on the way out, whichever way the reader leaves: another control, a click on the pane
  // behind it, or Escape. A menu that stayed open behind the thing it was covering would be a
  // menu the reader has to come back and dismiss.
  useEffect(() => {
    if (!open) return;

    const away = (event: Event) => {
      if (!wrap.current?.contains(event.target as Node)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };

    document.addEventListener('pointerdown', away);
    document.addEventListener('focusin', away);
    document.addEventListener('keydown', key);

    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('focusin', away);
      document.removeEventListener('keydown', key);
    };
  }, [open]);

  return (
    <span className={styles.menuWrap} ref={wrap}>
      <button
        type="button"
        className={styles.opener}
        aria-label={`${label}: ${chosen.label}`}
        aria-expanded={open}
        aria-haspopup="menu"
        title={`${label} — ${chosen.label.toLowerCase()}`}
        onClick={() => setOpen((shown) => !shown)}
      >
        <Funnel />
      </button>

      {open && (
        <span className={styles.menu} role="menu">
          {WHERE_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              role="menuitemradio"
              aria-checked={option.value === value}
              className={styles.choice}
              onClick={() => {
                onChange(option.value);
                setOpen(false);
              }}
            >
              {option.label}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}

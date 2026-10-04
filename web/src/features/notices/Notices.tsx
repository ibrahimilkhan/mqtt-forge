import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FocusEvent } from 'react';
import { NOTICE_MS, useNoticeStore, type Notice } from '../../stores/noticeStore';
import styles from './Notices.module.css';

/**
 * The notices Notify nodes asked for, stacked in the bottom inline-end corner of the console, the
 * newest on top. Each goes by itself eight seconds after it came, or with its Close — but not while
 * the reader is at it, with the pointer or the keyboard: it waits, and has its eight seconds again
 * once the reader has gone. One that went from under the pointer was gone before it was read.
 *
 * One polite live region for the stack: a notice is news, not an interruption, and a reader using a
 * screen reader is told it once, as it comes, without losing their place.
 *
 * A log, as the alert wall is, and not a status, as the health line is. A status is read out whole
 * whenever anything in it changes, which is right for a line that is one fact; a log is read out by
 * what was added to it, so a notice coming in is told on its own and not together with the three
 * still standing beside it.
 *
 * A notice that goes with the keyboard in it — its Close pressed from the keyboard, or pushed out of
 * the stack by a fifth — takes the keyboard with it, and a browser hands that to the body: the next
 * Tab starts again from the top of the document. The reader goes to the next notice's Close instead,
 * or the one before it when it was the last; and with none left, back where they came into the stack
 * from — or, when that has gone too, to the stack itself, which stays in the page and is not a stop
 * on the Tab key.
 */
export function Notices() {
  const notices = useNoticeStore((state) => state.notices);
  const stack = useRef<HTMLDivElement>(null);
  // Where the keyboard came into the stack from, and the notice it was in when that notice went.
  const cameFrom = useRef<HTMLElement | null>(null);
  const lost = useRef<number | null>(null);
  const before = useRef(notices);

  const tookTheKeyboard = useCallback((id: number) => {
    lost.current = id;
  }, []);

  // Only from outside the stack, and only from an element still in the page: the keyboard put on a
  // Close here, after the notice it was in went, comes from nothing that is there any more.
  const entered = (event: FocusEvent) => {
    const from = event.relatedTarget;
    if (from instanceof HTMLElement && from.isConnected && !stack.current?.contains(from)) cameFrom.current = from;
  };

  // After the notices are drawn as they are now, and before the paint: the next notice is that of
  // those that stood before, or the nearest one before it, that still stands.
  useLayoutEffect(() => {
    const was = before.current;
    before.current = notices;
    const gone = lost.current;
    lost.current = null;
    if (gone === null) return;

    const at = was.findIndex((one) => one.id === gone);
    const standing = new Set(notices.map((one) => one.id));
    const next = [...was.slice(at + 1), ...was.slice(0, at).reverse()].find((one) => standing.has(one.id));
    const card = next === undefined ? undefined : stack.current?.children[notices.findIndex((one) => one.id === next.id)];
    const close = card?.querySelector<HTMLElement>('button');

    if (close) close.focus();
    else if (cameFrom.current?.isConnected) cameFrom.current.focus();
    else stack.current?.focus();
  }, [notices]);

  return (
    <div
      ref={stack}
      className={styles.stack}
      role="log"
      aria-live="polite"
      aria-label="Notices"
      tabIndex={-1}
      onFocus={entered}
    >
      {notices.map((notice) => (
        <NoticeCard key={notice.id} notice={notice} onTakeTheKeyboard={tookTheKeyboard} />
      ))}
    </div>
  );
}

function NoticeCard({ notice, onTakeTheKeyboard }: { notice: Notice; onTakeTheKeyboard: (id: number) => void }) {
  const dismiss = useNoticeStore((state) => state.dismiss);
  const card = useRef<HTMLDivElement>(null);
  const [pointedAt, setPointedAt] = useState(false);
  const [focused, setFocused] = useState(false);
  const held = pointedAt || focused;

  // One timer for each card, started as it is drawn and let go with it: a card the stack pushes
  // out, or the reader closes, takes its own timer with it, and a card arriving never restarts the
  // ones already standing. Held while the reader is at the card, and started again, from eight
  // seconds, once they have gone.
  useEffect(() => {
    if (held) return;
    const timer = setTimeout(() => dismiss(notice.id), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [dismiss, held, notice.id]);

  // As the card goes, while it is still in the page — before the browser hands the keyboard to the
  // body — whether the keyboard was in it, for the stack to put it somewhere else.
  useLayoutEffect(() => {
    const element = card.current;
    return () => {
      if (element?.contains(document.activeElement)) onTakeTheKeyboard(notice.id);
    };
  }, [notice.id, onTakeTheKeyboard]);

  return (
    <div
      ref={card}
      className={styles.notice}
      data-level={notice.level}
      onMouseEnter={() => setPointedAt(true)}
      onMouseLeave={() => setPointedAt(false)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
      }}
    >
      <div className={styles.head}>
        {/* The level in a word, and first. The edge's colour is the second signal and this is the
            first: a screen reader has no colour to read, forced colours takes the edge's away, and
            a reader who cannot tell the three apart has neither. The raw word, as the rules table
            prints it and as the Notify node that said this calls its level — not the alarm wall's
            "warning", which is the wall's own word for an alarm standing. */}
        <span className={styles.level}>{notice.level}</span>
        <span className={styles.flow}>{notice.flowName}</span>
        {notice.test && <span className={styles.test}>test</span>}
      </div>
      <p className={styles.text}>{notice.text}</p>
      {/* Last in the markup, because a screen reader goes through a card in the order it is written
          and the way to be rid of a notice is the last thing to say about it, not the first. The
          stylesheet stands it back at the end of the first line, where an eye looks for it. Named
          for the flow and for what the notice says, since four notices stand at once — one flow can
          say one for each sensor that runs hot — and four buttons that all say Close can only be
          told apart by where they happen to be. */}
      <button
        type="button"
        className={`ghost ${styles.close}`}
        aria-label={`Close notice from ${notice.flowName}: ${notice.text}`}
        onClick={() => dismiss(notice.id)}
      >
        ×
      </button>
    </div>
  );
}

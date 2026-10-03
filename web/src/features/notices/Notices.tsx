import { useEffect } from 'react';
import { NOTICE_MS, useNoticeStore, type Notice } from '../../stores/noticeStore';
import styles from './Notices.module.css';

/**
 * The notices Notify nodes asked for, stacked in the bottom inline-end corner of the console, the
 * newest on top. Each goes by itself after eight seconds, or with its Close.
 *
 * One polite live region for the stack: a notice is news, not an interruption, and a reader using a
 * screen reader is told it once, as it comes, without losing their place.
 *
 * A log, as the alert wall is, and not a status, as the health line is. A status is read out whole
 * whenever anything in it changes, which is right for a line that is one fact; a log is read out by
 * what was added to it, so a notice coming in is told on its own and not together with the three
 * still standing beside it.
 */
export function Notices() {
  const notices = useNoticeStore((state) => state.notices);

  return (
    <div className={styles.stack} role="log" aria-live="polite" aria-label="Notices">
      {notices.map((notice) => (
        <NoticeCard key={notice.id} notice={notice} />
      ))}
    </div>
  );
}

function NoticeCard({ notice }: { notice: Notice }) {
  const dismiss = useNoticeStore((state) => state.dismiss);

  // One timer for each card, started as it is drawn and let go with it: a card the stack pushes
  // out, or the reader closes, takes its own timer with it, and a card arriving never restarts the
  // ones already standing.
  useEffect(() => {
    const timer = setTimeout(() => dismiss(notice.id), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [dismiss, notice.id]);

  return (
    <div className={styles.notice} data-level={notice.level}>
      <div className={styles.head}>
        {/* The level in a word, and first. The edge's colour is the second signal and this is the
            first: a screen reader has no colour to read, forced colours takes the edge's away, and
            a reader who cannot tell the three apart has neither. The raw word, as the rules table
            prints it and as a flow's own nodes call the levels, so one level is one word wherever
            the console says it. */}
        <span className={styles.level}>{notice.level}</span>
        <span className={styles.flow}>{notice.flowName}</span>
        {notice.test && <span className={styles.test}>test</span>}
      </div>
      <p className={styles.text}>{notice.text}</p>
      {/* Last in the markup, because a screen reader goes through a card in the order it is written
          and the way to be rid of a notice is the last thing to say about it, not the first. The
          stylesheet stands it back at the end of the first line, where an eye looks for it. Named
          for the flow, since four notices stand at once and four buttons that all say Close can only
          be told apart by where they happen to be. */}
      <button
        type="button"
        className={`ghost ${styles.close}`}
        aria-label={`Close notice from ${notice.flowName}`}
        onClick={() => dismiss(notice.id)}
      >
        ×
      </button>
    </div>
  );
}

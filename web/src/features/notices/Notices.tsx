import { useEffect } from 'react';
import { NOTICE_MS, useNoticeStore, type Notice } from '../../stores/noticeStore';
import styles from './Notices.module.css';

/**
 * The notices Notify nodes asked for, stacked in the bottom inline-end corner of the console, the
 * newest on top. Each goes by itself after eight seconds, or with its Close.
 *
 * One polite live region for the stack: a notice is news, not an interruption, and a reader using a
 * screen reader is told it once, as it comes, without losing their place.
 */
export function Notices() {
  const notices = useNoticeStore((state) => state.notices);

  return (
    <div className={styles.stack} aria-live="polite" aria-label="Notices">
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
        <span className={styles.flow}>{notice.flowName}</span>
        {notice.test && <span className={styles.test}>test</span>}
        <button type="button" className={`ghost ${styles.close}`} aria-label="Close" onClick={() => dismiss(notice.id)}>
          ×
        </button>
      </div>
      <p className={styles.text}>{notice.text}</p>
    </div>
  );
}

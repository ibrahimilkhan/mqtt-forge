import { useEffect, useState } from 'react';

/**
 * The current time, refreshed on a beat.
 *
 * Everything else in the pane is drawn when something arrives. Silence is the one fact that
 * becomes true when nothing does, so a component that has to notice it needs a reason to
 * re-render — this is that reason, and only while there is something to notice.
 */
export function useNow(every: number | null): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (every === null) return;

    const beat = window.setInterval(() => setNow(Date.now()), every);
    return () => window.clearInterval(beat);
  }, [every]);

  return now;
}

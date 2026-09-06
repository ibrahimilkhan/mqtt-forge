import { useEffect, useState } from 'react';

// Its own component because it is the only thing in the summary that changes on its own: kept
// separate, the once-a-second re-render costs one line instead of the whole panel.
export function ConnectedFor({ since }: { since: string }) {
  const startedAt = Date.parse(since);
  const [elapsed, setElapsed] = useState(() => Date.now() - startedAt);

  useEffect(() => {
    // Fires once up front too: a remount mid-second would otherwise show the stale initial
    // value until the first tick lands.
    const tick = () => setElapsed(Date.now() - startedAt);
    tick();

    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [startedAt]);

  return <time dateTime={since}>{`${wallClock(startedAt)} · ${howLong(elapsed)}`}</time>;
}

// Local time with seconds, 24-hour: this is a stopwatch reading, not a date, and it has to line
// up with the count beside it — and with the log's own rows, which is the reason for naming a
// locale rather than taking the machine's. `hour12: false` fixes the clock but not the shape of
// it: a machine set to fr-CA writes '00 h 05 min 00 s' where every other time in this console
// reads '00:05:00', and the two sitting a pane apart look like two different kinds of fact.
function wallClock(startedAt: number): string {
  return new Date(startedAt).toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

// One step of granularity is all this is read for; the clock beside it carries the precision.
function howLong(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds} sec`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;

  return `${Math.floor(minutes / 60)} hr ${minutes % 60} min`;
}

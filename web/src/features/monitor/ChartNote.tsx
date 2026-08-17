import type { Fit } from '../../lib/distribution';
import { duration, short } from '../../lib/format';
import type { Cadence, Summary } from '../../lib/stats';
import styles from './TrafficChart.module.css';

type Item = { text: string; title: string; verdict?: boolean; drifting?: boolean; alarm?: boolean };

/**
 * What the run adds up to, in the corner of the chart that draws it.
 *
 * The numbers come first and the readings of them after: how many there are, where their middle
 * is and how far they stray, then what that shape is, which way it is going, how often it
 * arrives, and what had to be left out to say any of it. Every item carries the long form of
 * itself on hover, because 'σ' is only obvious to the half of the room that already knew.
 */
export function ChartNote({
  summary,
  fit,
  pace,
  skipped,
  silence = null,
  quartiles = false,
}: {
  summary: Summary;
  fit: Fit | null;
  pace: Cadence | null;
  skipped: number;
  /** How long the topic has been quiet, when that is longer than its own rhythm allows. */
  silence?: number | null;
  /** The middle half and the fences around it, for a reader who came for the numbers. */
  quartiles?: boolean;
}) {
  const items: Item[] = [
    { text: `n ${summary.n}`, title: `${summary.n} readings charted` },
    { text: `x̄ ${short(summary.mean)}`, title: 'mean' },
    { text: `M ${short(summary.median)}`, title: 'median' },
  ];

  if (summary.sd > 0) {
    items.push({ text: `σ ${short(summary.sd)}`, title: 'standard deviation, over all readings held' });
    items.push({
      // A dash between a negative low and its high reads as arithmetic; the word does not.
      text:
        summary.low < 0 || summary.high < 0
          ? `${short(summary.low)} to ${short(summary.high)}`
          : `${short(summary.low)}–${short(summary.high)}`,
      title: `lowest to highest · quartiles ${short(summary.q1)} and ${short(summary.q3)}`,
    });
  }

  if (quartiles && summary.sd > 0) {
    items.push({
      text: `Q ${short(summary.q1)}–${short(summary.q3)}`,
      title: 'the middle half of the readings',
    });
    items.push({
      text: `fences ${short(summary.fences.low)}–${short(summary.fences.high)}`,
      title: 'a reading outside these is marked an outlier',
    });
  }

  const drift = trend(summary, pace);

  // A run that is going somewhere is described by where it is going, not by the shape its
  // readings make on the way: a draining battery is a perfect uniform distribution, and saying
  // so is true and useless. The direction is the reading that means something.
  if (fit && !drift?.drifting) {
    items.push({
      // '≈', because the test returns 'not enough evidence to reject' rather than 'is' — at
      // these sample sizes the difference between those two is the whole claim.
      text: `≈ ${fit.name}`,
      // The claim is a test result, so the test is on the label rather than in a footnote
      // nobody would find: what was measured, and what it had to beat.
      title: `consistent with a ${fit.name} distribution over ${summary.n} readings — Kolmogorov–Smirnov at 5%, D ${short(fit.d)} under ${short(fit.critical)}`,
      verdict: true,
    });
  }

  if (drift) items.push(drift);

  if (pace) {
    const jitter = pace.jitter > 0 ? ` ±${duration(pace.jitter)}` : '';
    items.push({
      text: `every ${duration(pace.every)}${jitter}`,
      title: `middle gap between arrivals${pace.jitter > 0 ? ', and how far the gaps stray from it' : ', evenly spaced'}`,
      verdict: true,
    });
  }

  // The one item here that is about the topic rather than the readings, and the only one worth
  // interrupting for: a sensor that published every second and has not published for a minute
  // is either dead or unreachable, and nothing else in the pane would say so.
  if (silence !== null && pace) {
    items.push({
      text: `silent ${duration(silence)}`,
      title: `no reading for ${duration(silence)}, on a topic that had been publishing every ${duration(pace.every)}`,
      verdict: true,
      alarm: true,
    });
  }

  if (summary.outliers.length > 0) {
    items.push({
      text: `${summary.outliers.length} outlier${summary.outliers.length > 1 ? 's' : ''}`,
      title: `outside ${short(summary.fences.low)} to ${short(summary.fences.high)}, one and a half box-widths past the quartiles`,
      verdict: true,
    });
  }

  // Never silent about what was left out: a chart quietly dropping messages is a chart lying
  // about how much of the topic it is showing.
  if (skipped > 0) {
    items.push({
      text: `${skipped} skipped`,
      title: `${skipped} message${skipped > 1 ? 's' : ''} carried no reading and were stepped over`,
      verdict: true,
    });
  }

  return (
    <figcaption className={styles.note} data-testid="note">
      {items.map((item) => (
        <span
          key={item.text}
          className={item.alarm ? styles.alarm : item.verdict ? styles.verdict : styles.stat}
          title={item.title}
        >
          {item.text}
        </span>
      ))}
    </figcaption>
  );
}

/**
 * Which way the run is going, when it is going anywhere.
 *
 * The threshold is the run's own noise: a drift smaller than the readings' spread is a line
 * through a cloud, and calling that 'rising' would put a trend on every sensor in the building.
 */
function trend(summary: Summary, pace: Cadence | null): Item | null {
  if (summary.sd === 0) {
    return { text: 'unchanged', title: 'every reading identical', verdict: true };
  }

  const drift = summary.slope * (summary.n - 1);
  if (Math.abs(drift) <= summary.sd) return null;

  const perMinute = pace ? summary.slope * (60_000 / pace.every) : null;
  const rate = perMinute === null ? `${short(summary.slope)}/reading` : `${short(perMinute)}/min`;

  return {
    text: `${summary.slope > 0 ? 'rising' : 'falling'} ${rate.replace('-', '')}`,
    title: `least-squares trend — ${short(Math.abs(drift))} across the run, against a spread of ${short(summary.sd)}`,
    verdict: true,
    drifting: true,
  };
}

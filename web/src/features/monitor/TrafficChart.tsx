import { useMemo, useState } from 'react';
import { fitDistribution } from '../../lib/distribution';
import { numericFields, numericSeries, type Series } from '../../lib/series';
import { cadence, summarise } from '../../lib/stats';
import { useRuleLookup } from '../../lib/useRuleLookup';
import type { LogEntry } from '../../stores/logStore';
import { ChartNote } from './ChartNote';
import { TrafficHistogram } from './TrafficHistogram';
import { TrafficLine } from './TrafficLine';
import styles from './TrafficChart.module.css';

type View = 'time' | 'distribution';

/**
 * The chart over the entries, and what to do with it.
 *
 * Everything here is a question about the same run of readings: which field of the message to
 * follow, whether to read it in order or as a distribution, and how to get it out of the console
 * and into whatever the reader actually analyses in.
 */
export function TrafficChart({ entries }: { entries: LogEntry[] }) {
  // undefined means 'whichever field the run is mostly about'; a string picks one; null is the
  // body itself. Reset by the remount the pane does when the selection changes.
  const [field, setField] = useState<string | null | undefined>(undefined);
  const [view, setView] = useState<View>('time');
  const [copied, setCopied] = useState(false);
  const ruleOf = useRuleLookup();

  const fields = useMemo(() => numericFields(entries), [entries]);
  const series = useMemo(() => numericSeries(entries, field), [entries, field]);

  // Held against the readings rather than the render: a pointer moving across the plot must not
  // re-run a goodness-of-fit test on five thousand values for every pixel it crosses.
  const stats = useMemo(() => {
    if (!series) return null;
    const values = series.readings.map((reading) => reading.value);

    return {
      summary: summarise(values)!,
      fit: fitDistribution(values),
      pace: cadence(series.readings.map((reading) => reading.at)),
    };
  }, [series]);

  if (!series || !stats) return null;

  const rule = ruleOf(series.topic);
  const copy = async () => {
    await navigator.clipboard.writeText(csv(series));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  };

  return (
    <figure className={styles.chart} data-testid="chart" style={rule ? { color: rule.colour } : undefined}>
      <div className={styles.controls}>
        {/* One topic can carry a whole environment. Which of its fields is wanted is the
            reader's business, so all of them are on offer and the best covered one leads. */}
        {fields.length > 1 && (
          <div className={styles.fields} role="group" aria-label="Field to chart">
            {fields.map((name) => (
              <button
                key={name}
                type="button"
                className={styles.chip}
                aria-label={`Chart ${name}`}
                aria-pressed={series.field === name}
                onClick={() => setField(name)}
              >
                {name}
              </button>
            ))}
          </div>
        )}

        <div className={styles.views}>
          <button
            type="button"
            className={styles.chip}
            aria-label="Over time"
            title="Over time"
            aria-pressed={view === 'time'}
            onClick={() => setView('time')}
          >
            time
          </button>
          <button
            type="button"
            className={styles.chip}
            aria-label="Distribution"
            title="Distribution"
            aria-pressed={view === 'distribution'}
            onClick={() => setView('distribution')}
          >
            dist
          </button>
          <button
            type="button"
            className={styles.chip}
            aria-label={copied ? 'Copied' : 'Copy as CSV'}
            title={copied ? 'Copied' : 'Copy as CSV'}
            onClick={copy}
          >
            {copied ? 'copied' : 'csv'}
          </button>
        </div>
      </div>

      {view === 'time' ? (
        <TrafficLine series={series} summary={stats.summary} colour={rule?.colour} />
      ) : (
        <TrafficHistogram series={series} summary={stats.summary} colour={rule?.colour} />
      )}

      <ChartNote
        summary={stats.summary}
        fit={stats.fit}
        pace={stats.pace}
        skipped={series.skipped}
      />
    </figure>
  );
}

/** Timestamps in full, so a run pasted into anything else sorts and plots without being fixed. */
function csv(series: Series): string {
  const rows = series.readings.map((reading) => `${reading.at.toISOString()},${reading.value}`);

  return [`time,${series.field ?? series.topic}`, ...rows].join('\n');
}

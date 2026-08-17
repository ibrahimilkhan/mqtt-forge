import { useMemo, useState } from 'react';
import { fitDistribution } from '../../lib/distribution';
import { numericFields, numericSeries, type Series } from '../../lib/series';
import { cadence, summarise } from '../../lib/stats';
import { useNow } from '../../lib/useNow';
import { useRuleLookup } from '../../lib/useRuleLookup';
import { CHART_DETAIL } from '../appearance/chart';
import { useAppearanceStore } from '../../stores/appearanceStore';
import type { LogEntry } from '../../stores/logStore';
import { ChartNote } from './ChartNote';
import { TrafficHistogram } from './TrafficHistogram';
import { TrafficLine } from './TrafficLine';
import styles from './TrafficChart.module.css';

type View = 'time' | 'distribution';

/** Periods of silence before a topic with a rhythm counts as having stopped. */
const SILENT_AFTER = 3;

/**
 * The chart over the entries, and what to do with it.
 *
 * Everything here is a question about the same run of readings: which field of the message to
 * follow, whether to read it in order or as a distribution, and how to get it out of the console
 * and into whatever the reader actually analyses in.
 */
export function TrafficChart({
  entries,
  frozen = false,
}: {
  entries: LogEntry[];
  /** The pane is being held still, so the run on show is not the run arriving. */
  frozen?: boolean;
}) {
  // undefined means 'whichever field the run is mostly about'; a string picks one; null is the
  // body itself. Reset by the remount the pane does when the selection changes.
  const [field, setField] = useState<string | null | undefined>(undefined);
  const [view, setView] = useState<View>('time');
  const [copy, setCopy] = useState<'idle' | 'done' | 'refused'>('idle');
  const ruleOf = useRuleLookup();
  const detail = CHART_DETAIL[useAppearanceStore((state) => state.chart)];

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

  // A topic that publishes on a period is a topic whose silence means something, and how long a
  // silence has to be before it does is the period itself. Checked on a beat, since nothing
  // arriving is exactly the case where nothing prompts a redraw. No faster than a second, and no
  // slower than half a minute: this is a warning, not a stopwatch.
  // Not while held: the newest reading on show then gets older by the second while the topic may
  // be publishing perfectly well behind the hold, and an alarm would be about the reader's hand.
  const beat = stats?.pace && !frozen ? Math.min(Math.max(stats.pace.every, 1000), 30_000) : null;
  const now = useNow(beat);

  if (!series || !stats) return null;

  const quiet =
    stats.pace && !frozen ? now - series.readings[series.readings.length - 1].at.getTime() : 0;
  const silence = stats.pace && quiet > stats.pace.every * SILENT_AFTER ? quiet : null;

  const rule = ruleOf(series.topic);

  // Clipboard access is refused often enough — an insecure origin, a locked-down browser — that
  // a button which silently does nothing is a real outcome rather than a theoretical one.
  const take = async () => {
    try {
      await navigator.clipboard.writeText(csv(series));
      setCopy('done');
    } catch {
      setCopy('refused');
    }
    window.setTimeout(() => setCopy('idle'), 2000);
  };

  const copyLabel = { idle: 'Copy as CSV', done: 'Copied', refused: 'Copy failed' }[copy];

  return (
    <figure className={styles.chart} data-testid="chart" style={rule ? { color: rule.colour } : undefined}>
      {detail.controls && (
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
          {/* Deep draws both, so there is nothing here to choose between. */}
          {!detail.histogram && (
            <>
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
            </>
          )}
          <button
            type="button"
            className={styles.chip}
            aria-label={copyLabel}
            title={copyLabel}
            data-state={copy}
            onClick={take}
          >
            {{ idle: 'csv', done: 'copied', refused: 'failed' }[copy]}
          </button>
        </div>
      </div>
      )}

      {(detail.histogram || view === 'time') && (
        <TrafficLine
          series={series}
          summary={stats.summary}
          colour={rule?.colour}
          marks={detail.marks}
        />
      )}

      {(detail.histogram || view === 'distribution') && (
        <TrafficHistogram series={series} summary={stats.summary} colour={rule?.colour} />
      )}

      {detail.note && (
        <ChartNote
          summary={stats.summary}
          fit={stats.fit}
          pace={stats.pace}
          skipped={series.skipped}
          of={series.of}
          silence={silence}
          quartiles={detail.histogram}
        />
      )}
    </figure>
  );
}

/** Timestamps in full, so a run pasted into anything else sorts and plots without being fixed. */
function csv(series: Series): string {
  const rows = series.readings.map((reading) => `${reading.at.toISOString()},${reading.value}`);

  return [`time,${series.field ?? series.topic}`, ...rows].join('\n');
}

import { useMemo } from 'react';
import { short } from '../../lib/format';
import { domainFor, type ScaleId } from '../../lib/scale';
import type { Series } from '../../lib/series';
import { shapeOf } from '../../lib/shape';
import { summarise } from '../../lib/stats';
import { TrafficLine } from './TrafficLine';
import styles from './TrafficChart.module.css';

/**
 * A branch of the tree, one plot per topic.
 *
 * Picking `sensors/room/#` used to be the commonest way to get no chart at all: the readings
 * under a branch are several topics, and a room's temperature and its humidity have no axis they
 * can share. But they do share a moment — that is the whole reason for selecting the branch — and
 * stacking them one above the other on their own scales shows exactly that: which of them moved,
 * and whether they moved together.
 *
 * Each row is a way in. What a small multiple cannot carry is the note, the field chips or the
 * readout under the pointer, so clicking one narrows the pane to that topic and it gets all of
 * them.
 */
export function TrafficMultiples({
  series,
  more,
  scale,
  colourOf,
  onFocus,
}: {
  series: Series[];
  /** Topics under the selection that there was no room to draw. */
  more: number;
  scale: ScaleId;
  colourOf: (topic: string) => string | undefined;
  onFocus: (topic: string) => void;
}) {
  return (
    <div className={styles.multiples} data-testid="multiples">
      {series.map((run) => (
        <Small key={run.topic} series={run} scale={scale} colour={colourOf(run.topic)} onFocus={onFocus} />
      ))}

      {/* Never silent about what was left out: a branch quietly drawing six of its nine topics
          would be the chart cropping the selection without saying so. */}
      {more > 0 && (
        <p className={styles.moreTopics} data-testid="more-topics">
          {more} more {more === 1 ? 'topic' : 'topics'} under this branch — pick one in the tree to
          chart it.
        </p>
      )}
    </div>
  );
}

function Small({
  series,
  scale,
  colour,
  onFocus,
}: {
  series: Series;
  scale: ScaleId;
  colour?: string;
  onFocus: (topic: string) => void;
}) {
  const read = useMemo(() => {
    const values = series.readings.map((reading) => reading.value);
    const summary = summarise(values)!;

    return { summary, domain: domainFor(values, summary, scale), shape: shapeOf(series.readings, summary) };
  }, [series, scale]);

  const latest = series.readings[series.readings.length - 1].value;

  return (
    <button
      type="button"
      className={styles.small}
      // The leaf, not the whole path: the branch the reader picked is the part every row here
      // has in common, and repeating it on all six of them costs the width the tail needs. The
      // range comes with it, since the row itself has no height to spare for an axis.
      title={`${series.topic} — ${short(read.domain.low)} to ${short(read.domain.high)}, ${series.readings.length} readings. Chart this topic on its own.`}
      onClick={() => onFocus(series.topic)}
      style={colour ? { color: colour } : undefined}
    >
      <span className={styles.smallName}>
        <span className={styles.smallTopic}>{leaf(series.topic)}</span>
        {series.field && <span className={styles.smallField}>{series.field}</span>}
      </span>

      <span className={styles.smallPlot}>
        <TrafficLine
          series={series}
          summary={read.summary}
          domain={read.domain}
          shape={read.shape}
          colour={colour}
          marks={false}
          compact
        />
      </span>

      {/* The newest reading, which is the number a reader scanning six rows is actually after. */}
      <span className={styles.smallValue}>{latest}</span>
    </button>
  );
}

/** The last segment, with enough of its parent to tell two leaves of the same name apart. */
function leaf(topic: string): string {
  const parts = topic.split('/');

  return parts.slice(-2).join('/');
}

import { duration, short } from '../../lib/format';
import { pinned as offScale, type Domain } from '../../lib/scale';
import type { Series } from '../../lib/series';
import type { Shape } from '../../lib/shape';
import type { Summary } from '../../lib/stats';
import styles from './TrafficChart.module.css';

/**
 * One reading, opened.
 *
 * The line answers 'what has this been doing' and the note answers 'what does the whole run add
 * up to'. Neither answers the question a reader asks when something on the line catches their
 * eye: what *is* that one, exactly, and when. Hovering gave the value alone, which is the least
 * of it — the useful part is where the reading sits against everything else, and that is
 * arithmetic nobody should do against a picture.
 *
 * The value leads: it is what was clicked for. Everything under it says where that value stands.
 */
export function ReadingDetail({
  series,
  summary,
  shape,
  domain,
  at,
  onClose,
}: {
  series: Series;
  summary: Summary;
  shape: Shape;
  domain: Domain;
  /** Index into the run. */
  at: number;
  onClose: () => void;
}) {
  const reading = series.readings[at];
  const before = at > 0 ? series.readings[at - 1] : null;

  const step = before ? reading.value - before.value : null;
  const since = before ? reading.at.getTime() - before.at.getTime() : null;

  return (
    <div
      className={styles.detail}
      data-testid="detail"
      role="group"
      aria-label={`Reading ${at + 1} of ${series.readings.length}`}
    >
      <div className={styles.detailHead}>
        <b className={styles.detailValue} data-testid="detail-value">
          {reading.value}
        </b>
        <button
          type="button"
          className={styles.detailClose}
          aria-label="Close this reading"
          title="Close — Escape"
          onClick={onClose}
        >
          ×
        </button>
      </div>

      <dl className={styles.detailRows}>
        <Row label="at" value={reading.at.toLocaleTimeString('en-GB', { hour12: false })} />
        <Row label="reading" value={`${at + 1} of ${series.readings.length}`} />

        {/* What it did relative to the one before it, which is the whole reason a step or a
            spike is worth clicking on. */}
        <Row
          label="change"
          value={
            step === null
              ? 'first of the run'
              : `${step > 0 ? '+' : step < 0 ? '−' : '±'}${short(Math.abs(step))}${
                  since ? ` in ${duration(since)}` : ''
                }`
          }
        />

        {/* Where it stands in the run. A switch has no mean worth standing against, so it is
            told which side of the threshold it is instead. */}
        {shape.id === 'state' || shape.id === 'pulse' ? (
          <Row
            label="level"
            value={
              reading.value >= shape.pulses.threshold
                ? `past ${short(shape.pulses.threshold)}`
                : `at rest, under ${short(shape.pulses.threshold)}`
            }
          />
        ) : (
          <Row
            label="against"
            value={
              summary.sd > 0
                ? `${short(Math.abs(reading.value - summary.mean) / summary.sd)}σ ${
                    reading.value >= summary.mean ? 'above' : 'below'
                  } the mean`
                : 'every reading identical'
            }
          />
        )}
      </dl>

      {/* The two things that make a reading worth a second look, and both are already marked on
          the plot — this says in words what those marks mean. */}
      {(summary.outliers.includes(at) || offScale(domain, reading.value)) && (
        <p className={styles.detailFlags} data-testid="detail-flags">
          {summary.outliers.includes(at) && <span>outside the fences</span>}
          {offScale(domain, reading.value) && <span>past the plot's range</span>}
        </p>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.detailRow}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

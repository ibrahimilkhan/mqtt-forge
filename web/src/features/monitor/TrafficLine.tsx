import type { CSSProperties } from 'react';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from 'react';
import { GRIDS, type GridId } from '../appearance/grid';
import { short } from '../../lib/format';
import { PlotGrid } from './PlotGrid';
import { ReadingDetail } from './ReadingDetail';
import { pinned, positionIn, type Domain } from '../../lib/scale';
import type { Series } from '../../lib/series';
import type { Shape } from '../../lib/shape';
import type { Change, Summary } from '../../lib/stats';
import styles from './TrafficChart.module.css';

/** The plot is drawn in a unit square and stretched to the pane; see `preserveAspectRatio`. */
const SIDE = 100;

/** Below this a band and a mean line are furniture over a handful of points. */
const ENOUGH_FOR_A_BAND = 5;

/**
 * How big a dot is, against the plot it is drawn in.
 *
 * A dot per arrival says where the readings actually are — a line alone cannot tell a run sampled
 * ten times from one sampled a thousand, and between two dots the line is an interpolation nobody
 * measured. But a mark that is right in a pane region forty pixels tall is a speck in a chart
 * thrown open over the window, and a mark that is right there is a blot in the pane. So the dot
 * is a fraction of the plot's own height, floored so it never disappears and capped so it never
 * becomes the subject.
 */
const DOT_OF_HEIGHT = 0.016;
const DOT_SMALLEST = 3;
const DOT_LARGEST = 8;

/**
 * The clear space a dot keeps from the next one along.
 *
 * Without it the marks touch, and a row of touching dots is not five hundred readings, it is a
 * thicker line lying about its own resolution. When the run is dense enough that a dot cannot be
 * drawn at its smallest and still keep this gap, none are drawn at all.
 */
const DOT_CLEAR = 1.5;

/** Keeps the readout over the plot at either end of the run, rather than hanging off it. */
const shift = (index: number, count: number) =>
  index === 0 ? 'none' : index === count - 1 ? 'translateX(-100%)' : 'translateX(-50%)';

/**
 * What the readings have been doing, in order.
 *
 * The newest value says where a sensor is; a topic under traffic is usually asked where it has
 * been going, and that is a shape rather than a number.
 *
 * Two things about the run decide how it is drawn. The domain says how much of the range the
 * height is spent on — a reading outside it is pinned to the edge and marked, never dropped. The
 * shape says whether the readings are a quantity, which is drawn as a line between them, or
 * levels, which are drawn as the steps they actually are: a switch does not pass through the
 * values between off and on, and sloping from one to the other says it does.
 */
export function TrafficLine({
  series,
  summary,
  domain,
  shape,
  step = null,
  colour,
  marks = true,
  compact = false,
  grid = 'frame',
}: {
  series: Series;
  summary: Summary;
  /** The band of values the height covers, and what fell outside it. */
  domain: Domain;
  shape: Shape;
  /** Where the run moved from one level to another, when it did. */
  step?: Change | null;
  colour?: string;
  /** The band, the mean and the outlier rings — everything drawn that is not a reading. */
  marks?: boolean;
  /** One of several stacked plots: no readout, no scale, no focus ring, no furniture. */
  compact?: boolean;
  /** What is drawn round and behind the line. */
  grid?: GridId;
}) {
  const [hovered, setHovered] = useState<number | null>(null);
  // The plot's width in real pixels, which is the only thing that says whether a dot per reading
  // would be a row of dots or a smear.
  const plotRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ across: 0, down: 0 });
  // A reading the reader has clicked, which stays open while the pointer goes elsewhere. Held
  // apart from `hovered` so moving across the plot does not drag the opened one along with it.
  const [opened, setOpened] = useState<number | null>(null);
  const { readings } = series;

  const y = (value: number) => SIDE - positionIn(domain, value) * SIDE;

  // One step per reading, not one per second. The log drops a topic's oldest entries as it
  // fills, so the gaps between what it still holds are the trimming's, not the broker's —
  // spacing by arrival time would draw those as silences the sensor never had.
  const x = (index: number) => (index / (readings.length - 1)) * SIDE;

  // A switch holds its level until it changes, so the corner is square. Drawn as a slope, a door
  // that opened between two readings a minute apart would read as a door that spent that minute
  // ajar — which is exactly the reading someone chasing a fault would act on.
  const held = shape.id === 'state' || shape.id === 'pulse';

  const line = readings
    .flatMap((reading, index) =>
      held && index > 0
        ? [`${x(index)},${y(readings[index - 1].value)}`, `${x(index)},${y(reading.value)}`]
        : [`${x(index)},${y(reading.value)}`],
    )
    .join(' ');

  const latest = readings[readings.length - 1];
  // Only a run of measurements has a mean worth drawing. On a switch the mean sits in the gap
  // between the two levels, where the signal has never once been.
  const banded =
    marks && shape.id === 'continuous' && summary.n >= ENOUGH_FOR_A_BAND && summary.sd > 0;

  const last = readings.length - 1;
  const settle = (step: number) => setHovered(Math.min(Math.max(step, 0), last));

  /** Which reading a pointer at this position is nearest. */
  const nearest = (clientX: number, box: DOMRect) =>
    Math.min(Math.max(Math.round(((clientX - box.left) / box.width) * last), 0), last);

  // Clicking the reading that is already open closes it, so the same gesture goes both ways.
  const open = (at: number) => setOpened((current) => (current === at ? null : at));

  const follow = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    if (!box.width) return;

    settle(nearest(event.clientX, box));
  };

  // The whole plot is the target rather than the two-pixel line: a reader aims at a moment, and
  // the nearest reading to where they aimed is the one they meant.
  const take = (event: MouseEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    if (!box.width) return;

    open(nearest(event.clientX, box));
  };

  /**
   * The same walk, without a pointer.
   *
   * A chart whose values can only be read by holding a mouse over them is a chart half the
   * readers cannot read at all — and on a run of a thousand, arrow keys are the only way to land
   * on one reading exactly rather than near it.
   */
  const walk = (event: KeyboardEvent<HTMLDivElement>) => {
    const at = hovered ?? last;

    // The same reading a pointer would have opened, opened from the keyboard. Without this the
    // detail is a thing only a mouse can reach, which is the readout's oldest failing.
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      open(at);
      settle(at);

      return;
    }

    const steps: Record<string, number> = { ArrowLeft: at - 1, ArrowRight: at + 1, Home: 0, End: last };
    const next = steps[event.key];
    if (next === undefined) return;

    event.preventDefault();
    settle(next);
  };

  // Escape closes it, wherever the focus has got to since.
  useEffect(() => {
    if (opened === null) return;

    const listen = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setOpened(null);
    };

    window.addEventListener('keydown', listen);

    return () => window.removeEventListener('keydown', listen);
  }, [opened]);

  useLayoutEffect(() => {
    const measured = plotRef.current;
    if (!measured || typeof ResizeObserver === 'undefined') return;

    const watch = new ResizeObserver(([entry]) =>
      setBox({ across: entry.contentRect.width, down: entry.contentRect.height }),
    );
    watch.observe(measured);

    return () => watch.disconnect();
  }, []);

  // Sized against the plot, then against the run: as big as the height affords, but never so big
  // that two neighbouring readings touch. A run too dense to hold even the smallest dot with its
  // clear space gets none, and keeps the line it already had.
  const room = box.across / Math.max(last, 1);
  const dot = Math.min(
    Math.max(box.down * DOT_OF_HEIGHT, DOT_SMALLEST),
    DOT_LARGEST,
    room - DOT_CLEAR,
  );

  // Zero-length subpaths with a round cap: one element for every dot, each of them a true circle.
  // A <circle> would come out an ellipse — the viewBox is stretched to the pane — and five hundred
  // HTML spans would be five hundred nodes relaid out on every arrival.
  const dotted = marks && box.across > 0 && dot >= DOT_SMALLEST;
  const dots = dotted
    ? readings
        .map((reading, index) => {
          const at = `${x(index)},${y(reading.value)}`;

          return `M${at}L${at}`;
        })
        .join('')
    : '';

  // Readings the domain could not fit, drawn on the edge they went past. Not silently clamped:
  // a run flattened against the top of the plot with nothing to say why would be the chart
  // lying about its own range.
  const outside = readings.reduce<Array<{ index: number; side: 'high' | 'low' }>>(
    (found, reading, index) => {
      if (pinned(domain, reading.value)) {
        found.push({ index, side: reading.value > domain.high ? 'high' : 'low' });
      }

      return found;
    },
    [],
  );

  return (
    <div className={styles.frame}>
      {/* The line says the shape and the labels say the size of it, which is the one thing a
          sparkline cannot carry on its own. Muted, like the stamps: this is furniture. A run
          that never moved has one number to give, not the same one twice.

          Not on a stacked plot: a row thirty pixels tall cannot hold two numbers and a line, and
          what small multiples are for is comparing shapes over a shared moment. The row carries
          the newest reading beside it and its range in the title. */}
      {!compact && (
      <div
        className={styles.scale}
        data-testid="scale"
        // With one label and a line down the middle, the label belongs beside the line.
        data-flat={domain.high === domain.low ? '' : undefined}
        aria-hidden="true"
      >
        <span>
          {short(domain.high)}
          {/* An arrow, not a footnote: the reader has to know at a glance that the plot's edge
              is not the run's, or they will read the pinned line as the highest reading. */}
          {domain.over > 0 && <b className={styles.pinCount}>↑{domain.over}</b>}
        </span>
        {domain.high !== domain.low && (
          <span>
            {short(domain.low)}
            {domain.under > 0 && <b className={styles.pinCount}>↓{domain.under}</b>}
          </span>
        )}
      </div>
      )}

      <div className={styles.plotArea}>
        {/* The shape is the whole point, so the words standing in for it carry the same facts:
            how many readings, of what, over what range, and where they ended up. */}
        <div
          ref={plotRef}
          className={styles.plot}
          data-testid="plotArea"
          // The head and the outlier rings are HTML, so they take the measure through a property
          // rather than an attribute — and stay in proportion to the dots they sit among.
          style={{ '--dot': `${Math.max(dot, DOT_SMALLEST)}px` } as CSSProperties}
          data-shape={shape.id}
          role="img"
          aria-label={`${spoken(series, domain, shape, latest.value)} Enter opens the one you are on.`}
          // Focusable so the readings can be walked without a pointer. Landing on it starts at
          // the newest reading, which is the one the row above is showing.
          tabIndex={compact ? -1 : 0}
          onPointerMove={follow}
          onPointerLeave={() => setHovered(null)}
          onFocus={() => setHovered((at) => at ?? last)}
          onBlur={() => setHovered(null)}
          onClick={take}
          onKeyDown={walk}
        >
          <svg
            className={styles.plotSvg}
            viewBox={`0 0 ${SIDE} ${SIDE}`}
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            {/* The plot's own edge, and the quarters of it. First, so everything the run does is
                drawn over the ground rather than under it. */}
            <PlotGrid grid={compact && GRIDS[grid].frame ? 'frame' : grid} side={SIDE} />

            {/* One deviation either side of the mean, which is where the readings mostly are.
                The line crossing out of it is the part worth looking at. */}
            {banded && (
              <rect
                className={styles.band}
                x={0}
                y={y(summary.mean + summary.sd)}
                width={SIDE}
                height={Math.max(y(summary.mean - summary.sd) - y(summary.mean + summary.sd), 0)}
              >
                {/* A line drawn across a chart with nothing to say what it is is a mystery the
                    reader has to solve before they can read anything else. */}
                <title>mean, and one deviation either side of it</title>
              </rect>
            )}
            {banded && (
              <line className={styles.mean} x1={0} y1={y(summary.mean)} x2={SIDE} y2={y(summary.mean)} />
            )}

            {/* The line the events under the plot were counted against. Without it the note's
                count of pulses is a number the reader has no way to check against the picture. */}
            {marks && held && shape.pulses.threshold > domain.low && shape.pulses.threshold < domain.high && (
              <line
                className={styles.threshold}
                data-testid="threshold"
                x1={0}
                y1={y(shape.pulses.threshold)}
                x2={SIDE}
                y2={y(shape.pulses.threshold)}
              >
                <title>the line an excursion is counted against</title>
              </line>
            )}

            {/* Where a reading can go either way, which side of nothing it is on is the first
                thing read off the shape — and the line alone cannot say where nothing is. */}
            {domain.low < 0 && domain.high > 0 && (
              <line className={styles.zero} data-testid="zero" x1={0} y1={y(0)} x2={SIDE} y2={y(0)}>
                <title>zero</title>
              </line>
            )}

            {/* Where the run moved from one level to another. The note says how far and when;
                this says where to look on the line for it. */}
            {step && (
              <line
                className={styles.step}
                data-testid="step"
                x1={x(step.at)}
                y1={0}
                x2={x(step.at)}
                y2={SIDE}
              >
                <title>stepped here</title>
              </line>
            )}

            {/* The opened reading keeps a hairline of its own once the pointer has left, so the
                card and the point it is about stay tied together. */}
            {opened !== null && opened !== hovered && (
              <line
                className={styles.opened}
                data-testid="opened"
                x1={x(opened)}
                y1={0}
                x2={x(opened)}
                y2={SIDE}
              />
            )}

            {hovered !== null && (
              <line className={styles.crosshair} x1={x(hovered)} y1={0} x2={x(hovered)} y2={SIDE} />
            )}

            {/* Stretched by the viewBox, so the stroke is pinned to device pixels rather than
                scaled with it — otherwise a wide pane draws a thick line and a narrow one a hair. */}
            <polyline
              data-testid="plot"
              className={styles.plotLine}
              points={line}
              fill="none"
              stroke={colour ?? 'currentColor'}
            />

            {/* Over the line, so a reading sits on top of the interpolation between it and the
                one beside it rather than under it. */}
            {dotted && (
              <path
                data-testid="dots"
                className={styles.dots}
                d={dots}
                fill="none"
                stroke={colour ?? 'currentColor'}
                strokeWidth={dot}
              />
            )}
          </svg>

          {/* Round dots and real type, in HTML: both would be stretched out of shape inside the
              viewBox above. The dot marks where the run ends, which is the row above it. */}
          <span
            className={styles.head}
            style={{ left: `${x(readings.length - 1)}%`, top: `${y(latest.value)}%` }}
          />

          {/* A reading the plot's range could not hold, sitting on the edge it went past. */}
          {outside.map(({ index, side }) => (
            <span
              key={index}
              className={styles.pin}
              data-testid="pinned"
              data-side={side}
              title={`${short(readings[index].value)} — past the plot's range`}
              style={{ left: `${x(index)}%`, top: side === 'high' ? '0%' : '100%' }}
            />
          ))}

          {/* A reading past the fences is either the event the sensor was put there to catch or
              a fault in it, and either way it is the one to look at first. Not on a switch: on
              two levels every reading is one level or the other, and both are ordinary. */}
          {marks && shape.id === 'continuous' && summary.outliers.map((index) => (
            <span
              key={index}
              className={styles.outlier}
              data-testid="outlier"
              style={{ left: `${x(index)}%`, top: `${y(readings[index].value)}%` }}
            />
          ))}

          {hovered !== null && !compact && (
            <span
              className={styles.reading}
              data-testid="reading"
              aria-hidden="true"
              // Centred on the reading, except at the ends, where a centred label would hang off
              // the pane: there it sits inside the run it belongs to.
              style={{ left: `${x(hovered)}%`, transform: shift(hovered, readings.length) }}
              title={readings[hovered].at.toLocaleTimeString('en-GB', { hour12: false })}
            >
              {readings[hovered].value}
            </span>
          )}
        </div>

        {/* Outside the plot for the same reason the live region below is: role="img" makes
            everything inside it presentational, so a card in there would be a card no screen
            reader could reach. Placed in the corner furthest from the reading it is about, so it
            never covers the thing that was clicked. */}
        {opened !== null && !compact && (
          <div
            className={styles.detailSlot}
            data-side={opened > last / 2 ? 'left' : 'right'}
            data-half={positionIn(domain, readings[opened].value) > 0.5 ? 'low' : 'high'}
          >
            <ReadingDetail
              series={series}
              summary={summary}
              shape={shape}
              domain={domain}
              at={opened}
              onClose={() => setOpened(null)}
            />
          </div>
        )}

        {/* Outside the plot on purpose: role="img" makes everything inside it presentational, so
            a live region in there would announce nothing. This is the same readout in words. */}
        {!compact && (
          <span className="srOnly" data-testid="spoken" aria-live="polite">
            {hovered === null
              ? ''
              : `${readings[hovered].value} at ${readings[hovered].at.toLocaleTimeString('en-GB', { hour12: false })}, reading ${hovered + 1} of ${readings.length}`}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * The plot in words, for a reader who cannot see it.
 *
 * It carries what the picture carries and nothing the picture does not: how many readings, of
 * what, drawn over what range — and, when the range is not the run's own, that some of them are
 * sitting on the edge rather than at the value they hold.
 */
function spoken(series: Series, domain: Domain, shape: Shape, latest: number): string {
  const what = series.field ? ` of ${series.field}` : '';
  const kind = shape.id === 'continuous' ? '' : `, read as ${shape.id === 'counter' ? 'a counter' : shape.id === 'state' ? `${shape.levels} levels` : 'a pulse train'}`;
  const clipped =
    domain.over + domain.under > 0
      ? `, ${domain.over + domain.under} outside the plot's range and drawn on its edge`
      : '';

  return `${series.readings.length} readings${what} on ${series.topic}${kind}, drawn from ${short(domain.low)} to ${short(domain.high)}${clipped}, latest ${latest}. Arrow keys walk the readings.`;
}

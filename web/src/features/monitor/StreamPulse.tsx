import { memo } from 'react';
import { RATE_SECONDS } from '../../stores/streamRateStore';
import styles from './StreamPause.module.css';

/** The unit the line is drawn in, then stretched to whatever the button is; see the svg. */
const WIDE = 100;
const TALL = 20;

/**
 * The last minute of the stream, under the control that stops it.
 *
 * Measured from nothing rather than from the minute's quietest second, unlike a topic's own
 * sparkline: that one is read for its shape, and this one for whether there is a stream at all.
 * Scaled from its low, a broker sending two a second and one sending two thousand would draw the
 * same wave, and a quiet line would look exactly as busy as a loud one.
 *
 * Laid against a full minute from the start, the newest reading always at the right edge, so a
 * stream that has just begun grows in from the right rather than being stretched across the
 * button and then squeezed as the minute fills.
 *
 * Decoration to anything reading the page aloud: the rate itself is in the control's tooltip.
 */
export const StreamPulse = memo(function StreamPulse({ readings }: { readings: readonly number[] }) {
  if (readings.length < 2) return null;

  const high = Math.max(...readings);
  const first = RATE_SECONDS - readings.length;
  const x = (index: number) => ((first + index) / (RATE_SECONDS - 1)) * WIDE;
  // A floor and a ceiling a little inside the box, so the line is never cut by the border.
  const y = (value: number) => (high === 0 ? TALL - 1 : TALL - 1 - (value / high) * (TALL - 3));

  const line = readings.map((value, index) => `${x(index)},${y(value)}`).join(' ');
  const area = `M${x(0)},${TALL} L${line.replaceAll(' ', ' L')} L${x(readings.length - 1)},${TALL} Z`;

  return (
    <svg
      className={styles.pulse}
      data-testid="stream-pulse"
      viewBox={`0 0 ${WIDE} ${TALL}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
    >
      <path d={area} className={styles.pulseArea} />
      <polyline points={line} className={styles.pulseLine} />
    </svg>
  );
});

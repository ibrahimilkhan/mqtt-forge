import { useEffect, useMemo, useRef, type KeyboardEvent, type PointerEvent } from 'react';
import { createFrameLatest } from '../../lib/frameLatest';
import styles from './ResizeHandle.module.css';

// Neither side is useful once it is a sliver, so the drag stops short of both ends. A share of
// the whole box, which is where the caller reasons about it; the handle itself is told that
// floor already scaled into the pair it divides.
export const MIN_SHARE = 0.12;
// A step of the pair, not of the box: a seam dividing two narrow panes moves in finer steps than
// one dividing the width of the window, which is the same relationship the pointer has to it.
const STEP = 0.02;

type Props = {
  /** 'x' splits side by side, 'y' splits top from bottom. */
  axis: 'x' | 'y';
  label: string;
  /** The near pane's share of the two this divides — 0.5 is the boundary halfway between them. */
  value: number;
  /** How far along the pair it may travel — the caller knows what a pane may shrink to. */
  min: number;
  max: number;
  onChange: (value: number) => void;
  /** A region either side of it is shut, so there is no boundary here to move. */
  off?: boolean;
};

// Measures the two panes it sits between rather than taking refs to them, so neither is aware it
// is being resized.
//
// The pair, not the box they share. Fold the log away and the right column is a header, a chart
// and a form: the boundary the reader is dragging is no longer at any fixed fraction of the
// column, because a folded region takes a header's worth of it and gives up the rest. The pair
// either side of a seam is always contiguous and always laid out, so its own rect answers where
// the seam is without anyone having to know what else is in the column, or what it is doing.
export function ResizeHandle({ axis, label, value, min, max, onChange, off = false }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  const clamp = (share: number) => Math.min(max, Math.max(min, share));

  // A pointer reports far more often than the screen redraws, and every report relaid out a pane
  // that can hold a thousand rows — which is what made the drag stutter on a busy broker. Only
  // the newest position of each frame is worth anything, so that is the only one applied.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const frame = useMemo(() => createFrameLatest<number>((share) => onChangeRef.current(share)), []);
  useEffect(() => frame.cancel, [frame]);

  const dragTo = (event: PointerEvent<HTMLDivElement>) => {
    const bar = ref.current;
    const near = bar?.previousElementSibling?.getBoundingClientRect();
    const far = bar?.nextElementSibling?.getBoundingClientRect();
    if (!near || !far) return;

    const [start, end, along] =
      axis === 'x'
        ? [near.left, far.right, event.clientX]
        : [near.top, far.bottom, event.clientY];

    // An unmeasured layout reports zero size; there is nothing to divide yet.
    const span = end - start;
    if (span <= 0) return;

    frame.offer(clamp((along - start) / span));
  };

  const grab = (event: PointerEvent<HTMLDivElement>) => {
    // Without this the drag selects the text it sweeps across, and the handle never takes focus.
    event.preventDefault();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const nudge = (event: KeyboardEvent<HTMLDivElement>) => {
    const back = axis === 'x' ? 'ArrowLeft' : 'ArrowUp';
    const forward = axis === 'x' ? 'ArrowRight' : 'ArrowDown';
    if (event.key === back) onChange(clamp(value - STEP));
    else if (event.key === forward) onChange(clamp(value + STEP));
    else return;
    event.preventDefault();
  };

  const percent = Math.round(value * 100);

  return (
    <div
      ref={ref}
      role="separator"
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      aria-label={label}
      aria-valuenow={percent}
      aria-valuemin={Math.round(min * 100)}
      aria-valuemax={Math.round(max * 100)}
      // Otherwise a screen reader reads the bare number with no idea what it measures.
      aria-valuetext={`${label}: ${percent} percent`}
      // Out of the tab order and out of the tree when there is nothing either side of it to
      // divide: a seam between a shut region and its neighbour is a control that would move
      // something the reader cannot see.
      tabIndex={off ? -1 : 0}
      aria-hidden={off || undefined}
      className={styles.handle}
      data-axis={axis}
      data-off={off ? '' : undefined}
      onPointerDown={grab}
      onPointerMove={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) dragTo(event);
      }}
      onPointerUp={(event) => event.currentTarget.releasePointerCapture(event.pointerId)}
      onKeyDown={nudge}
    />
  );
}

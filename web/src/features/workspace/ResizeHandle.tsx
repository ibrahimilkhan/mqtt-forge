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
  /** Nothing left with a height on one side of it, so there is no boundary here to move. */
  off?: boolean;
  /**
   * Where this seam goes when it is asked to fit, and what to call that.
   *
   * The handle knows nothing about logs or forms and is given the answer rather than the question:
   * a share of the pair, worked out by whoever owns the panes, or null when there is nothing worth
   * snapping to at this moment. Absent altogether on a seam that divides nothing with a size of
   * its own — a column of topics is as wide as it is given, and no wider.
   */
  fit?: { title: string; share: () => number | null };
};

/**
 * The nearest pane on one side with a height to give.
 *
 * Two things get stepped over. A folded region, which marks itself: with the chart folded the
 * column is the log, a strip, and the form, so the boundary above the strip divides the log from
 * the form and has to measure them rather than the strip it happens to sit against. And the other
 * boundary beyond that strip, which is a bar three pixels wide and not a pane at all — measuring
 * against that one made the far side of the pair three pixels of nothing.
 */
function reach(from: Element | null | undefined, step: 'previousElementSibling' | 'nextElementSibling') {
  for (let node = from; node; node = node[step]) {
    const skip = node.hasAttribute('data-folded') || node.getAttribute('role') === 'separator';
    if (!skip) return node.getBoundingClientRect();
  }

  return null;
}

// Measures the two panes it sits between rather than taking refs to them, so neither is aware it
// is being resized.
//
// The pair, not the box they share. Fold a region away and the right column is a header, a chart
// and a form: the boundary the reader is dragging is no longer at any fixed fraction of the
// column, because a folded region takes a header's worth of it and gives up the rest. The pair
// either side of a seam is always laid out, so their own rects answer where the seam is without
// anyone having to know what else is in the column, or what it is doing.
export function ResizeHandle({ axis, label, value, min, max, onChange, off = false, fit }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  // Where in the gap between the two panes the drag began, measured from the near pane's edge.
  //
  // With a folded region beside it that gap is thirty pixels of strip and bars, not three, and a
  // reader can take hold anywhere in it. Without this the near pane's edge jumps to the pointer
  // on the first move — the whole strip snapping up past the hand that grabbed its lower seam.
  const grabbedAt = useRef(0);

  const clamp = (share: number) => Math.min(max, Math.max(min, share));

  // A pointer reports far more often than the screen redraws, and every report relaid out a pane
  // that can hold a thousand rows — which is what made the drag stutter on a busy broker. Only
  // the newest position of each frame is worth anything, so that is the only one applied.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const frame = useMemo(() => createFrameLatest<number>((share) => onChangeRef.current(share)), []);
  // Resumed as well as cancelled, because in development React mounts this effect, tears it down
  // and mounts it again — and a cancellation is permanent. Without the first half of this line the
  // drag applied nothing at all in a dev build, which is the only build anyone debugs it in.
  useEffect(() => {
    frame.resume();
    return frame.cancel;
  }, [frame]);

  /** The two panes this divides, and where the pointer is along them. */
  const span = (event: PointerEvent<HTMLDivElement>) => {
    const bar = ref.current;
    const near = reach(bar?.previousElementSibling, 'previousElementSibling');
    const far = reach(bar?.nextElementSibling, 'nextElementSibling');
    if (!near || !far) return null;

    return axis === 'x'
      ? { start: near.left, boundary: near.right, resumes: far.left, end: far.right, along: event.clientX }
      : { start: near.top, boundary: near.bottom, resumes: far.top, end: far.bottom, along: event.clientY };
  };

  const dragTo = (event: PointerEvent<HTMLDivElement>) => {
    const at = span(event);
    if (!at) return;

    // The room the boundary has to travel in: the two panes, less whatever sits between them.
    //
    // That gap — this bar, and any folded strip it stepped over to find its panes — belongs to
    // neither side and travels with the boundary rather than staying put, so it is taken out of
    // the distance the pointer is measured against rather than charged to one of the panes.
    //
    // Written as one straight line from the near pane's start to where the boundary can go no
    // further, on purpose. It was a three-way test — inside the near pane, inside the far one, or
    // in the gap between them — which is exact where the panes are and flat where they are not:
    // with a folded region beside it the pointer spends the whole drag inside that flat band,
    // where a step of the pointer moved the boundary and moving the boundary moved the band back
    // under the pointer. That is the blink. A line has nothing to oscillate about.
    const travel = at.end - at.start - (at.resumes - at.boundary);
    if (travel <= 0) return;

    frame.offer(clamp((at.along - grabbedAt.current - at.start) / travel));
  };

  const grab = (event: PointerEvent<HTMLDivElement>) => {
    // Without this the drag selects the text it sweeps across, and the handle never takes focus.
    event.preventDefault();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);

    // How far past the boundary the hand landed, so the boundary keeps that distance for the
    // whole drag instead of leaping to meet the pointer on the first move.
    const at = span(event);
    grabbedAt.current = at ? at.along - at.boundary : 0;
  };

  /**
   * The pane beside this seam at exactly its own size, and the seam moved to say so.
   *
   * Through the same clamp and the same frame a drag goes through, on purpose. A fit that wrote
   * its answer straight out could leave a pane somewhere no drag can reach — two gestures on one
   * three-pixel bar disagreeing about where the floor is, and only one of them visible.
   */
  const fitted = () => {
    if (off) return;

    const share = fit?.share();
    if (share === null || share === undefined) return;

    frame.offer(clamp(share));
  };

  const nudge = (event: KeyboardEvent<HTMLDivElement>) => {
    const back = axis === 'x' ? 'ArrowLeft' : 'ArrowUp';
    const forward = axis === 'x' ? 'ArrowRight' : 'ArrowDown';
    // The double-click, for a reader who is not holding the pointer. Enter on a splitter is
    // sometimes a fold, but this console folds from the strip inside the region — a control a
    // couple of dozen pixels away that names which region it shuts — so the key is free here.
    if (event.key === 'Enter') fitted();
    else if (event.key === back) onChange(clamp(value - STEP));
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
      title={fit?.title}
      className={styles.handle}
      data-axis={axis}
      data-off={off ? '' : undefined}
      onPointerDown={grab}
      onPointerMove={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) dragTo(event);
      }}
      onPointerUp={(event) => event.currentTarget.releasePointerCapture(event.pointerId)}
      // The second click of a double-click, and the fourth, and the sixth: `detail` counts the
      // whole run rather than starting over at each pair, so a reader who presses again gets
      // another fit rather than nothing. Read off the click rather than from `dblclick` because
      // that is how the log rows and the tree rows already read theirs.
      onClick={(event) => {
        if (event.detail !== 0 && event.detail % 2 === 0) fitted();
      }}
      onKeyDown={nudge}
    />
  );
}

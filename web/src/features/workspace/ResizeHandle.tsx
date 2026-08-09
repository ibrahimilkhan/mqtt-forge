import { useEffect, useMemo, useRef, type KeyboardEvent, type PointerEvent } from 'react';
import { createFrameLatest } from '../../lib/frameLatest';
import styles from './ResizeHandle.module.css';

// Neither side is useful once it is a sliver, so the drag stops short of both ends.
export const MIN_SHARE = 0.12;
const STEP = 0.02;

type Props = {
  /** 'x' splits side by side, 'y' splits top from bottom. */
  axis: 'x' | 'y';
  label: string;
  /** Where the boundary sits inside the box it divides, as a fraction of that box. */
  value: number;
  /** How far it may travel — the caller knows what else is in the box. */
  min: number;
  max: number;
  onChange: (value: number) => void;
};

// Measures the element it divides rather than taking a ref, so the panes either side stay unaware
// they are being resized.
export function ResizeHandle({ axis, label, value, min, max, onChange }: Props) {
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
    const box = ref.current?.parentElement?.getBoundingClientRect();
    // An unmeasured layout reports zero size; there is nothing to divide yet.
    if (!box) return;
    const span = axis === 'x' ? box.width : box.height;
    if (span <= 0) return;
    const along = axis === 'x' ? event.clientX - box.left : event.clientY - box.top;
    frame.offer(clamp(along / span));
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
      tabIndex={0}
      className={styles.handle}
      data-axis={axis}
      onPointerDown={grab}
      onPointerMove={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) dragTo(event);
      }}
      onPointerUp={(event) => event.currentTarget.releasePointerCapture(event.pointerId)}
      onKeyDown={nudge}
    />
  );
}

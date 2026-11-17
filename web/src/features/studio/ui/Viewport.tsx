import { useEffect, useRef, useState } from 'react';
import { StudioEngine, WebGLUnavailable } from '../engine/StudioEngine';
import { studioStore } from '../studioStore';
import styles from './Viewport.module.css';

/**
 * The canvas, and the engine's life: made when the viewport mounts, disposed when it unmounts —
 * which is when the panel closes. What the engine cannot do is said here, inside the panel.
 */
export function Viewport({ onReady }: { onReady: (engine: StudioEngine | null) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [lost, setLost] = useState(false);

  useEffect(() => {
    if (!canvas.current) return;
    let engine: StudioEngine | null = null;
    try {
      engine = StudioEngine.open(canvas.current, studioStore, (status) => setLost(status === 'lost'));
      onReady(engine);
    } catch (error) {
      setProblem(error instanceof WebGLUnavailable ? error.message : `The 3D view could not start: ${error instanceof Error ? error.message : String(error)}`);
      onReady(null);
    }
    return () => {
      onReady(null);
      engine?.dispose();
    };
  }, [onReady]);

  return (
    <div className={styles.viewport}>
      <canvas ref={canvas} className={styles.canvas} aria-label="3D view" />
      {problem && <p className={styles.notice} role="alert">{problem}</p>}
      {lost && !problem && <p className={styles.notice} role="status">The graphics card dropped the 3D view; it comes back on its own in a moment.</p>}
    </div>
  );
}

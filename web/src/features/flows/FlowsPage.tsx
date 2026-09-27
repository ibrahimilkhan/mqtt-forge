import styles from './FlowsPage.module.css';

/**
 * The Flows page. The default export, because React.lazy loads a module's default.
 *
 * A browser with no ResizeObserver cannot size a canvas, so it is told so rather than shown a
 * blank one. Every browser this console supports has it; the only place without it is jsdom,
 * which is why the test suite sees this sentence when it opens every panel in turn.
 */
export default function FlowsPage() {
  if (typeof ResizeObserver === 'undefined')
    return <p className={styles.missing}>The canvas needs a browser that can measure what it draws.</p>;

  return <div className={styles.page} />;
}

import type { ReactNode } from 'react';
import styles from './PanelShell.module.css';

// A pane with a fixed place has nothing to close, so the button follows the callback.
type Props = {
  title: string;
  /**
   * Whether the panel says its own name across the top of itself, on a band that ends on the
   * same line as the rail's.
   *
   * Every panel the menu opens does. A panel is a page: it is opened by name, it is read on its
   * own, and one whose top edge is whichever field happens to come first has no top edge at all.
   * The rail's own row says which is open, but it says it a rail's width away and in a list of
   * eight; the band says it where the reading starts.
   *
   * The one that does not is the publish form, which is not a page. It has a fixed place in the
   * workspace under the chart, it is never opened or closed, and the region it sits in has a
   * strip of its own with its name already on it.
   */
  named?: boolean;
  onClose?: () => void;
  children: ReactNode;
};

export function PanelShell({ title, named = false, onClose, children }: Props) {
  return (
    <section className={styles.panel} aria-label={`${title} panel`}>
      {/* Off screen only where there is no band to carry it — a pane with a fixed place, which
          has no name to say and no button to close. The head row is drawn when something has to
          sit on it, and an empty bordered row would leave a rule with nothing above it. */}
      {!named && <h2 className="srOnly">{title}</h2>}
      {/* data-head marks this row so the workspace can tell it from the content under it. A bare
          attribute rather than the class, because the class name is hashed by CSS Modules and
          Workspace.module.css cannot spell it — and the workspace is where the one panel that
          takes the whole window decides what its measure applies to. */}
      {(named || onClose) && (
        <div className={named ? `${styles.panelHead} ${styles.band}` : styles.panelHead} data-head>
          {named && <h2 className={styles.panelTitle}>{title}</h2>}
          {onClose && (
            <button type="button" className={styles.close} onClick={onClose} aria-label={`Close ${title} panel`}>
              ×
            </button>
          )}
        </div>
      )}
      <div className={styles.block}>{children}</div>
    </section>
  );
}

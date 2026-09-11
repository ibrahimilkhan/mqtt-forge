import type { ReactNode } from 'react';
import styles from './PanelShell.module.css';

// A pane with a fixed place has nothing to close, so the button follows the callback.
type Props = {
  title: string;
  /**
   * Whether the panel says its own name across the top of itself, on a band that ends on the
   * same line as the rail's.
   *
   * Only the panel that takes the whole window does. That one is a page: it is what the console
   * opens on, it fills everything the rail does not, and a page whose top edge is whichever field
   * happens to come first has no top edge at all. The six that sit in a column do not — they
   * stand a rail's width from the row that opened them, which says which panel is open and stays
   * lit while it is, and the same word again inside the column is one label twice an inch apart.
   */
  named?: boolean;
  onClose?: () => void;
  children: ReactNode;
};

export function PanelShell({ title, named = false, onClose, children }: Props) {
  return (
    <section className={styles.panel} aria-label={`${title} panel`}>
      {/* Off screen except on the panel that is a page, where the head band below carries this
          same heading somewhere it can be read. The head row is drawn only when something has to
          sit on it — the name, the close button, or both. A pane with a fixed place has neither,
          and an empty bordered row would leave a rule with nothing above it. */}
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

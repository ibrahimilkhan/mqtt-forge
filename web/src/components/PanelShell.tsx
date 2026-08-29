import type { ReactNode } from 'react';
import styles from './PanelShell.module.css';

// A pane with a fixed place has nothing to close, so the button follows the callback.
type Props = { title: string; onClose?: () => void; children: ReactNode };

export function PanelShell({ title, onClose, children }: Props) {
  return (
    <section className={styles.panel} aria-label={`${title} panel`}>
      {/* The title is off screen, so the head row is drawn only when the close button needs a
          place to sit. A pane with a fixed place has neither, and an empty bordered row would
          leave a rule with nothing above it. */}
      <h2 className="srOnly">{title}</h2>
      {/* data-head marks this row so the workspace can tell it from the content under it. A bare
          attribute rather than the class, because the class name is hashed by CSS Modules and
          Workspace.module.css cannot spell it — and the workspace is where the one panel that
          takes the whole window decides what its measure applies to. */}
      {onClose && (
        <div className={styles.panelHead} data-head>
          <button type="button" className={styles.close} onClick={onClose} aria-label={`Close ${title} panel`}>
            ×
          </button>
        </div>
      )}
      <div className={styles.block}>{children}</div>
    </section>
  );
}

import type { ReactNode } from 'react';
import styles from './PanelShell.module.css';

// A pane with a fixed place has nothing to close, so the button follows the callback.
type Props = { title: string; onClose?: () => void; children: ReactNode };

export function PanelShell({ title, onClose, children }: Props) {
  return (
    <section className={styles.panel} aria-label={`${title} panel`}>
      <div className={styles.panelHead}>
        <h2>{title}</h2>
        {onClose && (
          <button type="button" className={styles.close} onClick={onClose} aria-label={`Close ${title} panel`}>
            ×
          </button>
        )}
      </div>
      <div className={styles.block}>{children}</div>
    </section>
  );
}

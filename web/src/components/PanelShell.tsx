import type { ReactNode } from 'react';
import styles from './PanelShell.module.css';

type Props = { title: string; onClose: () => void; children: ReactNode };

export function PanelShell({ title, onClose, children }: Props) {
  return (
    <section className={styles.panel}>
      <div className={styles.panelHead}>
        <h2>{title}</h2>
        <button type="button" className={styles.close} onClick={onClose} aria-label={`Close ${title} panel`}>
          ×
        </button>
      </div>
      <div className={styles.block}>{children}</div>
    </section>
  );
}

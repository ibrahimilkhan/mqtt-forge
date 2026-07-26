import type { ReactNode } from 'react';
import styles from '../styles/panel.module.css';

type Props = { label: string; htmlFor: string; narrow?: boolean; children: ReactNode };

export function Field({ label, htmlFor, narrow = false, children }: Props) {
  return (
    <div className={narrow ? styles.narrow : undefined}>
      <label htmlFor={htmlFor}>{label}</label>
      {children}
    </div>
  );
}

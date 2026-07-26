import styles from './FilterChips.module.css';

type Props = { filters: string[]; onRemove: (filter: string) => void };

export function FilterChips({ filters, onRemove }: Props) {
  return (
    <div className={styles.filters}>
      {filters.map((filter) => (
        <span key={filter} className={styles.filter}>
          {filter}
          <button type="button" onClick={() => onRemove(filter)} aria-label={`Unsubscribe from ${filter}`}>
            ×
          </button>
        </span>
      ))}
    </div>
  );
}

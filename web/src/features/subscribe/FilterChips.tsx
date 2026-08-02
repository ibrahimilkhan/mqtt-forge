import { useSelectionStore } from '../../stores/selectionStore';
import styles from './FilterChips.module.css';

type Props = { filters: string[]; onRemove: (filter: string) => void; pendingFilter?: string };

export function FilterChips({ filters, onRemove, pendingFilter }: Props) {
  const selected = useSelectionStore((state) => state.selected);
  const select = useSelectionStore((state) => state.select);

  return (
    <div className={styles.filters}>
      {filters.map((filter) => (
        <span key={filter} className={styles.filter} data-selected={selected?.filter === filter}>
          {/* Two sibling buttons rather than one nested in the other: a chip both focuses the
              wire log and unsubscribes, and nested buttons are not valid HTML. */}
          <button
            type="button"
            className={styles.pick}
            aria-pressed={selected?.filter === filter}
            onClick={() => select({ label: filter, filter })}
          >
            {filter}
          </button>
          <button
            type="button"
            onClick={() => onRemove(filter)}
            disabled={pendingFilter === filter}
            aria-label={`Unsubscribe from ${filter}`}
          >
            ×
          </button>
        </span>
      ))}
    </div>
  );
}

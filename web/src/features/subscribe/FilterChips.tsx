import { memo, useCallback } from 'react';
import { useSelectionStore } from '../../stores/selectionStore';
import styles from './FilterChips.module.css';

type Props = { filters: string[]; onRemove: (filter: string) => void; pendingFilter?: string };

export function FilterChips({ filters, onRemove, pendingFilter }: Props) {
  const selected = useSelectionStore((state) => state.selected?.filter ?? null);
  const select = useSelectionStore((state) => state.select);

  // Stable, so a refetch after every subscribe re-renders only the chips that actually changed
  // rather than all several hundred of them.
  const pick = useCallback((filter: string) => select({ label: filter, filter }), [select]);

  return (
    <div className={styles.filters}>
      {filters.map((filter) => (
        <Chip
          key={filter}
          filter={filter}
          selected={selected === filter}
          pending={pendingFilter === filter}
          onPick={pick}
          onRemove={onRemove}
        />
      ))}
    </div>
  );
}

type ChipProps = {
  filter: string;
  selected: boolean;
  pending: boolean;
  onPick: (filter: string) => void;
  onRemove: (filter: string) => void;
};

const Chip = memo(function Chip({ filter, selected, pending, onPick, onRemove }: ChipProps) {
  return (
    <span className={styles.filter} data-selected={selected}>
      {/* Sibling buttons, not nested — nested buttons aren't valid HTML. */}
      <button
        type="button"
        className={styles.pick}
        aria-pressed={selected}
        onClick={() => onPick(filter)}
      >
        {filter}
      </button>
      <button
        type="button"
        onClick={() => onRemove(filter)}
        disabled={pending}
        aria-label={`Unsubscribe from ${filter}`}
      >
        ×
      </button>
    </span>
  );
});

import { memo, useCallback } from 'react';
import { useSelectionStore } from '../../stores/selectionStore';
import type { ActiveFilter } from '../../types/api';
import styles from './FilterChips.module.css';

type Props = {
  filters: ActiveFilter[];
  onRemove: (filter: string) => void;
  pendingFilter?: string;
};

export function FilterChips({ filters, onRemove, pendingFilter }: Props) {
  const selected = useSelectionStore((state) => state.selected?.filter ?? null);
  const select = useSelectionStore((state) => state.select);

  // Stable, so a refetch after every subscribe re-renders only the chips that actually changed
  // rather than all several hundred of them.
  // A chip is already a topic filter, so it is its own answer for colouring too.
  const pick = useCallback(
    (filter: string) => select({ label: filter, filter, topic: filter }),
    [select],
  );

  return (
    <div className={styles.filters}>
      {filters.map(({ topicFilter, console: ours, rules }) => (
        <Chip
          key={topicFilter}
          filter={topicFilter}
          selected={selected === topicFilter}
          pending={pendingFilter === topicFilter}
          // A filter only a rule holds is not this console's to drop: the × would send an
          // UNSUBSCRIBE the subscriber refuses to act on, and the chip would come straight back.
          held={!ours && rules}
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
  /** Held by an alert rule and not by this console, so there is nothing here to let go of. */
  held: boolean;
  onPick: (filter: string) => void;
  onRemove: (filter: string) => void;
};

const Chip = memo(function Chip({ filter, selected, pending, held, onPick, onRemove }: ChipProps) {
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
        disabled={pending || held}
        aria-label={
          held ? `${filter} is held by an alert rule` : `Unsubscribe from ${filter}`
        }
        title={held ? 'An alert rule asked for this filter. Disable the rule to drop it.' : undefined}
      >
        ×
      </button>
    </span>
  );
});

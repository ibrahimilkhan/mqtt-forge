import type { BrokerPreset } from './presets';
import styles from './BrokerPresets.module.css';

type Props = {
  /** The brokers this group offers. */
  presets: readonly BrokerPreset[];
  /** What the group is, over the chips. */
  title: string;
  /** Unique per group: two of these are on the panel, and both name their own chips. */
  labelId: string;
  /** What the group is as a whole, when that is not obvious from the title. Above the chips,
   *  because it is what a reader needs before picking one rather than after. */
  hint?: string;
  /** The preset the form currently matches, or null when the fields are the reader's own. */
  active: BrokerPreset | null;
  onPick: (preset: BrokerPreset) => void;
};

/**
 * A group of brokers this console can be pointed at without knowing anything first.
 *
 * Picking one fills the form and leaves it there — it does not connect. The address is the
 * easy half to get right by hand; what a preset is really carrying is the filter, and the
 * reader should see both sitting in the form before anything is sent.
 *
 * Two of these are on the panel: your own broker, above the fields it writes, and everyone
 * else's in a section of their own at the foot.
 */
export function BrokerPresets({ presets, title, labelId, hint, active, onPick }: Props) {
  return (
    <div className={styles.presets}>
      <p className={styles.lede} id={labelId}>
        {title}
      </p>

      {hint && <p className={styles.hint}>{hint}</p>}

      <div className={styles.chips} role="group" aria-labelledby={labelId}>
        {presets.map((preset) => (
          <button
            key={preset.name}
            type="button"
            className={styles.chip}
            aria-pressed={active?.name === preset.name}
            data-selected={active?.name === preset.name}
            onClick={() => onPick(preset)}
          >
            {preset.name}
          </button>
        ))}
      </div>

      {/* Only for the one in the form, and only when it is one of ours. Five notes at once is a
          wall nobody reads, and the question a reader has is about the broker they just picked —
          which, with the groups split, may well be the other group's. */}
      {active && presets.includes(active) && <p className={styles.note}>{active.note}</p>}
    </div>
  );
}

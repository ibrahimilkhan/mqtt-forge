import { BROKER_PRESETS, type BrokerPreset } from './presets';
import styles from './BrokerPresets.module.css';

type Props = {
  /** The preset the form currently matches, or null when the fields are the reader's own. */
  active: BrokerPreset | null;
  onPick: (preset: BrokerPreset) => void;
};

/**
 * The brokers this console can be pointed at without knowing anything first.
 *
 * Picking one fills the form and leaves it there — it does not connect. The address is the
 * easy half to get right by hand; what a preset is really carrying is the filter, and the
 * reader should see both sitting in the form before anything is sent.
 */
export function BrokerPresets({ active, onPick }: Props) {
  return (
    <div className={styles.presets}>
      <p className={styles.lede} id="presetsLabel">
        Start from a broker
      </p>

      <div className={styles.chips} role="group" aria-labelledby="presetsLabel">
        {BROKER_PRESETS.map((preset) => (
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

      {/* Only for the one in the form. Five notes at once is a wall nobody reads, and the
          question a reader has is about the broker they just picked. */}
      {active && <p className={styles.note}>{active.note}</p>}
    </div>
  );
}

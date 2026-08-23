import styles from './SavedBrokers.module.css';
import type { SavedProfile } from '../../types/api';

type Props = {
  profiles: readonly SavedProfile[];
  /** The one the form currently holds, so a chip can say "this is what you are looking at". */
  active: string | null;
  onPick: (profile: SavedProfile) => void;
  onForget: (name: string) => void;
};

/**
 * The brokers somebody kept, as things to press.
 *
 * This used to be eleven brokers somebody else runs — Helsinki's trams, HiveMQ's public one, four
 * cloud services — and none of them was ever the answer to "which broker am I connecting to".
 * These are, which is the whole difference: a list nobody wrote but the reader.
 *
 * Each chip is two controls, not one. Pressing the name fills the form; pressing the × beside it
 * forgets the broker. They are separate buttons rather than a chip with a hover action, because
 * a mis-hit on the second one destroys the only copy of something that was typed by hand.
 */
export function SavedBrokers({ profiles, active, onPick, onForget }: Props) {
  if (profiles.length === 0) return null;

  return (
    <div className={styles.chips} role="group" aria-label="Saved brokers">
      {profiles.map((profile) => (
        <span
          key={profile.name}
          className={styles.chip}
          data-active={profile.name === active ? '' : undefined}
        >
          <button type="button" className={styles.name} onClick={() => onPick(profile)}>
            {profile.name}
          </button>
          <button
            type="button"
            className={styles.forget}
            aria-label={`Forget ${profile.name}`}
            onClick={() => onForget(profile.name)}
          >
            ×
          </button>
        </span>
      ))}
    </div>
  );
}

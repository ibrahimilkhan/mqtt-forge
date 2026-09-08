import styles from './SavedBrokers.module.css';
import type { SavedConnection, SavedProfile } from '../../types/api';
import { formatBrokerAddress } from './address';
import { schemeOf } from './scheme';

type Props = {
  profiles: readonly SavedProfile[];
  /** The one the form currently holds, so a card can say "this is what you are looking at". */
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
 * Each one carries both of the facts it has: the name somebody typed, and where it points. The
 * name alone was a chip you had to press to find out what it meant — 'Lab', 'Old one', 'Ali's' —
 * and pressing it overwrites the form, so the way to read the list was to spend it. The address
 * under the name is the same string the log and the rail write, so a broker reads the same
 * wherever it is named.
 *
 * Each card is two controls, not one. Pressing it fills the form; pressing the × forgets the
 * broker. Separate buttons rather than a card with a hover action, because a mis-hit on the
 * second one destroys the only copy of something that was typed by hand.
 */
export function SavedBrokers({ profiles, active, onPick, onForget }: Props) {
  if (profiles.length === 0) return null;

  return (
    <div className={styles.chips} role="group" aria-label="Saved brokers">
      {profiles.map((profile) => (
        <div
          key={profile.name}
          className={styles.chip}
          data-active={profile.name === active ? '' : undefined}
        >
          <button type="button" className={styles.pick} onClick={() => onPick(profile)}>
            <span className={styles.name}>{profile.name}</span>
            <span className={styles.where}>{endpointOf(profile.connection)}</span>
          </button>
          <button
            type="button"
            className={styles.forget}
            aria-label={`Forget ${profile.name}`}
            onClick={() => onForget(profile.name)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

/**
 * Where a saved broker points, written the way the rest of the console writes an endpoint.
 *
 * Through the same two functions the form and the log go through, so the scheme is the one the
 * transport and the TLS box add up to and an IPv6 host keeps its brackets — `mqtt://::1:1883` is
 * an address nobody can find the port in.
 */
const endpointOf = (connection: SavedConnection): string =>
  `${formatBrokerAddress(schemeOf(connection.transport, connection.useTls), connection.host)}:${connection.port}`;

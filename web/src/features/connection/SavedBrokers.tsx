import styles from './SavedBrokers.module.css';
import type { SavedConnection, SavedProfile } from '../../types/api';
import { Link } from '../brand/icons';
import { formatBrokerAddress } from './address';
import { schemeOf } from './scheme';

type Props = {
  profiles: readonly SavedProfile[];
  /** The one the form currently holds, so a card can say "this is what you are looking at". */
  active: string | null;
  onPick: (profile: SavedProfile) => void;
  /** Fill the form from this one and dial, in one press. No link mark is drawn without it. */
  onConnect?: (profile: SavedProfile) => void;
};

/**
 * The brokers somebody kept, as things to press.
 *
 * This used to be eleven brokers somebody else runs — Helsinki's trams, HiveMQ's public one, four
 * cloud services — and none of them was ever the answer to "which broker am I connecting to".
 * These are, which is the whole difference: a list nobody wrote but the reader.
 *
 * Each one is drawn as the name somebody typed, and nothing else. It carried its address under
 * the name once — a name alone was a chip you had to press to find out what it meant — but the
 * name is the thing the reader chose to know the broker by, and a column of names over a column
 * of addresses was twice the reading for a list most visits only glance down. Pressing a card
 * shows where it points, in the form beside it, and the address is still there for a pointer in
 * the card's title: the same string the log and the rail write, so a broker reads the same
 * wherever it is named.
 *
 * Each card is two controls, not one. Pressing it fills the form; pressing the link mark at its
 * end dials it. Neither of them forgets the broker. The × that did stood a few pixels from the
 * mark that connects, and a mis-hit on it destroyed the only copy of something that was typed by
 * hand — so forgetting is asked for at the head of the form, about the broker the form is
 * holding, where the reader has just read what it is they are about to lose.
 */
export function SavedBrokers({ profiles, active, onPick, onConnect }: Props) {
  if (profiles.length === 0) return null;

  return (
    <div className={styles.chips} role="group" aria-label="Saved">
      {profiles.map((profile) => (
        <div
          key={profile.name}
          className={styles.chip}
          data-active={profile.name === active ? '' : undefined}
          data-go={onConnect ? '' : undefined}
        >
          {/* Where it points, for the pointer: the way to find out without pressing the card,
              which would overwrite the form to answer the question. */}
          <button
            type="button"
            className={styles.pick}
            title={endpointOf(profile.connection)}
            onClick={() => onPick(profile)}
          >
            <span className={styles.name}>{profile.name}</span>
          </button>
          {/* The mark at the end of the card: this broker, now. The card itself only fills the
              form, which is the right thing for a broker somebody means to look at first; this is
              for the one they connect to every morning. It is the mark Connect wears, because it
              is Connect — an arrow said 'go somewhere' and left the reader to guess where. */}
          {onConnect && (
            <button
              type="button"
              className={styles.go}
              aria-label={`Connect to ${profile.name}`}
              title="Connect"
              onClick={() => onConnect(profile)}
            >
              <Link />
            </button>
          )}
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

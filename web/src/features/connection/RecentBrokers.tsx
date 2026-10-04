import styles from './SavedBrokers.module.css';
import own from './RecentBrokers.module.css';
import type { RecentBroker, SavedConnection } from '../../types/api';
import { formatBrokerAddress } from './address';
import { schemeOf } from './scheme';

type Props = {
  brokers: readonly RecentBroker[];
  /** The one the form currently holds, so a card can say "this is what you are looking at". */
  active: string | null;
  onPick: (broker: RecentBroker) => void;
  onForget: (id: string) => void;
  /** Now, in milliseconds, so "3 hours ago" is as old as the panel around it. */
  now: number;
};

/**
 * Every broker this console reached, the saved ones included.
 *
 * The commonest way to lose a broker is not deleting it: it is connecting to one, working, and
 * moving on without pressing Save. The console remembered two things about brokers and neither
 * caught that — the saved list holds what somebody chose, and the settings file holds the last
 * link and overwrites itself on the next one. A reader who had three brokers in an afternoon kept
 * the third and lost the first two, along with the client ID and the filters they typed for them.
 *
 * These cards are the saved ones' cards with the two halves swapped: no name was ever typed, so
 * the address is the heading — host and port, the way it is typed into the form — and the line
 * under it carries what kind of link it was and how long ago.
 *
 * The same two controls as a saved card: pressing the body fills the form, and the × drops the
 * row. Keeping one for good is the form's own Save, pressed after the card has filled it — one way
 * to save a broker rather than a second, smaller one on every card. A kept broker stays here as well
 * as underneath — the list below is the brokers somebody named, this one is where the console has
 * been — and each broker is in it once, at the latest connection made to it.
 */
export function RecentBrokers({ brokers, active, onPick, onForget, now }: Props) {
  if (brokers.length === 0) return null;

  return (
    <div className={styles.chips} role="group" aria-label="Recent">
      {brokers.map((broker) => {
        const { connection } = broker;
        const endpoint = endpointOf(connection);
        const age = briefly(broker.lastConnectedAt, now);

        return (
          <div
            key={broker.id}
            className={`${styles.chip} ${own.card}`}
            data-active={broker.id === active ? '' : undefined}
          >
            {/* The whole endpoint, for the pointer. At the narrowest column a long address is cut,
                and this is where it comes back without anybody pressing the card, which would
                overwrite the form to find out. The accessible name is still the card's text; a
                title only names a button that has none of its own. */}
            <button
              type="button"
              className={`${styles.pick} ${own.pick}`}
              title={endpoint}
              onClick={() => onPick(broker)}
            >
              {/* Host and port on one line, the way an address is written everywhere else. The
                  scheme does not ride in front of it: `mqtts://broker.hivemq.com:8883` spends eight
                  characters every card shares before the few that tell them apart. The port does,
                  because 1883 against 21883 is exactly what tells two cards for one host apart. */}
              <span className={styles.name}>{`${hostOf(connection.host)}:${connection.port}`}</span>

              {/* The spaces between these spans are for the name a screen reader is handed, not for
                  the eye: whitespace between grid and flex items is never drawn, and without them
                  the card would be announced as 'broker.example:1883mqtt3 hours ago'. Tidying them
                  away breaks nothing anyone can see, which is why this says so. */}
              {' '}
              <span className={own.foot}>
                <span className={own.scheme}>{schemeOf(connection.transport, connection.useTls)}</span>

                {/* Twice, for two readers. The eye gets '9h', which fits the narrowest column and
                    orders the list without being read; a screen reader gets '9 hours ago', which is
                    a sentence rather than a letter it may spell out. Each is hidden from the other,
                    so neither is told it twice. */}
                {age !== null && (
                  <span className={own.when} aria-hidden="true">
                    {age}
                  </span>
                )}
                {' '}
                <span className="srOnly">{since(broker.lastConnectedAt, now)}</span>
              </span>
            </button>

            <button
              type="button"
              className={`${styles.forget} ${own.forget}`}
              aria-label={`Forget ${endpoint}`}
              onClick={() => onForget(broker.id)}
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}

/**
 * The host alone, with an IPv6 literal back inside its brackets.
 *
 * `formatBrokerAddress` is the console's answer to that question, and this is that answer with the
 * scheme it insists on taken off again — rather than a second set of rules about square brackets
 * that could drift from the first.
 */
const hostOf = (host: string): string => formatBrokerAddress('mqtt', host).replace('mqtt://', '');

/**
 * Where a broker points, written the way the rest of the console writes an endpoint.
 *
 * The same two functions the saved cards go through, so one broker reads the same in both lists.
 */
const endpointOf = (connection: SavedConnection): string =>
  `${formatBrokerAddress(schemeOf(connection.transport, connection.useTls), connection.host)}:${connection.port}`;

type Unit = 'minute' | 'hour' | 'day' | 'month' | 'year';

/**
 * How long ago, as a count of the coarsest unit that still says something — worked out once for
 * both ways the card writes it. Two functions each carrying their own thresholds would be two
 * answers to "is this 30 days or a month" that drift apart the first time one of them is touched.
 *
 * A time of day would need the reader to know what today is on the machine the server runs on —
 * which may not be the one they are sitting at. What this answers is "is this the one I had open
 * this morning, or one from last month", and a single rounded unit answers it.
 */
function ageOf(when: string, now: number): { how: number; unit: Unit } | 'now' | null {
  const at = Date.parse(when);
  if (Number.isNaN(at)) return null;

  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return 'now';

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return { how: minutes, unit: 'minute' };

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { how: hours, unit: 'hour' };

  const days = Math.floor(hours / 24);
  if (days < 31) return { how: days, unit: 'day' };

  const months = Math.floor(days / 30);
  if (months < 12) return { how: months, unit: 'month' };

  return { how: Math.floor(days / 365), unit: 'year' };
}

/** The sentence: '3 hours ago'. What a screen reader is given, and what the tests have always read. */
export function since(when: string, now: number): string {
  const age = ageOf(when, now);
  if (age === null) return 'connected before';
  if (age === 'now') return 'just now';

  return `${count(age.how, age.unit)} ago`;
}

/*
 * Minutes are 'min' and never a bare 'm'. A list that says '40m' on one card and '2mo' on the next
 * is asking the reader which of the two is months, and the one they get wrong is the one that
 * matters: this morning's broker read as a season ago.
 */
const SHORT: Readonly<Record<Unit, string>> = { minute: 'min', hour: 'h', day: 'd', month: 'mo', year: 'y' };

/**
 * The same age for the eye: '40min', '9h', '13d', '2mo'. Nothing at all for a date that cannot be
 * read — the sentence beside it says 'connected before', and a mark standing for "unknown" would be
 * one more thing on a line that is meant to be skipped.
 */
export function briefly(when: string, now: number): string | null {
  const age = ageOf(when, now);
  if (age === null) return null;
  if (age === 'now') return 'now';

  return `${age.how}${SHORT[age.unit]}`;
}

const count = (how: number, unit: string) => `${how} ${unit}${how === 1 ? '' : 's'}`;
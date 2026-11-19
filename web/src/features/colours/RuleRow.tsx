import panel from '../../styles/panel.module.css';
import { isAddressKey, type BrokerScope } from '../../lib/brokerScope';
import type { SavedProfile } from '../../types/api';
import { TopicPicker } from '../alerts/TopicPicker';
import { Search } from '../brand/icons';
import { ColourPicker } from './ColourPicker';
import styles from './ColoursPanel.module.css';
import type { DraftRule } from './ruleDraft';

type Props = {
  rule: DraftRule;
  /** Its place in the list, from nought. Shown from one, and said in every control's name. */
  index: number;
  /** Why the row cannot be saved, or null when it can. See `faultIn`. */
  fault: string | null;
  /** Every saved broker a rule can belong to; undefined until they have been read. */
  profiles: readonly SavedProfile[] | undefined;
  /** The broker that is up, offered first; null before any link has come up. */
  current: BrokerScope | null;
  /** Another broker's rule: drawn faded, and painting nothing while this broker is up. */
  elsewhere: boolean;
  /** Whether this row's topic picker is the one that is open. */
  picking: boolean;
  onEdit: (change: Partial<DraftRule>) => void;
  onRemove: () => void;
  onTogglePicker: () => void;
  onPick: (filter: string) => void;
  onClosePicker: () => void;
};

/**
 * One colour rule, as a row of the table: its number, the topic's colour and the message's, the
 * filter with the glass that fills it in, the broker it belongs to, and the
 * × that drops it. Under those, when there is something to say, why it cannot be saved and the
 * broker's tree to pick a topic from.
 *
 * It holds nothing of its own. The list is one draft and the panel keeps it, so every edit here
 * is handed back up — which is also what lets the panel have one picker open at a time.
 */
export function RuleRow({
  rule,
  index,
  fault,
  profiles,
  current,
  elsewhere,
  picking,
  onEdit,
  onRemove,
  onTogglePicker,
  onPick,
  onClosePicker,
}: Props) {
  return (
    <div
      className={styles.ruleRow}
      data-testid="colour-rule"
      data-elsewhere={elsewhere ? '' : undefined}
    >
      {/* Its place in the list, for pointing at a row in a sentence somebody says out
          loud. NOT precedence: which rule paints a topic is decided by whose it is — this
          broker's before every broker's — and then by which filter says more about it,
          wherever the two happen to sit. See sortRules. */}
      <span className={panel.ruleNumber}>{index + 1}</span>

      <ColourPicker
        colour={rule.colour}
        filter={rule.filter}
        what="topic"
        // Never null: the topic's picker offers no way to clear one, because a topic drawn
        // in no colour is a topic with no rule. The guard is what says so in the types.
        onChange={(colour) => colour && onEdit({ colour })}
      />

      {/* The message's own colour, and it may be none — which is what it is until
          somebody says otherwise. A topic told apart by colour usually wants its payload
          left in the console's ink; a rule watching one device's telemetry among forty
          wants both, and until now could only have the first. */}
      <ColourPicker
        colour={rule.bodyColour}
        filter={rule.filter}
        what="message"
        clearable
        fallback={rule.colour}
        onChange={(bodyColour) => onEdit({ bodyColour })}
      />

      {/* The box and the way to fill it in, on one line. The glass used to stand at the
          far end of the row, past the count — two columns away from the only field it
          writes into, and reading as a third thing you can do to a rule rather than as
          the field's own control. */}
      <span className={styles.filterCell}>
        <input
          className={styles.filter}
          value={rule.filter}
          spellCheck={false}
          placeholder="sensors/+/temp"
          aria-label={`Topic filter for rule ${index + 1}`}
          aria-invalid={fault !== null}
          onChange={(event) => onEdit({ filter: event.target.value })}
        />

        <button
          type="button"
          className={styles.rowMark}
          aria-expanded={picking}
          aria-label={
            picking
              ? `Hide topics on the broker for rule ${index + 1}`
              : `Show topics on the broker for rule ${index + 1}`
          }
          title="Pick a topic off the broker"
          onClick={onTogglePicker}
        >
          <Search />
        </button>
      </span>

      {/* The broker that is up first, since a rule is usually written about the tree in front of
          the reader; then every broker, then the other saved ones. One that has been deleted since
          is still named as gone rather than quietly turned into every broker: the rule was
          written for it. One written for a broker that was never saved is named by its address. */}
      <select
        className={styles.broker}
        value={rule.profileId ?? ''}
        aria-label={`Broker for rule ${index + 1}`}
        onChange={(event) => onEdit({ profileId: event.target.value || null })}
      >
        {current && (
          <option value={current.own}>
            {current.name} (connected)
          </option>
        )}
        <option value="">All brokers</option>
        {profiles
          ?.filter((profile) => profile.id !== current?.own)
          .map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.name}
            </option>
          ))}
        {rule.profileId !== null &&
          rule.profileId !== current?.own &&
          (isAddressKey(rule.profileId) ? (
            <option value={rule.profileId}>{rule.profileId}</option>
          ) : (
            profiles !== undefined &&
            !profiles.some((profile) => profile.id === rule.profileId) && (
              <option value={rule.profileId}>A deleted broker</option>
            )
          ))}
      </select>

      <span className={styles.rowActions}>
        <button
          type="button"
          className={styles.remove}
          aria-label={`Remove the rule for ${rule.filter || 'this filter'}`}
          title="Remove this rule"
          onClick={onRemove}
        >
          ×
        </button>
      </span>

      {/* Both of these stand under the row rather than in a cell of it: the fault from the
          filter's column on, because the filter is what it is about, and the tree across the
          whole row. Dropped into a grid track either would be a paragraph three words wide. */}
      {fault && <p className={styles.rowFault}>{fault}</p>}

      {picking && (
        <div className={styles.rowPicker}>
          <TopicPicker
            onPick={onPick}
            onClose={onClosePicker}
          />
        </div>
      )}
    </div>
  );
}

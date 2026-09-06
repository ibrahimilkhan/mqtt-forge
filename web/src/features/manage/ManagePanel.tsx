import { useEffect, useState } from 'react';
import { PanelShell } from '../../components/PanelShell';
import { filterPath, retainedTopics } from '../../lib/topicTree';
import { runFor, useLogStore } from '../../stores/logStore';
import { useAppearanceStore } from '../../stores/appearanceStore';
import { useBrokerEventsStore } from '../../stores/brokerEventsStore';
import { clearTraffic } from '../../stores/clearTraffic';
import { useSelectionStore } from '../../stores/selectionStore';
import { useTopicTreeStore } from '../../stores/topicTreeStore';
import { useHoldStore } from '../monitor/useTraffic';
import { clearRetained } from './clearRetained';
import panel from '../../styles/panel.module.css';
import styles from './ManagePanel.module.css';

/** How often the counts are worked out. Once a second: they are read, not watched. */
const EVERY_MS = 1000;

/** One paused topic, as the list draws it. */
type Paused = { filter: string; label: string; holding: number; behind: number };

/**
 * What the console is holding, what the broker is holding, and what the reader has paused.
 *
 * Three questions that had no screen. Each of them was answerable only from the place it
 * happened — the count in a region strip, a paused row somewhere in a tree of four thousand,
 * a retained message that is not the console's at all — and after an afternoon of watching a
 * plant the answers are exactly what a reader has lost track of.
 *
 * It is a panel of counts and of ways to let go of things, so nothing here is undoable and
 * everything here says what it is about to do before it does it. The one that reaches past this
 * console — clearing what the broker retains — asks twice.
 */
export function ManagePanel({ onClose }: { onClose: () => void }) {
  const holds = useHoldStore((state) => state.held);
  const release = useHoldStore((state) => state.release);
  const select = useSelectionStore((state) => state.select);
  const events = useBrokerEventsStore((state) => state.events);
  const clearEvents = useBrokerEventsStore((state) => state.clear);
  const loadMb = useAppearanceStore((state) => state.loadMb);
  // How many topics the tree has given up to its ceiling this connection. Read here because the
  // retained figure below is counted off that tree, and a tree that has forgotten is a figure
  // that is short. See the note beside it.
  const forgotten = useTopicTreeStore((state) => state.forgotten);

  // Worked out on a timer rather than from a subscription: every number here walks a run or a
  // tree, and a panel that did that on every arrival would cost the most on the brokers where
  // it is most worth having open.
  const [reading, setReading] = useState(() => count(holds));

  useEffect(() => {
    setReading(count(holds));
    const timer = setInterval(() => setReading(count(useHoldStore.getState().held)), EVERY_MS);

    return () => clearInterval(timer);
  }, [holds]);

  const [asking, setAsking] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [said, setSaid] = useState<string | null>(null);

  const retained = reading.retained;

  const forget = async () => {
    setClearing(true);
    const { done, failed } = await clearRetained(retained);
    setClearing(false);
    setAsking(false);
    setSaid(
      failed === 0
        ? `Told the broker to forget ${done} ${done === 1 ? 'topic' : 'topics'}.`
        : `Forgot ${done}; the broker refused ${failed}.`,
    );
    // The count is not put right here. What was cleared comes back down this console's own
    // subscription as an empty retained message on each topic, and the reading below is what
    // notices — which is the honest answer anyway: the count says what the broker is holding,
    // as far as this console has been told, rather than what it was just asked to let go of.
  };

  return (
    <PanelShell title="Manage" onClose={onClose}>
      <section className={panel.group}>
        <h3 className={panel.groupTitle}>Paused topics</h3>

        {reading.paused.length === 0 ? (
          <p className={panel.note}>
            Nothing is paused. The control on a topic's row in the tree stops that row and the run
            it stands for; every other row carries on.
          </p>
        ) : (
          <>
            <ul className={styles.list}>
              {reading.paused.map((one) => (
                <li key={one.filter} className={styles.row}>
                  {/* The name is the way back to it: a reader who has paused six topics is
                      looking at this list precisely because they cannot find them. */}
                  <button
                    type="button"
                    className={styles.goTo}
                    title="Show this run in the log"
                    onClick={() =>
                      select({ label: one.label, filter: one.filter, topic: one.label })
                    }
                  >
                    {one.label}
                  </button>

                  <span className={styles.figures}>
                    <span>{one.holding} held</span>
                    {/* Only when there is one. 'behind 0' on a topic nothing has arrived on is a
                        fact about a question nobody asked. */}
                    {one.behind > 0 && <span className={styles.behind}>{one.behind} behind</span>}
                  </span>

                  <button
                    type="button"
                    className={styles.action}
                    aria-label={`Let go of ${one.label}`}
                    onClick={() => release(one.filter)}
                  >
                    Let go
                  </button>
                </li>
              ))}
            </ul>

            {reading.paused.length > 1 && (
              <div className={panel.actions}>
                <button type="button" className="ghost" onClick={() => release()}>
                  Let go of all {reading.paused.length}
                </button>
              </div>
            )}
          </>
        )}
      </section>

      <section className={panel.group}>
        <h3 className={panel.groupTitle}>What this console is holding</h3>

        <dl className={styles.figuresList}>
          <div>
            <dt>Messages</dt>
            <dd>{reading.held.toLocaleString('en-GB')}</dd>
          </div>
          <div>
            <dt>Topics</dt>
            <dd>{reading.topics.toLocaleString('en-GB')}</dd>
          </div>
          <div>
            <dt>Payload</dt>
            <dd>
              {weigh(reading.weight)} of {loadMb >= 1000 ? `${loadMb / 1000} GB` : `${loadMb} MB`}
            </dd>
          </div>
          <div>
            <dt>Broker events</dt>
            <dd>{events.length}</dd>
          </div>
        </dl>

        {reading.full && (
          <p className={panel.note}>
            Full: every topic is keeping its newest 256 kB and the rest is being let go. Settings
            is where that ceiling is chosen.
          </p>
        )}

        <div className={panel.actions}>
          <button
            type="button"
            className="ghost"
            disabled={reading.held === 0 && reading.topics === 0}
            title="Let go of every message the console is holding, and the tree of topics with it"
            onClick={clearTraffic}
          >
            Clear the traffic
          </button>
          <button
            type="button"
            className="ghost"
            disabled={events.length === 0}
            title="Clear the record of what the link has been doing"
            onClick={clearEvents}
          >
            Clear the events
          </button>
        </div>
      </section>

      <section className={panel.group}>
        <h3 className={panel.groupTitle}>What the broker is holding</h3>

        <p className={panel.note}>
          A retained message belongs to the broker, not to this console: it outlives every
          connection and is handed to whoever subscribes next. Clearing one means publishing an
          empty message in its place, which is how MQTT says forget this.
        </p>

        <dl className={styles.figuresList}>
          <div>
            <dt>Retained</dt>
            <dd>
              {retained.length.toLocaleString('en-GB')}{' '}
              {retained.length === 1 ? 'topic' : 'topics'}
            </dd>
          </div>
        </dl>

        {/* The figure above is counted off this console's own tree, and that tree has a ceiling:
            a broker holding more retained topics than MAX_TREE_TOPICS hands over every one of
            them and the quietest are forgotten as they arrive. Under a heading that says 'what
            the broker is holding' the shortfall would be read as the broker's, and the button
            below would then report clearing a broker it had only partly cleared. Said here, once,
            rather than in the counts: what is wrong is not the number but what it is a number of. */}
        {forgotten > 0 && (
          <p className={panel.note} data-testid="retained-short">
            This is what this console has seen. The tree gave up{' '}
            {forgotten.toLocaleString('en-GB')} quiet{' '}
            {forgotten === 1 ? 'topic' : 'topics'} to its ceiling, so the broker is holding at
            least that many more, and clearing from here would leave them.
          </p>
        )}

        {said && <p className={panel.note}>{said}</p>}

        {asking ? (
          <>
            {/* Named, up to a point a reader can still read: this is the one control here that
                reaches past the console and changes what everybody else's client will see. */}
            <p className={panel.note}>
              This clears the retained message on {retained.length.toLocaleString('en-GB')}{' '}
              {retained.length === 1 ? 'topic' : 'topics'}
              {retained.length <= 6 ? `: ${retained.join(', ')}` : ''}. Every other client sees it
              too, and nothing here can put them back.
            </p>
            <div className={panel.actions}>
              <button type="button" onClick={forget} disabled={clearing}>
                {clearing ? 'Clearing…' : `Yes, clear ${retained.length.toLocaleString('en-GB')}`}
              </button>
              <button type="button" className="ghost" onClick={() => setAsking(false)}>
                Cancel
              </button>
            </div>
          </>
        ) : (
          <div className={panel.actions}>
            <button
              type="button"
              className="ghost"
              disabled={retained.length === 0}
              onClick={() => {
                setSaid(null);
                setAsking(true);
              }}
            >
              Clear retained messages
            </button>
          </div>
        )}
      </section>
    </PanelShell>
  );
}

/** Everything the panel draws, read in one pass off the stores. */
function count(holds: ReadonlyMap<string, { filter: string; entries: { id: number }[] }>) {
  const log = useLogStore.getState();

  const paused: Paused[] = [...holds.values()].map((one) => ({
    filter: one.filter,
    // The path rather than the filter: a row's hold is taken on `plant/boiler/#`, and what the
    // reader paused was plant/boiler.
    label: filterPath(one.filter) ?? one.filter,
    holding: one.entries.length,
    behind:
      one.entries.length === 0
        ? 0
        : runFor(log.byTopic, one.filter).filter((entry) => entry.id > one.entries[0].id).length,
  }));
  paused.sort((a, b) => a.label.localeCompare(b.label));

  const root = useTopicTreeStore.getState().root;

  return {
    paused,
    held: log.held,
    weight: log.weight,
    full: log.capped,
    topics: root.subTopics,
    // Walked with the rest of it rather than read once when the panel opened: the answer changes
    // under the reader — a retained message arrives, or the clear below empties one — and a
    // figure that had to be reopened to be believed is worse than no figure.
    retained: retainedTopics(root),
  };
}

/** The bodies as they are held, which is characters rather than bytes on the wire. */
function weigh(chars: number): string {
  if (chars < 1024) return `${chars} B`;
  if (chars < 1024 * 1024) return `${(chars / 1024).toFixed(0)} kB`;

  return `${(chars / 1024 / 1024).toFixed(1)} MB`;
}

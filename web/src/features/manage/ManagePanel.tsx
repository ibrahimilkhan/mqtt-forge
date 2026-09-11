import { useEffect, useState } from 'react';
import { PanelShell } from '../../components/PanelShell';
import { filterPath, retainedTopics } from '../../lib/topicTree';
import { runFor, useLogStore } from '../../stores/logStore';
import { useAppearanceStore } from '../../stores/appearanceStore';
import { useBrokerEventsStore } from '../../stores/brokerEventsStore';
import { clearTraffic } from '../../stores/clearTraffic';
import { useSelectionStore } from '../../stores/selectionStore';
import { useHealthStore } from '../../stores/healthStore';
import { usePauseStore } from '../../stores/pauseStore';
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
  /** Which of the two clears above is being asked about, and null while neither is. */
  const [emptying, setEmptying] = useState<'traffic' | 'events' | null>(null);
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
        : done === 0
          // The ordinary answer from a broker that does not let this client publish, and 'Forgot
          // 0' is a strange way to say nothing happened.
          ? `The broker refused ${failed === 1 ? 'the topic' : `all ${failed} topics`}.`
          : `Forgot ${done}; the broker refused ${failed}.`,
    );
    // The count is not put right here. What was cleared comes back down this console's own
    // subscription as an empty retained message on each topic, and the reading below is what
    // notices — which is the honest answer anyway: the count says what the broker is holding,
    // as far as this console has been told, rather than what it was just asked to let go of.
  };

  return (
    <PanelShell title="Manage" named onClose={onClose}>
      {/* First, because it is what the panel is opened for: how much is this console carrying,
          and is any of it missing. The two figures that answer the second question — what the
          server had to drop, and what the tree gave up — used to be sayable only in the tree's
          own foot and the log's, so a reader asking 'am I seeing everything' had to know where
          to look. A zero in either cell is the answer they came for. */}
      <section className={panel.group}>
        <h3 className={panel.groupTitle}>Held by this console</h3>

        <dl className={styles.counts} data-testid="console-figures">
          <Figure label="Messages" value={reading.held.toLocaleString('en-GB')} />
          <Figure
            label="Topics"
            value={reading.topics.toLocaleString('en-GB')}
            note={
              reading.forgotten > 0
                ? `${reading.forgotten.toLocaleString('en-GB')} forgotten to the ceiling`
                : undefined
            }
          />
          <Figure
            label="Payload"
            value={weigh(reading.weight)}
            note={`of ${loadMb >= 1000 ? `${loadMb / 1000} GB` : `${loadMb} MB`}`}
          />
          <Figure
            label="Dropped"
            value={(reading.dropped + reading.lost).toLocaleString('en-GB')}
            note={reading.dropped + reading.lost > 0 ? 'never reached the log' : undefined}
          />
          <Figure label="Broker events" value={events.length.toLocaleString('en-GB')} />
        </dl>

        {reading.full && (
          <p className={panel.note} data-testid="load-full">
            Full — every topic keeps its newest 256 kB. Settings chooses the ceiling.
          </p>
        )}

        {/* Both of these throw away a session's worth of what the console has seen, and neither
            can be undone — the traffic is not the broker's to give back, and the record of what
            the link did is written nowhere else. So each is asked before it is done, in the same
            two-button shape the retained section below has always used. */}
        {emptying ? (
          <>
            <p className={panel.note}>
              {emptying === 'traffic'
                ? 'Every topic, and the tree with it. Nothing here can put them back.'
                : 'The record of what the link has been doing. It is written nowhere else.'}
            </p>
            <div className={`${panel.actions} ${styles.clears}`}>
              <button
                type="button"
                onClick={() => {
                  if (emptying === 'traffic') clearTraffic();
                  else clearEvents();
                  setEmptying(null);
                }}
              >
                {emptying === 'traffic'
                  ? `Yes, clear ${reading.held.toLocaleString('en-GB')} messages`
                  : `Yes, clear ${events.length.toLocaleString('en-GB')} events`}
              </button>
              <button type="button" className="ghost" onClick={() => setEmptying(null)}>
                Cancel
              </button>
            </div>
          </>
        ) : (
          <div className={`${panel.actions} ${styles.clears}`}>
            <button
              type="button"
              className="ghost"
              disabled={reading.held === 0 && reading.topics === 0}
              title="Clear the traffic and the topic tree"
              onClick={() => setEmptying('traffic')}
            >
              Clear traffic
            </button>
            <button
              type="button"
              className="ghost"
              disabled={events.length === 0}
              title="Clear the record of what the link has been doing"
              onClick={() => setEmptying('events')}
            >
              Clear events
            </button>
          </div>
        )}
      </section>

      <section className={panel.group}>
        <h3 className={panel.groupTitle}>Paused topics</h3>

        {reading.paused.length === 0 ? (
          <p className={panel.note}>
            Nothing is paused.
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
        <h3 className={panel.groupTitle}>Held by the broker</h3>

        {/* What a retained message is belongs where it is about to be destroyed — the paragraph
            that stood here explained the concept to a reader who had not asked for it, and left
            the sentence that matters ('every other client sees this too') to the confirmation.
            The figure and the button are the whole of the section now.

            A line rather than a cell: one number does not need a card, and a card holding one
            number stretches to the width of a panel that has five. */}
        <dl className={styles.one} data-testid="broker-figures">
          <dt>Retained</dt>
          <dd>
            {retained.length.toLocaleString('en-GB')} {retained.length === 1 ? 'topic' : 'topics'}
          </dd>
        </dl>

        {/* The figure above is counted off this console's own tree, and that tree has a ceiling:
            a broker holding more retained topics than MAX_TREE_TOPICS hands over every one of
            them and the quietest are forgotten as they arrive. Under a heading that says the
            broker is holding them the shortfall would be read as the broker's, and the button
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
              A retained message belongs to the broker rather than to this console: it outlives
              every connection and is handed to whoever subscribes next. Clearing one means
              publishing an empty message in its place.
            </p>
            <p className={panel.note}>
              This clears {retained.length.toLocaleString('en-GB')}{' '}
              {retained.length === 1 ? 'topic' : 'topics'}
              {retained.length <= 6 ? `: ${retained.join(', ')}` : ''}. Every other client sees it
              too, and nothing here can put them back.
            </p>
            <div className={panel.actions}>
              <button type="button" onClick={forget} disabled={clearing}>
                {clearing
                  ? 'Clearing…'
                  : `Yes, clear ${retained.length.toLocaleString('en-GB')} ${retained.length === 1 ? 'topic' : 'topics'}`}
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
              Clear retained
            </button>
          </div>
        )}
      </section>
    </PanelShell>
  );
}

/**
 * One figure: what it is, how much of it there is, and a word under it when the number alone
 * would raise the question it answers.
 *
 * A cell rather than a row of label-and-value, because five of these are read by sweeping across
 * them once. The note is where a number's units, its ceiling or its meaning go — 'of 500 MB',
 * 'never reached the log' — so the figure itself stays a figure.
 */
function Figure({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className={styles.count}>
      <dt>{label}</dt>
      <dd>{value}</dd>
      {note && <p className={styles.countNote}>{note}</p>}
    </div>
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

  const tree = useTopicTreeStore.getState();
  const root = tree.root;

  return {
    paused,
    held: log.held,
    weight: log.weight,
    full: log.capped,
    topics: root.subTopics,
    /** Topics the tree gave up to its ceiling this connection. */
    forgotten: tree.forgotten,
    /** Messages that never left the server because this console was behind. */
    dropped: useHealthStore.getState().dropped,
    /** And messages let go of on this side, by a queue past its own ceiling. */
    lost: usePauseStore.getState().lost,
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

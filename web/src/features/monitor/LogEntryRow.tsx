import { memo, useState, type CSSProperties } from 'react';
import type { ColourRule } from '../../lib/topicColour';
import { useComposeStore } from '../../stores/composeStore';
import { stampsFor, type LogEntry } from '../../stores/logStore';
import styles from './WireLog.module.css';

/**
 * How much of a payload a row shows before it has to be asked.
 *
 * A console has to hold both ends of the range: a temperature is four characters, and a device
 * that reports its whole configuration on connect is forty thousand. Unclamped, one of the second
 * kind fills the region and pushes every other arrival off the pane — and the reader who wanted
 * it was going to copy it out anyway rather than read it here.
 *
 * Long enough that an ordinary JSON body is never cut, short enough that a big one cannot take
 * the pane.
 */
const SHOW = 480;

/** What the clamp in the stylesheet actually shows. Kept here so the control agrees with it. */
const CLAMP_LINES = 4;

const lines = (body: string) => body.split('\n').length;

// Entries are immutable, so memoising means a new arrival re-renders only one row.
export const LogEntryRow = memo(function LogEntryRow({
  entry,
  rule,
  repeats = false,
  onLoaded,
}: {
  entry: LogEntry;
  /** The colour rule covering this entry's topic, or null when none does. */
  rule?: ColourRule | null;
  /** The row above already named this topic, and the pane is showing one topic only. */
  repeats?: boolean;
  /** Told when this row has been put in the publish form, so the pane can say so out loud. */
  onLoaded?: (topic: string) => void;
}) {
  const load = useComposeStore((state) => state.load);
  const [whole, setWhole] = useState(false);

  // A body is long when it has more characters than the clamp shows OR more lines than it has
  // room for. The clamp is a height and the threshold is a character count, so on their own they
  // disagree in both directions: a pretty-printed three-hundred-character object is fifteen lines
  // and was cut with nothing offering to open it.
  const long = !!entry.body && (entry.body.length > SHOW || lines(entry.body) > CLAMP_LINES);

  // Only an arrival can be sent back. A command entry carries the filter it was aimed at, which
  // may be a wildcard, and an outcome rather than a payload — neither is publishable. The whole
  // row is the target rather than a small icon, since re-sending what just arrived is the
  // common move in a fake console.
  const reload =
    entry.topic && entry.kind === 'recv'
      ? () =>
          load({
            topic: entry.topic!,
            payload: entry.body,
            mode: entry.mode,
            qos: entry.qos ?? 0,
            retain: entry.retain ?? false,
          })
      : undefined;

  const take = () => {
    reload?.();
    if (entry.topic) onLoaded?.(entry.topic);
  };

  // Written here rather than carried on the entry: a row is drawn a screen at a time, where the
  // log holds half a million of them.
  const stamps = stampsFor(entry);

  return (
    <div
      className={styles.entry}
      data-kind={entry.kind}
      data-testid="entry"
      // Clickable, but not a button. It used to carry role="button" with an aria-label, which
      // made the whole row one control named 'Load … into publish' — and `button` is a role whose
      // children are presentational, so the time, the stamps, the topic and the payload itself
      // were all dropped from the accessibility tree. The pane's entire content was unreadable to
      // anyone not looking at it. The action lives on a real button below; this is the mouse's
      // shortcut to the same thing, and nothing but a shortcut.
      data-loads={reload ? '' : undefined}
      style={rule ? ({ '--rule-colour': rule.colour } as CSSProperties) : undefined}
      {...(reload && {
        onClick: (event: React.MouseEvent) => {
          // Reading a payload is not asking to send it. The selection check catches a finished
          // drag; the target check catches the first click of a double-click on a word, which
          // leaves no selection behind and used to load the row out from under the reader.
          if ((event.target as Element).closest(`[data-testid='body']`)) return;
          if (window.getSelection()?.isCollapsed !== false) take();
        },
      })}
    >
      {/* Time, QoS, retained, size: one line of furniture, read left to right, before the topic
          and the payload that are what the row is actually about. An arrival adds no verb to it —
          the pane holds nothing but arrivals, so there is nothing for one to tell apart. */}
      <div className={styles.entryHead} data-testid="head">
        <span>{new Date(entry.at).toLocaleTimeString('en-GB', { hour12: false })}</span>
        {entry.verb && (
          <span className={styles.verb} data-testid="verb">
            {entry.verb}
          </span>
        )}
        {stamps && (
          <span className={styles.stamps}>
            {stamps.map((stamp) => (
              <span key={stamp} className={styles.stamp} data-stamp={stamp}>
                {stamp}
              </span>
            ))}
          </span>
        )}

        {/* The action, as one real button with a name of its own. On the head rather than on the
            topic, because a repeated topic is not drawn — and a row every reader can reach has to
            be reachable on the rows where it is not. */}
        {reload && (
          <button
            type="button"
            className={styles.load}
            data-testid="load"
            aria-label={`Load ${entry.topic} into publish`}
            title="Load into publish"
            onClick={(event) => {
              event.stopPropagation();
              take();
            }}
          >
            load
          </button>
        )}
      </div>

      {entry.topic && !repeats && (
        /* The rule paints the topic itself rather than a mark beside it, so a scrolling log
           reads by colour without a column of marks down its edge. The title names the filter:
           with rules overlapping, which one won is what the colour leaves open. */
        <div
          className={styles.topic}
          data-testid="topic"
          style={rule ? { color: rule.colour } : undefined}
          title={rule ? `Coloured by ${rule.filter}` : undefined}
        >
          <Topic topic={entry.topic} />
        </div>
      )}

      {entry.body && (
        <div
          className={styles.body}
          data-testid="body"
          data-clipped={long && !whole ? '' : undefined}
        >
          {entry.body}
        </div>
      )}

      {/* Only on the rows that need it, and never in the way of the ones that do not. The stop
          is doing real work: the whole row loads itself into the publish form, and asking to
          read a payload is not asking to send it. */}
      {long && (
        <button
          type="button"
          className={styles.more}
          aria-expanded={whole}
          aria-label={
            whole
              ? 'Show less of this payload'
              : `Show all ${entry.body!.length} characters of this payload`
          }
          onClick={(event) => {
            event.stopPropagation();
            setWhole((open) => !open);
          }}
        >
          {/* What is hidden is decided by a height, not by the character count that decided to
              clamp at all — so the only number that is true at every pane width is the whole. */}
          {whole ? 'show less' : `show all ${entry.body!.length} characters`}
        </button>
      )}
    </div>
  );
});

// Splits into segments so the '/' separators can be dimmed.
function Topic({ topic }: { topic: string }) {
  return (
    <>
      {topic.split('/').map((segment, index) => (
        <span key={index}>
          {index > 0 && (
            <span className={styles.sep} data-testid="sep">
              /
            </span>
          )}
          {segment}
        </span>
      ))}
    </>
  );
}

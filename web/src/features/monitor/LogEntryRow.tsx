import { memo, useState, type CSSProperties } from 'react';
import { Expand } from '../brand/icons';
import type { ColourRule } from '../../lib/topicColour';
import { useComposeStore } from '../../stores/composeStore';
import { stampMeaning, type LogEntry } from '../../stores/logStore';
import { useWindows } from './useWindows';
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
  // Read off the store here rather than taken as a prop: this row is memoised so that an arrival
  // re-renders one of them, and a handler built by the pane would be a new function on every
  // arrival and would re-render all of them.
  const openWindow = useWindows((state) => state.open);
  const [whole, setWhole] = useState(false);

  // A body is long when it has more characters than the clamp shows OR more lines than it has
  // room for. The clamp is a height and the threshold is a character count, so on their own they
  // disagree in both directions: a pretty-printed three-hundred-character object is fifteen lines
  // and was cut with nothing offering to open it.
  const long = !!entry.body && (entry.body.length > SHOW || lines(entry.body) > CLAMP_LINES);

  // What a window opened on this row is called. The topic on its own would give two arrivals a
  // second the same name, and the time is what a reader comparing two of them is reading.
  const at = entry.at.toLocaleTimeString('en-GB', { hour12: false });
  const name = entry.topic ? `${at} ${entry.topic}` : at;

  // Only an arrival can be sent back. A command entry carries the filter it was aimed at, which
  // may be a wildcard, and an outcome rather than a payload — neither is publishable. The whole
  // row is the target rather than a small icon, since re-sending what just arrived is the
  // common move in a fake console.
  const reload =
    entry.topic && entry.kind === 'recv'
      ? () =>
          // The whole message: where, what, and how it was sent.
          //
          // The two flags are worth carrying again. They were facts about the delivery rather
          // than about the publish — a subscription caps the QoS of every copy under it and a
          // broker clears the retain bit on a live forward — but this console now listens at the
          // ceiling and asks for retain as published, so what a row shows is what the publisher
          // chose. Sending it again means sending it as it was sent.
          load({
            topic: entry.topic!,
            payload: entry.body,
            mode: entry.mode,
            qos: entry.qos,
            retain: entry.retain,
          })
      : undefined;

  const take = () => {
    reload?.();
    if (entry.topic) onLoaded?.(entry.topic);
  };

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
        <span>{entry.at.toLocaleTimeString('en-GB', { hour12: false })}</span>
        {entry.verb && (
          <span className={styles.verb} data-testid="verb">
            {entry.verb}
          </span>
        )}
        {entry.stamps && (
          <span className={styles.stamps}>
            {entry.stamps.map((stamp) => (
              <span
                key={stamp}
                className={styles.stamp}
                data-stamp={stamp}
                // Two of these are facts about the delivery and are read as verdicts on the
                // publish that caused it. The words are the chip's; the meaning is the store's.
                title={stampMeaning(stamp)}
              >
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
          /* The message's own colour, where the rule carries one. Most rules do not: painting the
             topic is what tells a run of arrivals apart, and a wall of payloads in eight hues is
             a log nobody can read. The rules that do are the ones watching one device among
             forty, where the payload is the thing being read and the topic is furniture.

             Only on an arrival, which today is all this pane holds — the store's per-topic run
             drops everything else. Belt and braces, and cheap: a fault's body is drawn in the
             fault colour, and a colour rule painting over that would turn 'this went wrong' into
             'this is the plant topic'. */
          style={
            entry.kind === 'recv' && rule?.bodyColour ? { color: rule.bodyColour } : undefined
          }
          // Twice, on the payload, opens it in a window. Counted rather than listened for with
          // onDoubleClick: the first click of the pair still reaches the row, and the row's own
          // guard above already declines anything inside the body — so the two gestures do not
          // have to be told apart afterwards, they never met.
          //
          // The selection is dropped because a double-click takes a word with it, and a word
          // highlighted under a window that has just opened over it is a highlight nobody asked
          // for and cannot see the end of.
          onClick={(event) => {
            if (event.detail === 0 || event.detail % 2 !== 0) return;
            window.getSelection()?.removeAllRanges();
            openWindow({ kind: 'message', entry }, name);
          }}
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

      {/* The same thing the double-click does, for a hand that has not learnt the gesture and for
          a keyboard that cannot make it. In the row's own corner rather than on the head line:
          measured, a control in the head lands beside the stamps and takes four and a half pixels
          off every row in the pane — this one is out of the flow and costs nothing.

          Only where there is a message to open. A row with no payload at all — a retained clear —
          has no body to double-click either, so on that row this is the only way in. */}
      {reload && (
        <button
          type="button"
          className={styles.open}
          data-testid="open"
          aria-label={`Open the message on ${entry.topic} in a window`}
          title="Open in a window"
          onClick={(event) => {
            event.stopPropagation();
            openWindow({ kind: 'message', entry }, name);
          }}
        >
          <Expand />
        </button>
      )}
    </div>
  );
});

// Splits into segments so the '/' separators can be dimmed.
export function Topic({ topic }: { topic: string }) {
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

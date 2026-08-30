import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Copy, Fold, Unfold } from '../brand/icons';
import { copyText } from '../../lib/copyText';
import { checkJson, formatJson } from '../../lib/payload';
import { useRuleLookup } from '../../lib/useRuleLookup';
import type { LogEntry } from '../../stores/logStore';
import { branches, JsonTree, MOST_ROWS, rowCount, topOf, type Json, type Top } from './JsonTree';
import { Topic } from './LogEntryRow';
import styles from './MessageDetail.module.css';

/**
 * One arrival, opened out: what it is, and the whole of what it carried.
 *
 * The row it came from is a line in a run and shows what a line can — a time, a topic, four lines
 * of payload. This is the same message with the room to answer the questions the row cannot: how
 * many bytes was that actually, was it retained, what is the fortieth line of it.
 *
 * The message is frozen. The window keeps the entry it was opened on, so the log behind it may
 * evict it, the selection may move, the broker may drop — and this goes on saying what arrived.
 */
export function MessageDetail({ entry }: { entry: LogEntry }) {
  const ruleOf = useRuleLookup();
  const rule = entry.topic ? ruleOf(entry.topic) : null;
  const rest = unsaid(entry);

  return (
    // One wrapper. The window's body is a grid of a single row, so two children here would put
    // the summary in a track of no height and lose it under the payload.
    <div className={styles.detail}>
      {/* One line for what this message is: the word 'topic', the topic itself at reading size,
          and the moment it landed held against the far end.

          The word stays. A path is not always obviously a path — 'front', 'meter', a single
          segment with no slash in it at all — and the first line of a window has to be readable
          without the run behind it to compare against. The date needs no word of its own: nothing
          else on this screen looks like a timestamp.

          Held apart rather than stacked, because they answer two different questions and a reader
          opening a window an hour after the fact is asking the second one. They wrap together
          when the window is too narrow to hold both, and the date keeps the right edge either
          way.

          The topic carries its rule's colour, the same as the row it was opened from. The window
          used to be drawn in the console's plain ink while the row behind it was green, and the
          two never read as one message. */}
      <div className={styles.head} data-testid="summary">
        <div className={styles.line}>
          {entry.topic && <span className={styles.label}>topic</span>}
          {entry.topic && (
            <div className={styles.topic} data-copy style={rule ? { color: rule.colour } : undefined}>
              <Topic topic={entry.topic} />
            </div>
          )}

          {/* data-copy on both, because this console selects nothing by default and the exceptions
              are listed one at a time — these were a dt/dd pair, which was on that list. A topic is
              the most-copied string on the screen, and a window it could not be taken out of would
              be a window that had quietly stopped being useful. */}
          <time className={styles.at} dateTime={entry.at.toISOString()} data-copy>
            {when(entry.at)}
          </time>
        </div>

        {(rest.length > 0 || rule) && (
          <p className={styles.unsaid}>
            {rest.length > 0 && <span>{rest.join(' \u00b7 ')}</span>}

            {/* The rule, named and painted, where the row can only carry it as a hover. No word
                in front of it: it is drawn in the colour the topic two lines up is drawn in,
                which is the whole of the answer, and a console that labels its own colours is a
                console explaining itself. */}
            {rule && (
              <span style={{ color: rule.colour }} title={`Coloured by ${rule.filter}`}>
                {rule.filter}
              </span>
            )}
          </p>
        )}
      </div>

      <Payload entry={entry} />
    </div>
  );
}

/**
 * How long a document has to be before it is worth a map of itself.
 *
 * Rows rather than keys, because rows are what runs off the bottom of the pane. Three keys and
 * eighteen lines are entirely on screen in any window worth opening one in, and a ruled strip
 * beside that is a map of a room you are standing in.
 */
const ENOUGH = 24;

/**
 * The whole payload, drawn as whatever it actually is.
 *
 * Four answers, and the reader can always get back to the fifth. A body that is not text at all
 * — hex — is shown as it arrived, because reformatting a byte dump is not a thing. A body that
 * does not begin with a brace or a bracket is shown as it arrived, because `JSON.parse` accepts a
 * bare number and calling `21.5` a JSON document helps nobody. What is left is meant to be JSON:
 * drawn as a foldable document if it parses, with one control back to the exact characters that
 * arrived — and if it does not parse, shown raw with the reason it did not, which is the same
 * sentence the publish form gives about a draft.
 *
 * The controls stand over it rather than under it. There are four of them now where there was
 * one, and a row of controls below a payload of forty thousand characters is a row of controls
 * nobody will ever scroll to.
 */
function Payload({ entry }: { entry: LogEntry }) {
  const [raw, setRaw] = useState(false);
  /** The branch the index has been asked to go to, until the row for it has been found. */
  const [going, setGoing] = useState<string | null>(null);
  const pane = useRef<HTMLDivElement>(null);
  /**
   * The branches folded away, by path. Empty is the document open, which is what it opens as:
   * this drew the whole of it before, and a window that suddenly showed one line where it used to
   * show the message would be a window that had lost it.
   */
  const [shut, setShut] = useState<ReadonlySet<string>>(new Set());
  const [copied, setCopied] = useState<'no' | 'yes' | 'failed'>('no');

  const read = useMemo(() => {
    const body = entry.body ?? '';
    if (!body) return null;

    const plain = { text: body, why: null, tree: null, other: false };
    if (entry.mode === 'hex') return plain;

    const first = body.trimStart()[0];
    if (first !== '{' && first !== '[') return plain;

    const why = checkJson(body);
    if (why !== null) return { text: body, why, tree: null, other: false };

    // Past the cap the document is still laid out, just not foldable — see MOST_ROWS. Which is
    // exactly what this window did before folding existed, so nothing is lost but the chevrons.
    const value = JSON.parse(body) as Json;
    const tree = rowCount(value) > MOST_ROWS ? null : value;

    return { text: formatJson(body), why: null, tree, other: true };
  }, [entry.body, entry.mode]);

  /**
   * The top of the document, and whether it is worth a column of its own.
   *
   * Only where the document is long enough that its own top cannot be seen at once. A message of
   * three keys and eighteen lines is entirely on screen in any window worth opening one in, and a
   * ruled strip beside it would be a map of a room you are standing in. The number is rows rather
   * than keys because rows are what runs off the bottom.
   *
   * Memoised on the parsed document, not on the render: this component's state churns — every
   * fold, every raw toggle, and twice on every press of the copy mark while it says 'Copied'.
   */
  const index = useMemo<Top[]>(
    () => (read?.tree && rowCount(read.tree) > ENOUGH ? topOf(read.tree) : []),
    [read?.tree],
  );

  // Says it copied only when something was: the desktop shell and the QR panel both run over
  // plain http, where there is no clipboard API at all and the old way is what answers.
  const copy = async () => setCopied((await copyText(entry.body ?? '')) ? 'yes' : 'failed');

  /**
   * Go to a branch: open the way to it, then bring it to the top of the pane.
   *
   * Two steps rather than one, because the row may not exist yet. A branch the reader folded — or
   * that 'fold every branch' folded, which takes the whole document down to one line — has no row
   * to scroll to, so the fold is lifted first and the scroll waits for the render that draws it.
   * The root is lifted with it: folded, there is nowhere to land at all.
   *
   * Only the branch asked for. The rest of the reader's folds are theirs, and an index that tidied
   * them away every time it was used would be a control that undoes the reader's own work.
   */
  const goTo = (path: string) => {
    setShut((closed) => {
      const next = new Set(closed);
      next.delete('');
      next.delete(path);

      return next;
    });
    setGoing(path);
  };

  useEffect(() => {
    if (going === null) return;

    const box = pane.current;
    // By arithmetic against the pane's own top rather than scrollIntoView, which walks every
    // scroll ancestor it can find: measured, it took the window's whole body with it and carried
    // the index off the top of the screen — the reader pressed a thing and the thing left.
    const row = [...(box?.querySelectorAll('[data-path]') ?? [])].find(
      (one) => (one as HTMLElement).dataset.path === going,
    );
    if (box && row) box.scrollTop += row.getBoundingClientRect().top - box.getBoundingClientRect().top;

    setGoing(null);
  }, [going]);

  // Back to itself, so the mark is a report on the press rather than a state the button is in.
  useEffect(() => {
    if (copied === 'no') return;

    const held = setTimeout(() => setCopied('no'), 1600);

    return () => clearTimeout(held);
  }, [copied]);

  if (!read) return null;

  const folding = read.tree !== null && !raw;
  const listed = folding && index.length > 0;

  return (
    <>
      {read.why && <p className={styles.fault}>{read.why}</p>}

      <div className={styles.controls}>
        {/* Marks rather than the two words they were. 'expand all' and 'collapse all' come to
            twenty-two characters standing over a document, which reads as a caption on it rather
            than as a pair of controls beside it — and the two are a strict pair, so a pair of
            marks says what they are to each other in a way two phrases cannot. */}
        {folding && (
          <>
            <button
              type="button"
              className={styles.mark}
              aria-label="Open every branch"
              title="Open every branch"
              onClick={() => setShut(new Set())}
            >
              <Unfold />
            </button>
            <button
              type="button"
              className={styles.mark}
              aria-label="Fold every branch"
              title="Fold every branch"
              onClick={() => setShut(new Set(branches(read.tree!)))}
            >
              <Fold />
            </button>
          </>
        )}

        {read.other && (
          <button
            type="button"
            className={styles.toggle}
            aria-pressed={!raw}
            title={raw ? (read.tree ? 'Show it as a document' : 'Show it formatted') : 'Show exactly what arrived'}
            onClick={() => setRaw(!raw)}
          >
            json
          </button>
        )}

        {/* The far corner, and a mark rather than a word: it is the one control here a reader
            reaches for without reading, and 'copy' spelled out beside three other lowercase
            words would be the fourth of a kind rather than the thing in the corner.

            It hands over exactly what arrived, never what is on screen. A folded branch on screen
            is a summary, and a summary pasted into a bug report is a message that never existed. */}
        <button
          type="button"
          className={styles.copy}
          data-testid="copy"
          aria-label={{ no: 'Copy the message', yes: 'Copied', failed: 'Copy failed' }[copied]}
          title={{ no: 'Copy the message', yes: 'Copied', failed: 'Copy failed' }[copied]}
          onClick={copy}
        >
          {copied === 'yes' ? <Check /> : <Copy />}
        </button>
      </div>

      {/* The index is a sibling of the payload and never a child of it, which is not a tidiness
          preference: Ctrl+A takes the contents of the first [data-message] in the window, and the
          copy mark hands over the bytes that arrived. A column of key names inside that box would
          be pasted into a bug report as part of the message. Divs rather than a list, for the
          other half of the same reason — this console makes p, li, dt and dd selectable by name,
          so an index built out of them could be swept into a drag. */}
      <div className={styles.document} data-index={listed ? '' : undefined}>
        {listed && <Index top={index} onGo={goTo} />}

        {/* A div rather than a p: a double-click inside a paragraph is claimed by the console's
            own prose selection, and this is a payload somebody may well want to take a word out
            of.

            data-message is what Ctrl+A reaches for. The window catches the key and selects this,
            rather than letting the browser select the console behind it. */}
        <div
          ref={pane}
          className={styles.payload}
          data-mode={folding ? 'tree' : 'text'}
          data-testid="window-body"
          data-message
          data-copy
        >
          {folding ? (
            <JsonTree
              value={read.tree!}
              shut={shut}
              onFold={(path) =>
                setShut((closed) => {
                  const next = new Set(closed);
                  if (!next.delete(path)) next.add(path);

                  return next;
                })
              }
            />
          ) : raw ? (
            entry.body
          ) : (
            read.text
          )}
        </div>
      </div>
    </>
  );
}

/**
 * What is in the message, down the left of it.
 *
 * Each entry says what is inside before it is folded, which is the one thing `{ … 7 }` will not
 * say until it is too late to be useful.
 *
 * Named for where it goes rather than for what it is. The line it points at already carries a
 * control called 'Fold radios', and two buttons of one name in a window is a window nobody can be
 * given directions in.
 */
function Index({ top, onGo }: { top: readonly Top[]; onGo: (path: string) => void }) {
  return (
    <div className={styles.index} data-testid="index" role="group" aria-label="What is in the message">
      {top.map((key) => {
        const said = key.count === null ? `Go to ${key.name}` : `Go to ${key.name}, ${key.count} inside`;
        const held = key.count === null ? '' : key.array ? ` [${key.count}]` : ` {${key.count}}`;

        return (
          <button
            key={key.path}
            type="button"
            className={styles.entry}
            aria-label={said}
            title={said}
            onClick={() => onGo(key.path)}
          >
            {key.name}
            {held}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The moment it landed, to the millisecond.
 *
 * The row shows a time and no date, which is right for a line in a run that arrived while you
 * were watching. A message opened an hour later is a different question, so this answers it in
 * full — and the milliseconds are the part a reader comparing two arrivals actually needs.
 */
const when = (at: Date) =>
  `${at.toLocaleString('en-GB', { hour12: false })}.${String(at.getMilliseconds()).padStart(3, '0')}`;

/**
 * What the chips in the bar cannot say.
 *
 * The bar wears the log's own stamps, and those are drawn to be glanced at in a scrolling run.
 * The weight is one of them, and what a message weighed is not a second question owed a second
 * answer: it is said once, in the chip, and saying it again underneath in more words was the old
 * table refusing to be deleted.
 *
 * What the chip cannot say is a hex body's arithmetic — which is not the weight but the reason
 * the weight and the screen disagree — and whether a message was retained, which is a state
 * rather than a measurement and is drawn beside this as a chip of its own.
 *
 * Said only where it is actually missing upstairs, which is what keeps this from being a table:
 * an ordinary retained reading returns nothing at all and draws no line, because the chips have
 * already said the whole of it.
 */
function unsaid(entry: LogEntry): string[] {
  const said: string[] = [];

  // A hex body is two characters and a space for every byte, so a reader looking at 3071
  // characters of dump beside a chip stamped '1.0kb' is owed the arithmetic rather than left to
  // do it. This is still the only place in the console that reconciles the two.
  if (entry.mode === 'hex') said.push(`${entry.body?.length ?? 0} characters of hex`);

  return said;
}

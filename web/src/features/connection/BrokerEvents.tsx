import { useMemo, useState } from 'react';
import { SearchBox, SearchOpener } from '../../components/SearchBox';
import { carries } from '../../lib/sift';
import { copyText } from '../../lib/copyText';
import { useBrokerEventsStore, type BrokerEvent } from '../../stores/brokerEventsStore';
import { Check, Copy, Glyph } from '../brand/icons';
import styles from '../../styles/panel.module.css';

/** How many of the newest are drawn. The store keeps more; the column is not a place to scroll. */
export const EVENTS_SHOWN = 40;

/**
 * What has happened to the link, newest first, beside the form that makes one.
 *
 * The log's command lines say most of this and are cleared with every connection; this list is
 * not. It is the answer to 'what has this broker been doing' — connected, dropped, tried, tried
 * again, back — read down one column while the form beside it waits.
 *
 * The three controls on its head are the three things a reader does with a record: find a line
 * in it, take it somewhere else, and start again. Copy takes what is on screen rather than
 * everything held, so a search narrows what is copied — which is how a reader gets the six lines
 * about one outage out of an afternoon of them and into a message to somebody.
 */
export function BrokerEvents({
  titled = true,
  docked = false,
  expanded: held,
  onExpanded,
}: {
  titled?: boolean;
  docked?: boolean;
  /** Whether the docked bar is open, where the page it stands on keeps that; see `expanded`. */
  expanded?: boolean;
  onExpanded?: (open: boolean) => void;
}) {
  const events = useBrokerEventsStore((state) => state.events);
  const clear = useBrokerEventsStore((state) => state.clear);
  const [look, setLook] = useState('');
  const [open, setOpen] = useState(false);
  // Docked, the record is a bar at the foot of the page and shut until it is pressed: one line
  // that says how much there is and what happened last, which is most of what a glance wants.
  //
  // Shut every time the page is opened, and kept by the page while it is. The panel draws a
  // different page with and without a link and the bar is built again with each: opened to watch
  // a dial, it must not shut itself the moment the link comes up, which is the moment the reader
  // was watching for — so the page holds the answer and hands it down. It used to be held here,
  // past the component, which survived the link coming up and also survived the panel being
  // closed: a record opened once was open on every visit after it, over a list nobody had asked
  // to see again.
  const [own, setOwn] = useState(false);
  const expanded = held ?? own;
  const setExpanded = (next: (was: boolean) => boolean) => {
    const open = next(expanded);
    setOwn(open);
    onExpanded?.(open);
  };
  const shut = docked && !expanded;
  const [copied, setCopied] = useState<'no' | 'yes' | 'failed'>('no');

  const found = useMemo(
    () => events.filter((event) => carries(event.what, look) || carries(event.detail, look)),
    [events, look],
  );
  const shown = found.slice(0, EVENTS_SHOWN);

  const copy = async () => {
    setCopied((await copyText(shown.map(asLine).join('\n'))) ? 'yes' : 'failed');
    window.setTimeout(() => setCopied('no'), 2000);
  };

  const body =
    events.length === 0 ? (
        // In the voice the other empty panes use — 'No traffic on X yet.' — rather than 'Nothing
        // has happened yet', which read as the console making conversation. What this card holds
        // is a record, and an empty record says it has nothing in it.
        <p className={styles.eventsEmpty}>No events recorded yet.</p>
      ) : found.length === 0 ? (
        // A search that matches nothing is not the same as a record with nothing in it, and a
        // reader who has just typed needs to be told which of the two they are looking at.
        <p className={styles.eventsEmpty}>No event says “{look}”.</p>
      ) : (
        <ol className={styles.eventList}>
          {shown.map((event) => (
            <li key={event.id} className={styles.event} data-kind={event.kind}>
              <span className={styles.eventAt}>{at(event)}</span>
              <div className={styles.eventBody}>
                <p className={styles.eventWhat}>{event.what}</p>
                {event.detail && <p className={styles.eventDetail}>{event.detail}</p>}
              </div>
            </li>
          ))}
        </ol>
      );

  return (
    <section className={styles.events} aria-label="Broker events">
      <div className={styles.eventsHead}>
        {/* The count is on the title because the title is the thing it counts. Under a search it
            says both numbers: a reader who has typed something wants to know how much of the
            record they are looking at, and the total is what tells them. */}
        {/* The head is the list's own two columns, said once at the top: the word over the
            clock, the count over the lines it counts. Just the word, too — the card stands
            inside the Broker panel, under a page that says BROKER across the top of itself, and
            'Broker events' said the panel's name again to make a heading two words out of one. */}
        {/* An open search takes the title's place rather than a line under it: the row is one
            line at every width, and the box is what the reader is looking at while it is open.
            The heading stays in the document, so the region keeps its name and its count. */}
        <h3 className={(open && !docked) || !titled ? 'srOnly' : styles.eventsTitle}>
          {docked ? (
            <button
              type="button"
              className={styles.eventsToggle}
              aria-expanded={expanded}
              aria-controls="brokerEventsBody"
              onClick={() => setExpanded((was) => !was)}
            >
              <Glyph>
                <path d="M8 14 12 10 16 14" />
              </Glyph>
              <span className={styles.eventsName}>Events</span>{' '}
              <span className={styles.eventsCount}>
                ({look === '' ? events.length : `${found.length} of ${events.length}`})
              </span>
            </button>
          ) : (
            <>
              <span className={styles.eventsName}>Events</span>{' '}
              <span className={styles.eventsCount}>
                ({look === '' ? events.length : `${found.length} of ${events.length}`})
              </span>
            </>
          )}
        </h3>

        {/* Shut, the bar says the newest line where the tools would be: the one thing a reader
            glancing down at it wants to know, without opening it to find out. */}
        {shut && events.length > 0 && (
          <p className={styles.eventsLatest} data-kind={events[0].kind}>
            <span className={styles.eventAt}>{at(events[0])}</span> {events[0].what}
          </p>
        )}

        {!shut && (
        <div className={styles.eventsTools}>
          {open && (
            <SearchBox label="Search broker events" value={look} onChange={setLook} focused />
          )}
          <SearchOpener
            label="Find in the record"
            open={open}
            onToggle={() => {
              if (open) setLook('');
              setOpen((shown) => !shown);
            }}
          />

          {/* The mark alone. It said 'Copy' beside it, and in a card whose head already carries a
              title, a count, a search and a way to empty it, the word was the widest thing on the
              row for the least it said. What it has to say when it has something to say — that
              this browser would not let it — it says in its own name, and out loud. */}
          <button
            type="button"
            className={styles.eventsAction}
            aria-label={
              copied === 'no'
                ? 'Copy the broker events shown'
                : copied === 'yes'
                  ? 'Copied'
                  : 'Copy refused — press ⌘C'
            }
            title={copied === 'failed' ? 'This browser refused — press ⌘C' : 'Copy what is shown'}
            data-said={copied === 'no' ? undefined : copied}
            onClick={copy}
            disabled={shown.length === 0}
          >
            {copied === 'yes' ? <Check /> : <Copy />}
          </button>

          <button
            type="button"
            className={styles.eventsAction}
            aria-label="Clear the broker events"
            title="Clear the record"
            onClick={() => {
              clear();
              setLook('');
            }}
            disabled={events.length === 0}
          >
            Clear
          </button>
        </div>
        )}
      </div>

      {/* Always in the page when docked, so the handle's aria-controls names something that is
          there; shut, it is hidden rather than gone. */}
      {docked ? (
        <div id="brokerEventsBody" className={styles.eventsBody} hidden={shut}>
          {!shut && body}
        </div>
      ) : (
        body
      )}
    </section>
  );
}

const at = (event: BrokerEvent) => event.at.toLocaleTimeString('en-GB', { hour12: false });

/** One event as a line of text, for the clipboard: the same three parts the row draws. */
const asLine = (event: BrokerEvent) =>
  `${at(event)}  ${event.what}${event.detail ? ` — ${event.detail}` : ''}`;

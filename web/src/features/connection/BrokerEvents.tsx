import { useBrokerEventsStore } from '../../stores/brokerEventsStore';
import styles from '../../styles/panel.module.css';

/** How many of the newest are drawn. The store keeps more; the column is not a place to scroll. */
export const EVENTS_SHOWN = 40;

/**
 * What has happened to the link, newest first, beside the form that makes one.
 *
 * The log's command lines say most of this and are cleared with every connection; this list is
 * not. It is the answer to 'what has this broker been doing' — connected, dropped, tried, tried
 * again, back — read down one column while the form beside it waits.
 */
export function BrokerEvents() {
  const events = useBrokerEventsStore((state) => state.events);

  return (
    <section className={styles.events} aria-label="Broker events">
      <h3 className={styles.eventsTitle}>Broker events</h3>
      {events.length === 0 ? (
        <p className={styles.eventsEmpty}>Nothing has happened yet.</p>
      ) : (
        <ol className={styles.eventList}>
          {events.slice(0, EVENTS_SHOWN).map((event) => (
            <li key={event.id} className={styles.event} data-kind={event.kind}>
              <span className={styles.eventAt}>
                {event.at.toLocaleTimeString('en-GB', { hour12: false })}
              </span>
              <div className={styles.eventBody}>
                <p className={styles.eventWhat}>{event.what}</p>
                {event.detail && <p className={styles.eventDetail}>{event.detail}</p>}
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

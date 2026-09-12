import { useConnectionState } from '../../api/useConnectionState';
import { toneOf, useLinkState, type LinkState } from './linkState';
import styles from './LinkChip.module.css';

/**
 * Whether the broker is up, in one word, at the top of both faces of the broker panel.
 *
 * The panel had two faces and only one of them answered its own question. Over a live link it
 * said CONNECTED in bare green capitals with a dot beside them; over no link it was four hundred
 * lines of form that stated the connection nowhere at all — so a console opened cold, or opened
 * after a broker had gone, told the reader nothing about the one thing a console is for. The
 * same chip stands on both faces, which is what stops the two of them saying it differently.
 *
 * It derives nothing. `useLinkState` and `toneOf` are what the rail's Broker row reads, and two
 * derivations of one link would be two readouts free to disagree about it — which is the bug the
 * single rail lamp was written to end.
 *
 * It does not move, either, where the rail breathes and pulses. The rail is a lamp at the edge of
 * the room and has to catch an eye that is somewhere else; this is the answer on the page
 * somebody opened to ask, and a thing that moves while it is being read is a thing being read
 * over.
 *
 * No live region. The state is announced already — it is in the Broker row's own accessible name
 * — and `ReconnectNotice` is politely live for the states that change under a reader who is not
 * touching anything. A third voice here would say one fact a third time, at the pace of a poll.
 */

/**
 * The word for each state, and there are six distinct ones on purpose: colour is never the only
 * signal in this console, and six words that differ is a stronger answer to that than a glyph,
 * because a word survives being read rather than recognised.
 *
 * They are the rail's own vocabulary — LINK_SAID in App.tsx says 'connected', 'connecting',
 * 'connection faulted' — so a reader who hears the row and then looks at the panel meets one set
 * of words. Two of them are not the rail's, and both times it is because the chip stands alone
 * where the row stands in a rail:
 *
 * - 'Faulted' rather than the row's 'connection faulted'. The row is named 'Broker, connection
 *   faulted' and needs the noun; a chip under a panel headed BROKER does not.
 * - 'Console offline' rather than the row's 'reconnecting'. The row already says 'reconnecting to
 *   the broker' for the other outage, so on the rail the short word is unambiguous by contrast.
 *   Standing on its own the same word would name the wrong subject: this state is the console
 *   losing its own server, not the broker going anywhere. Not 'No server' either — MQTT's own
 *   vocabulary calls the broker the Server, which is the one reading that would be wrong.
 */
const SAID: Record<LinkState, string> = {
  Connected: 'Connected',
  Waiting: 'Connecting',
  Retrying: 'Reconnecting',
  Faulted: 'Faulted',
  Reconnecting: 'Console offline',
  Disconnected: 'Disconnected',
};

export function LinkChip() {
  const state = useLinkState();
  const { answered } = useConnectionState();

  /*
   * Nothing at all until the API has said something. `useConnectionState` stands Disconnected in
   * until the first answer arrives, and a chip drawn on that guess states as a fact the one
   * thing it cannot yet know — on a page reloaded over a live link, the form face renders first
   * and would flash DISCONNECTED at a reader whose broker never went anywhere. `answered` exists
   * for exactly this and the panel already gates on it twice.
   *
   * The hub is the exception this cannot see: a console that opens with its own server already
   * unreachable has an honest answer before the connection query has one. It is a beat, the
   * reconnect notice is under it saying so, and a chip that tried to special-case its way into
   * that beat would be guessing again.
   */
  if (!answered) return null;

  return (
    <p className={styles.chip} data-tone={toneOf(state)}>
      {/* The same disc the green line carried, and filled on the one state that earns it: a lamp
          that is on says 'this is so', and the whole of every other state is that there is no
          link. Sized in em so it grows with a reader who turns the base size up. */}
      <span className={styles.lamp} data-lit={state === 'Connected' ? '' : undefined} aria-hidden="true" />
      {SAID[state]}
    </p>
  );
}

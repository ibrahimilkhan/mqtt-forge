import { useQuery } from '@tanstack/react-query';
import { formatEndpoint } from './address';
import type { ReactNode } from 'react';
import { queryKeys } from '../../api/queryKeys';
import { getSavedSettings } from '../../api/connection';
import { getSubscriptions } from '../../api/subscriptions';
import { useConnectionState } from '../../api/useConnectionState';
import { useHubStatusStore } from '../../stores/hubStatusStore';
import styles from '../../styles/panel.module.css';
import type { BrokerLink } from '../../types/api';
import { ConnectedFor } from './ConnectedFor';
import { LinkChip } from './LinkChip';
import { schemeOf, versionName } from './scheme';

// Stands for a field the broker was asked about and said nothing to. The row stays either way,
// so the block keeps its shape from broker to broker and a gap reads as a gap.
const NOTHING = '—';

/**
 * What is up right now.
 *
 * It is the whole of the broker panel over a live link — the form is not there to be set apart
 * from any more — so `lead` says "you are the first thing on this panel" and takes off the rule it
 * would otherwise draw above itself. Without one it still stands under something, which is the
 * case the rule was written for.
 *
 * Keyed on the link rather than on Connected: a state with no link is one we would rather show
 * nothing for than guess about.
 */
export function ConnectionSummary({ lead = false }: { lead?: boolean } = {}) {
  const { link } = useConnectionState();
  /**
   * Whether this console can currently reach its own server.
   *
   * Nothing else on this panel can tell. The link's state arrives over the hub and is then held
   * in the query cache, so a hub that has gone leaves the last answer standing — and the last
   * answer is 'Connected', in green, over a stopwatch that goes on counting. The server can be
   * shut down and the panel will say the broker is up for as long as the tab is left open.
   *
   * The rail knows: it colours itself amber and reads 'reconnecting' the moment the socket goes.
   * But the rail is a lamp at the edge of the window, and this panel is what somebody opened to
   * ask the question. It has to answer with the same word.
   */
  const lost = useHubStatusStore((state) => state.status) === 'reconnecting';
  // What was asked for, as against what the link agreed to. Only one row reads it, and only to
  // say that one of the things asked for could not be carried.
  const { data: saved } = useQuery({
    queryKey: queryKeys.savedSettings,
    queryFn: getSavedSettings,
    enabled: Boolean(link),
  });

  const { data: filters } = useQuery({
    queryKey: queryKeys.subscriptions,
    queryFn: getSubscriptions,
    enabled: Boolean(link),
  });

  if (!link) return null;

  /**
   * The one thing a list of facts cannot say: that there IS a link.
   *
   * Only in `lead`, which is the panel over a live connection — and it was the one face of that
   * panel with no statement of state on it at all: nine rows of true facts and nothing telling
   * the reader what they added up to. The rail's lamp is green, but the rail is not where
   * somebody who opened this panel is looking.
   *
   * The chip is the panel's, not this block's — the form face stands the same one above the
   * address box — so what it says here about a console that has lost its own server is said in
   * the same words there.
   *
   * The address comes with it, and leaves the list below — a block that led with the broker and
   * then repeated it two lines later would read as two different brokers to anyone scanning.
   */
  const head = lead && (
    <div className={styles.linkHead}>
      <LinkChip />
      <p className={styles.linkWhere}>{formatEndpoint(link.host, link.port)}</p>
      {/* Said in the head rather than beside the rows it makes doubtful, because it is doubtful
          about all of them: the keep-alive, the session, the count of filters and the stopwatch
          are each the last thing this console was told. */}
      {lost && (
        <p className={styles.linkStale} data-testid="link-stale">
          This console has lost its own server and is trying to get it back. Everything here is
          the last thing it heard.
        </p>
      )}
    </div>
  );

  return (
    <>
      {head}
      <dl
        className={styles.summary}
        data-lead={lead ? '' : undefined}
        aria-label="Connection details"
      >
        {!lead && <Row label="Broker" value={formatEndpoint(link.host, link.port)} />}
        {/* How, and in what. Both are answers rather than settings: with the version left on Auto
            the form holds a request and this holds what the broker agreed to, which is the only
            place that difference is visible. The scheme says the transport and the encryption in
            one word, which is how they were picked. */}
        <Row label="Protocol" value={`${schemeOf(link.transport, link.useTls)}://`} />
        <Row label="Speaking" value={versionName(link.protocolVersion)} />
        <Row label="Client ID" value={link.clientId} />
        {/* Only where there is one. A broker assigns an ID when the client sends none, and this
            console always sends one — so the row was a dash on every connection anyone has ever
            made here, which is a row that says nothing at the price of a line. */}
        {link.assignedClientId && <Row label="Assigned ID" value={link.assignedClientId} />}
        <Row label="Username" value={link.username || 'none'} />
        {/* 'Connected' until the status head above started saying that word about the state. Two
            lines apart, one meant 'there is a link' and the other meant 'at 23:59:26', which is
            the same word doing two jobs on one block. 'Since' is what the value actually is. */}
        <Row label="Since" value={<ConnectedFor since={link.connectedAt} />} />
        <Row label="Session" value={link.sessionPresent ? 'resumed' : 'fresh'} />
        <Row label="Keep-alive" value={keepAlive(link)} />
        <Row label="Subscriptions" value={filters ? String(filters.length) : NOTHING} />
        {/* A setting that was asked for and could not be carried. Session expiry is an MQTT 5
            field; the validator refuses it against a version pinned to 3.1 or 3.1.1, but Auto is
            not pinned — it asks for 5.0 and steps down, and a broker that only speaks 3.1.1 leaves
            the number in the form with nowhere to go. Said here because this block is the one
            place the version that was actually agreed is on screen. */}
        {saved?.sessionExpiryInterval != null && link.protocolVersion !== 'v500' && (
          <Row
            label="Session expiry"
            value={`not sent — ${versionName(link.protocolVersion)} has no such field`}
          />
        )}
      </dl>
    </>
  );
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className={styles.summaryRow}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

// A truthiness check, not `??`: MQTT gives zero a meaning of its own, "the broker turned
// keep-alive off", so a zero is not a keep-alive of no seconds and reads no differently from
// the broker saying nothing. The API already folds the two together before this ever sees a
// link, but the check stays here as the reason a zero renders as a dash.
function keepAlive(link: BrokerLink): string {
  return link.serverKeepAlive ? `${link.serverKeepAlive} sec` : NOTHING;
}

import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { queryKeys } from '../../api/queryKeys';
import { getSubscriptions } from '../../api/subscriptions';
import { useConnectionState } from '../../api/useConnectionState';
import styles from '../../styles/panel.module.css';
import type { BrokerLink } from '../../types/api';
import { ConnectedFor } from './ConnectedFor';
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
   * panel with no statement of state on it at all. Every other face has the reconnect block
   * saying 'Reconnecting', 'Not reconnecting' or 'Reconnected' in words; this one had nine rows
   * of true facts and nothing telling the reader what they added up to. The rail's lamp is green,
   * but the rail is not where somebody who opened this panel is looking.
   *
   * The address comes with it, and leaves the list below — a block that led with the broker and
   * then repeated it two lines later would read as two different brokers to anyone scanning.
   */
  const head = lead && (
    <div className={styles.linkHead}>
      <p className={styles.linkState}>
        <span className={styles.lamp} aria-hidden="true" />
        Connected
      </p>
      <p className={styles.linkWhere}>{`${link.host}:${link.port}`}</p>
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
        {!lead && <Row label="Broker" value={`${link.host}:${link.port}`} />}
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

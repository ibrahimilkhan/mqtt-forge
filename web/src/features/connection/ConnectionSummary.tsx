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

// What is up right now, under the form that would replace it. Keyed on the link rather than on
// Connected: a state with no link is one we would rather show nothing for than guess about.
export function ConnectionSummary() {
  const { link } = useConnectionState();
  const { data: filters } = useQuery({
    queryKey: queryKeys.subscriptions,
    queryFn: getSubscriptions,
    enabled: Boolean(link),
  });

  if (!link) return null;

  return (
    <dl className={styles.summary} aria-label="Connection details">
      <Row label="Broker" value={`${link.host}:${link.port}`} />
      {/* How, and in what. Both are answers rather than settings: with the version left on Auto
          the form holds a request and this holds what the broker agreed to, which is the only
          place that difference is visible. The scheme says the transport and the encryption in
          one word, which is how they were picked. */}
      <Row label="Protocol" value={`${schemeOf(link.transport, link.useTls)}://`} />
      <Row label="Speaking" value={versionName(link.protocolVersion)} />
      <Row label="Client ID" value={link.clientId} />
      <Row label="Assigned ID" value={link.assignedClientId ?? NOTHING} />
      <Row label="Username" value={link.username || 'none'} />
      <Row label="Connected" value={<ConnectedFor since={link.connectedAt} />} />
      <Row label="Session" value={link.sessionPresent ? 'resumed' : 'fresh'} />
      <Row label="Keep-alive" value={keepAlive(link)} />
      <Row label="Subscriptions" value={filters ? String(filters.length) : NOTHING} />
    </dl>
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

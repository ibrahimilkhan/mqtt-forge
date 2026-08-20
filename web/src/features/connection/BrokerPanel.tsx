import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { getSavedSettings } from '../../api/connection';
import { queryKeys } from '../../api/queryKeys';
import { Field } from '../../components/Field';
import { PanelShell } from '../../components/PanelShell';
import styles from '../../styles/panel.module.css';
import { useConnectionState } from '../../api/useConnectionState';
import { fieldError } from '../../lib/problemDetails';
import { useGuardedMutate } from '../../lib/useGuardedMutate';
import { describeConnectFailure, describeFailureReason } from './connectFailure';
import { ConnectionSummary } from './ConnectionSummary';
import { useConnectionActions } from './useConnectionActions';

const DEFAULTS = {
  host: 'localhost',
  port: 1883,
  clientId: 'mqttforge-console',
  username: '',
  password: '',
  useTls: false,
};

export function BrokerPanel({ onClose }: { onClose: () => void }) {
  const [form, setForm] = useState(DEFAULTS);
  const [autoSubscribe, setAutoSubscribe] = useState(true);

  const { data: saved } = useQuery({ queryKey: queryKeys.savedSettings, queryFn: getSavedSettings });
  const { connectMutation, disconnectMutation, abortMutation } = useConnectionActions();
  const { isOnline, isConnecting, failure: faulted, answered } = useConnectionState();
  const guardedConnect = useGuardedMutate(connectMutation);
  const guardedDisconnect = useGuardedMutate(disconnectMutation);
  const guardedAbort = useGuardedMutate(abortMutation);

  // Two sources because they cover different gaps: isPending answers the instant this panel
  // fires, before the API has been asked anything; isConnecting is the only one a panel that
  // was closed when the attempt started — or reopened since — has to go on.
  const attemptRunning = isConnecting || connectMutation.isPending;

  // This panel exists to get a link up, so a link coming up is the end of its job: it stands
  // aside and hands its column back to the traffic it just started. The rail's lamp and the
  // address under it carry the state from here, and the menu button reopens it.
  //
  // Only on the change, and only after the API has answered once. Opened over a link that is
  // already up — to read the summary, or to disconnect — nothing has just happened, and a panel
  // that shut itself the moment it was asked for would be unusable.
  const wasOnline = useRef<boolean | null>(null);
  useEffect(() => {
    if (!answered) return;
    const before = wasOnline.current;
    wasOnline.current = isOnline;
    if (before === false && isOnline) onClose();
  }, [answered, isOnline, onClose]);

  // Arrives after first render; password is never returned by the API.
  useEffect(() => {
    if (!saved) return;
    setForm({
      host: saved.host,
      port: saved.port,
      clientId: saved.clientId,
      username: saved.username ?? '',
      password: '',
      useTls: saved.useTls,
    });
  }, [saved]);

  // Read off the attempt that failed, not the form, which the user may have edited since.
  // Once this panel is closed that attempt is gone, so the connection state carries its own
  // copy of both the reason and the broker it is about — which is also what a dropped link
  // reports. Never the saved settings: those only record a connect that worked.
  const attempted = connectMutation.variables?.request;
  const failure =
    (attempted && describeConnectFailure(connectMutation.error, attempted)) ??
    (faulted && describeFailureReason(faulted.reason, faulted));

  const submit = () =>
    guardedConnect({
      request: {
        host: form.host,
        port: Number(form.port),
        clientId: form.clientId,
        username: form.username || null,
        password: form.password || null,
        useTls: form.useTls,
      },
      autoSubscribe,
    });

  return (
    <PanelShell title="Broker" onClose={onClose}>
      <div className={styles.row}>
        <Field label="Host" htmlFor="host">
          <input
            id="host"
            type="text"
            value={form.host}
            onChange={(e) => setForm({ ...form, host: e.target.value })}
          />
          <FieldError error={connectMutation.error} field="Host" />
        </Field>
        <Field label="Port" htmlFor="port" narrow>
          <input
            id="port"
            type="number"
            value={form.port}
            onChange={(e) => setForm({ ...form, port: Number(e.target.value) })}
          />
          <FieldError error={connectMutation.error} field="Port" />
        </Field>
      </div>

      <div className={styles.row}>
        <Field label="Client ID" htmlFor="clientId">
          <input
            id="clientId"
            type="text"
            value={form.clientId}
            onChange={(e) => setForm({ ...form, clientId: e.target.value })}
          />
          <FieldError error={connectMutation.error} field="ClientId" />
        </Field>
      </div>

      <div className={styles.row}>
        <Field label="Username" htmlFor="username">
          <input
            id="username"
            type="text"
            placeholder="optional"
            value={form.username}
            onChange={(e) => setForm({ ...form, username: e.target.value })}
          />
        </Field>
        <Field label="Password" htmlFor="password">
          <input
            id="password"
            type="password"
            placeholder="optional"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
          />
        </Field>
      </div>

      <div className={styles.checks}>
        <label>
          <input
            type="checkbox"
            checked={form.useTls}
            onChange={(e) => setForm({ ...form, useTls: e.target.checked })}
          />
          {' Use TLS'}
        </label>
        <label>
          <input
            type="checkbox"
            checked={autoSubscribe}
            onChange={(e) => setAutoSubscribe(e.target.checked)}
          />
          {' Subscribe to every topic on connect'}
        </label>
      </div>

      <div className={styles.actions}>
        {attemptRunning ? (
          <button
            type="button"
            className={styles.steadyWidth}
            onClick={() => guardedAbort()}
            disabled={abortMutation.isPending}
          >
            Abort
          </button>
        ) : (
          // A live link is not something you connect over: the API would either report it
          // unchanged or tear the session down, so Disconnect is the only way forward.
          <button type="button" className={styles.steadyWidth} onClick={submit} disabled={isOnline}>
            Connect
          </button>
        )}
        <button
          type="button"
          className="ghost"
          onClick={() => guardedDisconnect()}
          disabled={!isOnline || disconnectMutation.isPending}
        >
          Disconnect
        </button>
      </div>

      {failure && (
        <p className={styles.fault} role="alert">
          {failure}
        </p>
      )}

      {saved?.hasPassword && (
        <p className={styles.note}>A password is saved but never sent back. Enter it again to connect.</p>
      )}

      <ConnectionSummary />
    </PanelShell>
  );
}

function FieldError({ error, field }: { error: unknown; field: string }) {
  const message = fieldError(error, field);
  return message ? <p className={styles.note}>{message}</p> : null;
}

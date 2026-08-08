import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { getSavedSettings } from '../../api/connection';
import { queryKeys } from '../../api/queryKeys';
import { Field } from '../../components/Field';
import { PanelShell } from '../../components/PanelShell';
import styles from '../../styles/panel.module.css';
import { useConnectionState } from '../../api/useConnectionState';
import { fieldError } from '../../lib/problemDetails';
import { useGuardedMutate } from '../../lib/useGuardedMutate';
import { describeConnectFailure, describeFailureReason } from './connectFailure';
import { useConnectionActions } from './useConnectionActions';

const DEFAULTS = {
  host: 'localhost',
  port: 1883,
  clientId: 'mqfaker-console',
  username: '',
  password: '',
  useTls: false,
};

export function BrokerPanel({ onClose }: { onClose: () => void }) {
  const [form, setForm] = useState(DEFAULTS);
  const [autoSubscribe, setAutoSubscribe] = useState(true);

  const { data: saved } = useQuery({ queryKey: queryKeys.savedSettings, queryFn: getSavedSettings });
  const { connectMutation, disconnectMutation } = useConnectionActions();
  const { isOnline, reason } = useConnectionState();
  const guardedConnect = useGuardedMutate(connectMutation);
  const guardedDisconnect = useGuardedMutate(disconnectMutation);

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
  // With no attempt in play the connection state still says why a live link died, and the
  // saved settings name the broker it died on.
  const attempted = connectMutation.variables?.request;
  const failure =
    (attempted && describeConnectFailure(connectMutation.error, attempted)) ??
    (saved && describeFailureReason(reason, saved));

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
        <button type="button" onClick={submit} disabled={connectMutation.isPending}>
          Connect
        </button>
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
    </PanelShell>
  );
}

function FieldError({ error, field }: { error: unknown; field: string }) {
  const message = fieldError(error, field);
  return message ? <p className={styles.note}>{message}</p> : null;
}

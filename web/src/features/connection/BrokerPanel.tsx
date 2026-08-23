import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { getSavedSettings } from '../../api/connection';
import { queryKeys } from '../../api/queryKeys';
import { Field } from '../../components/Field';
import { PanelShell } from '../../components/PanelShell';
import { Segmented } from '../../components/Segmented';
import styles from '../../styles/panel.module.css';
import { useConnectionState } from '../../api/useConnectionState';
import { fieldError } from '../../lib/problemDetails';
import { useGuardedMutate } from '../../lib/useGuardedMutate';
import { describeConnectFailure, describeFailureReason } from './connectFailure';
import { ConnectionSummary } from './ConnectionSummary';
import { useConnectionActions } from './useConnectionActions';
import { BrokerPresets } from './BrokerPresets';
import {
  BROKER_PRESETS,
  CLOUD_PRESETS,
  LOCAL_PRESETS,
  NO_PRESET_FILTER,
  PUBLIC_PRESETS,
  type BrokerPreset,
} from './presets';
import {
  CLIENT_ID_LIMIT_310,
  SCHEMES,
  VERSIONS,
  choiceOf,
  isEncrypted,
  isWebSocket,
  mayBeV5,
  portFor,
  versionNote,
  type Scheme,
} from './scheme';
import { buildConnectRequest, formFromSaved, type BrokerForm } from './brokerForm';

const DEFAULTS: BrokerForm = {
  scheme: 'mqtt',
  host: 'localhost',
  port: 1883,
  clientId: 'mqttforge-console',
  username: '',
  password: '',
  webSocketPath: '',
  protocolVersion: 'auto',
  cleanSession: true,
  sessionExpiry: '',
  allowUntrusted: false,
  caPath: '',
  clientCertPath: '',
  clientKeyPath: '',
  clientCertPassword: '',
  sniHost: '',
  alpnProtocol: '',
};

// The bare scheme, not `mqtt://`. Measured in the panel at its default width: the four with
// `://` need 310px and have 292, so they broke to a second row of one. Under a row labelled
// Protocol, with a line under it saying what the chosen one is, the punctuation was carrying
// nothing the label was not. It survives where it reads as an address instead of a choice —
// the Protocol row of the connection summary.
const SCHEME_OPTIONS = SCHEMES.map((s) => ({ value: s.scheme, label: s.scheme }));
const VERSION_OPTIONS = VERSIONS.map((v) => ({ value: v.value, label: v.label }));

export function BrokerPanel({ onClose }: { onClose: () => void }) {
  const [form, setForm] = useState(DEFAULTS);
  const [autoSubscribe, setAutoSubscribe] = useState(true);
  // What auto-subscribe actually asks for. It used to be a hard-coded '#', which every public
  // broker tested refuses — one of them by closing the session, so the console connected and
  // fell over. A preset overwrites this; a reader typing their own broker can too.
  const [onConnectFilter, setOnConnectFilter] = useState(NO_PRESET_FILTER);
  // The last template applied, for the note under its group. A cloud preset leaves the host
  // blank on purpose, so it can never be the one the form "matches" — and its note is the whole
  // point of it, being the only place the port, the path and the shape of its username are
  // written down together.
  const [picked, setPicked] = useState<string | null>(null);

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

  // Derived, not remembered: type over the host and the chip goes out by itself, with no second
  // copy of the truth to get out of step with the fields.
  //
  // A preset with no host of its own is never the answer. Three cloud services sit on 8883 over
  // mqtts, so an empty host matched all three and lit whichever came first in the list — press
  // AWS IoT Core and HiveMQ Cloud's chip came on, with HiveMQ Cloud's instructions under it.
  // What the form matches is a question those presets deliberately do not answer; `picked` is.
  const activePreset =
    BROKER_PRESETS.find(
      (p) => p.host !== '' && p.host === form.host && p.port === form.port && p.scheme === form.scheme,
    ) ?? null;

  const applyPreset = (preset: BrokerPreset) => {
    setPicked(preset.name);
    setForm((current) => ({
      ...current,
      host: preset.host,
      port: preset.port,
      scheme: preset.scheme,
      webSocketPath: preset.webSocketPath ?? '',
      protocolVersion: preset.protocolVersion ?? 'auto',
      username: preset.username,
      // A password typed for one broker must not travel to another; these are all public.
      password: '',
      alpnProtocol: preset.tls?.alpnProtocol ?? '',
    }));
    setOnConnectFilter(preset.onConnectFilter);
  };

  // Changing the scheme moves the port with it, but only when the port on screen is the one the
  // old scheme filled in by itself — see portFor. The path stays where it is: ws to wss is the
  // commonest switch of the four and keeps the same path, and a path typed under a TCP scheme
  // is dropped on the way out rather than saved against a connection that never used it.
  const pickScheme = (scheme: Scheme) =>
    setForm((current) => ({
      ...current,
      scheme,
      port: portFor(current.scheme, scheme, current.port),
    }));

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

  // Arrives after first render; neither password is ever returned by the API.
  //
  // The filter comes back with it, from the preset the saved address belongs to. It is not
  // saved alongside the address and reopening the panel over a Helsinki connection therefore
  // offered to reconnect with a bare '#' — the one filter that broker refuses by closing the
  // session. An address we have a preset for tells us what to listen to on it; one we do not
  // keeps the '#' it always had, there being nothing better to guess.
  useEffect(() => {
    if (!saved) return;
    // Only over the default. A preset picked, or a filter typed, before the saved settings
    // arrived is the reader's own and outranks anything remembered about the last connection.
    const preset = BROKER_PRESETS.find((p) => p.host === saved.host && p.port === saved.port);
    if (preset) setOnConnectFilter((current) => (current === NO_PRESET_FILTER ? preset.onConnectFilter : current));

    setForm(formFromSaved(saved));
  }, [saved]);

  // Read off the attempt that failed, not the form, which the user may have edited since.
  // Once this panel is closed that attempt is gone, so the connection state carries its own
  // copy of both the reason and the broker it is about — which is also what a dropped link
  // reports. Never the saved settings: those only record a connect that worked.
  const attempted = connectMutation.variables?.request;
  const failure =
    (attempted && describeConnectFailure(connectMutation.error, attempted)) ??
    (faulted && describeFailureReason(faulted.reason, faulted));

  const encrypted = isEncrypted(form.scheme);
  const overWebSocket = isWebSocket(form.scheme);
  const sessionKept = !form.cleanSession;
  const cleanLabel = form.protocolVersion === 'v500' ? 'Clean start' : 'Clean session';

  const set = <K extends keyof BrokerForm>(key: K, value: BrokerForm[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const submit = () =>
    guardedConnect({ request: buildConnectRequest(form), autoSubscribe, onConnectFilter });

  return (
    <PanelShell title="Broker" onClose={onClose}>
      <BrokerPresets
        presets={LOCAL_PRESETS}
        title="Start from a broker"
        labelId="presetsLabel"
        active={activePreset}
        picked={picked}
        onPick={applyPreset}
      />

      <Segmented
        label="Protocol"
        name="scheme"
        options={SCHEME_OPTIONS}
        value={form.scheme}
        onChange={pickScheme}
        note={choiceOf(form.scheme).note}
      />

      <div className={styles.row}>
        <Field label="Host" htmlFor="host">
          <input
            id="host"
            type="text"
            value={form.host}
            placeholder={form.host === '' ? 'paste your broker address' : undefined}
            onChange={(e) => set('host', e.target.value)}
          />
          <FieldError error={connectMutation.error} field="Host" />
        </Field>
        <Field label="Port" htmlFor="port" narrow>
          <input
            id="port"
            type="number"
            value={form.port}
            onChange={(e) => set('port', Number(e.target.value))}
          />
          <FieldError error={connectMutation.error} field="Port" />
        </Field>
      </div>

      {/* Only where it means something. On TCP there is no path, and an empty box asking for one
          reads as a field somebody forgot to fill in. */}
      {overWebSocket && (
        <div className={styles.row}>
          <Field label="WebSocket path" htmlFor="webSocketPath">
            <input
              id="webSocketPath"
              type="text"
              value={form.webSocketPath}
              placeholder="/mqtt"
              onChange={(e) => set('webSocketPath', e.target.value)}
            />
            <FieldError error={connectMutation.error} field="WebSocketPath" />
            <p className={styles.note}>
              Empty means /mqtt, which is what nearly every broker publishes.
            </p>
          </Field>
        </div>
      )}

      <div className={styles.row}>
        <Field label="Client ID" htmlFor="clientId">
          <input
            id="clientId"
            type="text"
            value={form.clientId}
            onChange={(e) => set('clientId', e.target.value)}
          />
          <FieldError error={connectMutation.error} field="ClientId" />
          {/* The specification's own limit, said before the broker says it: a 3.1 broker answers
              a long ID with a refusal that names neither the length nor the version. */}
          {form.protocolVersion === 'v310' && form.clientId.length > CLIENT_ID_LIMIT_310 && (
            <p className={styles.note}>
              MQTT 3.1 allows {CLIENT_ID_LIMIT_310} characters; this is {form.clientId.length}.
              Brokers do enforce it.
            </p>
          )}
        </Field>
      </div>

      <div className={styles.row}>
        <Field label="Username" htmlFor="username">
          <input
            id="username"
            type="text"
            placeholder="optional"
            value={form.username}
            onChange={(e) => set('username', e.target.value)}
          />
        </Field>
        <Field label="Password" htmlFor="password">
          <input
            id="password"
            type="password"
            placeholder="optional"
            value={form.password}
            onChange={(e) => set('password', e.target.value)}
          />
        </Field>
      </div>

      <Segmented
        label="MQTT version"
        name="protocolVersion"
        options={VERSION_OPTIONS}
        value={form.protocolVersion}
        onChange={(value) => set('protocolVersion', value)}
        note={versionNote(form.protocolVersion)}
      />

      <div className={styles.checks}>
        <label>
          <input
            type="checkbox"
            checked={form.cleanSession}
            onChange={(e) => set('cleanSession', e.target.checked)}
          />
          {` ${cleanLabel}`}
        </label>
        <label>
          <input
            type="checkbox"
            checked={autoSubscribe}
            onChange={(e) => setAutoSubscribe(e.target.checked)}
          />
          {' Subscribe on connect'}
        </label>
      </div>

      {/* Unticking the box is what makes session lifetime a question, and the two versions
          answer it differently — which is the whole of the difference between them that this
          form has to show. On 5.0 you say how long; on 3.x nobody does, and the broker keeps it
          until it decides otherwise. */}
      {sessionKept &&
        (mayBeV5(form.protocolVersion) ? (
          <>
            <div className={styles.row}>
              <Field label="Session expiry" htmlFor="sessionExpiry" narrow>
                <input
                  id="sessionExpiry"
                  type="number"
                  min={0}
                  placeholder="secs"
                  value={form.sessionExpiry}
                  onChange={(e) => set('sessionExpiry', e.target.value)}
                />
              </Field>
            </div>
            {/* Under the field rather than beside it: a note in the column next to a box this
                narrow wraps to seven lines and makes the row taller than the whole of the rest
                of the form put together. Measured at the panel's default width. */}
            <p className={styles.note}>
              Seconds the broker keeps this session after the link goes. MQTT 5 only; an empty
              box says nothing.
            </p>
          </>
        ) : (
          <p className={styles.note}>
            On MQTT {form.protocolVersion === 'v310' ? '3.1' : '3.1.1'} a kept session has no
            expiry to set: the broker holds it until it decides otherwise.
          </p>
        ))}

      {/* Shown even when the box is clear, rather than swapped out for nothing: what a preset
          brought is half of what it is, and a reader comparing two of them should be able to
          read both filters without toggling a checkbox to see them. */}
      <div className={styles.row}>
        <Field label="On-connect filter" htmlFor="onConnectFilter">
          <input
            id="onConnectFilter"
            type="text"
            value={onConnectFilter}
            disabled={!autoSubscribe}
            onChange={(e) => setOnConnectFilter(e.target.value)}
          />
        </Field>
      </div>

      {/* Folded away, and only offered where there is encryption to configure. Six fields that
          the great majority of connections never need would otherwise sit between the password
          and the button that uses it. */}
      {encrypted && (
        <details className={styles.more}>
          <summary>Encryption</summary>

          <div className={styles.checks}>
            <label>
              <input
                type="checkbox"
                checked={form.allowUntrusted}
                onChange={(e) => set('allowUntrusted', e.target.checked)}
              />
              {' Accept any certificate'}
            </label>
          </div>
          <p className={styles.note}>
            Turns verification off entirely — for a broker of your own with a certificate it
            signed itself, and nothing else. Naming its CA below keeps the checking.
          </p>

          <div className={styles.row}>
            <Field label="Extra CA certificate" htmlFor="caPath">
              <input
                id="caPath"
                type="text"
                placeholder="/path/to/ca.crt"
                value={form.caPath}
                onChange={(e) => set('caPath', e.target.value)}
              />
            </Field>
          </div>

          {/* A row each, rather than two to a row. Paths are the longest thing anyone types
              into this panel, and half a column shows about six characters of one — measured,
              after the two shared a row and 'Client certificate' wrapped to two lines while
              'Private key' did not, leaving their boxes at different heights. */}
          <div className={styles.row}>
            <Field label="Client certificate" htmlFor="clientCertPath">
              <input
                id="clientCertPath"
                type="text"
                placeholder="/path/to/client.pfx or .crt"
                value={form.clientCertPath}
                onChange={(e) => set('clientCertPath', e.target.value)}
              />
            </Field>
          </div>

          <div className={styles.row}>
            <Field label="Private key" htmlFor="clientKeyPath">
              <input
                id="clientKeyPath"
                type="text"
                placeholder="not needed for a .pfx"
                value={form.clientKeyPath}
                onChange={(e) => set('clientKeyPath', e.target.value)}
              />
            </Field>
          </div>

          <div className={styles.row}>
            <Field label="Certificate password" htmlFor="clientCertPassword">
              <input
                id="clientCertPassword"
                type="password"
                placeholder="optional"
                value={form.clientCertPassword}
                onChange={(e) => set('clientCertPassword', e.target.value)}
              />
            </Field>
          </div>

          {/* Files are read where the connection is held, which is the server — the same machine
              for a desktop app, and inside the container for a container. */}
          <p className={styles.note}>
            Paths are read by MQTTForge, not by this browser: on a container they must be paths
            inside it.
          </p>

          <div className={styles.row}>
            <Field label="Server name" htmlFor="sniHost">
              <input
                id="sniHost"
                type="text"
                placeholder="defaults to the host"
                value={form.sniHost}
                onChange={(e) => set('sniHost', e.target.value)}
              />
            </Field>
            <Field label="ALPN protocol" htmlFor="alpnProtocol">
              <input
                id="alpnProtocol"
                type="text"
                placeholder="e.g. x-amzn-mqtt-ca"
                value={form.alpnProtocol}
                onChange={(e) => set('alpnProtocol', e.target.value)}
              />
              <FieldError error={connectMutation.error} field="Tls.AlpnProtocol" />
            </Field>
          </div>
        </details>
      )}

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

      {saved?.tls?.hasClientCertificatePassword && (
        <p className={styles.note}>
          The certificate password is saved but never sent back either. Enter it again to connect.
        </p>
      )}

      <ConnectionSummary />

      {/* At the foot, behind everything the panel is for. None of these is the answer to 'which
          broker am I connecting to', and four chips above the form were four things to read past
          on every visit. The section says once what its chips are, so no chip has to. */}
      <section className={styles.aside}>
        <BrokerPresets
          presets={PUBLIC_PRESETS}
          title="Or someone else's broker"
          labelId="publicPresetsLabel"
          hint="Open to anyone, shared with everyone. Never for anything private."
          active={activePreset}
          picked={picked}
          onPick={applyPreset}
        />

        <BrokerPresets
          presets={CLOUD_PRESETS}
          title="Or a cloud service"
          labelId="cloudPresetsLabel"
          hint="Fills in the port, the path and the shape of the credentials. The address is yours to paste."
          active={activePreset}
          picked={picked}
          onPick={applyPreset}
        />
      </section>
    </PanelShell>
  );
}

function FieldError({ error, field }: { error: unknown; field: string }) {
  const message = fieldError(error, field);
  return message ? <p className={styles.note}>{message}</p> : null;
}

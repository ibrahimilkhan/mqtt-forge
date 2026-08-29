import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { MqttTransport, SavedProfile } from '../../types/api';
import type { PanelId } from '../panels';
import {
  deleteProfile,
  getSavedProfiles,
  getSavedSettings,
  saveProfile,
} from '../../api/connection';
import { queryKeys } from '../../api/queryKeys';
import { Field } from '../../components/Field';
import { PanelShell } from '../../components/PanelShell';
import styles from '../../styles/panel.module.css';
import { useConnectionState } from '../../api/useConnectionState';
import { ApiError, fieldError } from '../../lib/problemDetails';
import { logFault } from '../../stores/logStore';
import { useGuardedMutate } from '../../lib/useGuardedMutate';
import type { CertificateFileKind } from '../../api/connection';
import { describeConnectFailure, describeFailureReason, suggestScheme } from './connectFailure';
import { ConnectionSummary } from './ConnectionSummary';
import { SavedBrokers } from './SavedBrokers';
import { useCertificateFile } from './useCertificateFile';
import { useConnectionActions } from './useConnectionActions';
import {
  choiceOf,
  isEncrypted,
  isWebSocket,
  portFor,
  schemeForPort,
  schemeOf,
  type Scheme,
} from './scheme';
import {
  applyAddress,
  buildConnectRequest,
  formFromSaved,
  hasTlsMaterial,
  type BrokerForm,
} from './brokerForm';

/**
 * How long a link has to hold before this panel steps aside for it, in milliseconds.
 *
 * See the effect that uses it. The failure this exists for lands inside 150ms — measured against
 * mqtt.hsl.fi, which takes the connection and hangs up on the subscribe that follows — so this is
 * twice the window it has to catch, and short enough that a link which holds is not made to look
 * like one being thought about.
 */
export const SETTLE = 300;

const DEFAULTS: BrokerForm = {
  scheme: 'mqtt',
  host: 'localhost',
  port: 1883,
  clientId: 'mqttforge-console',
  username: '',
  password: '',
  webSocketPath: '',
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

/**
 * Where to point the console, and what is up right now.
 *
 * The panel is laid out by how often a reader needs each part of it rather than by how the
 * connection is put together, because the two are nothing like the same order. Measured at the
 * panel's own width, the form that showed every field at once ran to 1477px in a 900px window,
 * and the two controls that every single connection goes through — the address and the button —
 * were 98px of it. Everything else was either a default nobody changes, a broker somebody else
 * runs, or a description of a link that was already up.
 *
 * So there are three things on screen at most, in the order the questions arrive:
 *
 *  - the live link, first and only while there is one, since a panel reopened over a working
 *    connection was opened to read it or to end it;
 *  - the form, which is one column of three named blocks — Broker, User, Encryption — with what
 *    to listen to standing beside the button rather than among them;
 *  - the brokers the reader kept, at the foot.
 *
 * The form is a single stack at every width, and centred in whatever the panel is given. It was
 * two columns for one release: the broker beside the client. The pair only held at the two
 * widest windows — under about 660px it stacked anyway — so the same panel read down one order
 * on a desktop and another on a laptop, and neither was the order anyone would say the questions
 * in. See .form and the measure in Workspace.module.css.
 *
 * Nothing here explains itself. Every grey line under a field — what the scheme meant, what an
 * empty WebSocket path defaults to, what the seconds counted, what accepting any certificate
 * gave up — has been taken out on purpose, and putting one back is a decision rather than an
 * improvement. What is left says something that has happened: a field the API refused, and the
 * sentence naming why a connect failed. Placeholders carry what a box wants; the README carries
 * what the fields are for.
 */
export function BrokerPanel({
  onClose,
  open,
}: {
  onClose: () => void;
  open: (id: PanelId) => void;
}) {
  const [form, setForm] = useState(DEFAULTS);
  // The Broker address box's own text. Normally the host, the way in being the control to its
  // left and the port the one to its right — but the box takes a whole address too, and while
  // one is being typed this holds however much of it has arrived. Separate from the form because
  // a box built from it directly would have to be re-parsed on every keystroke, which is exactly
  // what splitting on the way out of the box exists to avoid.
  const [addressText, setAddressText] = useState(DEFAULTS.host);
  const addressRef = useRef<HTMLInputElement>(null);
  const [autoSubscribe, setAutoSubscribe] = useState(true);
  // The name box, and whether it is on screen at all. Null is "not saving"; a string is the name
  // as far as it has been typed. Two states in one, because "empty box open" and "no box" are
  // different things and a boolean beside a string would let them disagree.
  const [naming, setNaming] = useState<string | null>(null);
  // Which saved broker the form was last filled from, so its chip can say so. Cleared by every
  // edit that moves the address, since after that the form is no longer that broker.
  const [from, setFrom] = useState<string | null>(null);
  const { data: saved } = useQuery({ queryKey: queryKeys.savedSettings, queryFn: getSavedSettings });
  const { data: profiles } = useQuery({
    queryKey: queryKeys.savedProfiles,
    queryFn: getSavedProfiles,
  });

  const queryClient = useQueryClient();
  const refreshProfiles = () =>
    void queryClient.invalidateQueries({ queryKey: queryKeys.savedProfiles });

  const keepMutation = useMutation({
    mutationFn: ({ name, form: kept }: { name: string; form: BrokerForm }) =>
      saveProfile(name, buildConnectRequest(kept)),
    onSuccess: (_result, { name }) => {
      setNaming(null);
      setFrom(name);
      refreshProfiles();
    },
    onError: (error) => logFault('Save failed', error),
  });

  const forgetMutation = useMutation({
    mutationFn: deleteProfile,
    onSuccess: (_result, name) => {
      setFrom((current) => (current === name ? null : current));
      refreshProfiles();
    },
    onError: (error) => logFault('Forget failed', error),
  });
  const files = useCertificateFile();
  const { connectMutation, disconnectMutation, abortMutation } = useConnectionActions();
  const { isOnline, isConnecting, failure: faulted, answered } = useConnectionState();
  const guardedConnect = useGuardedMutate(connectMutation);
  const guardedDisconnect = useGuardedMutate(disconnectMutation);
  const guardedAbort = useGuardedMutate(abortMutation);

  // Two sources because they cover different gaps: isPending answers the instant this panel
  // fires, before the API has been asked anything; isConnecting is the only one a panel that
  // was closed when the attempt started — or reopened since — has to go on.
  const attemptRunning = isConnecting || connectMutation.isPending;


  /**
   * The form and the address box, moved together.
   *
   * They are one value in two places, and everything that moves either of them — a preset, the
   * saved settings, a scheme chip, a port that implies a scheme, an address typed into the box
   * itself — goes through here, so they cannot come apart. Typing is the one exception, and only
   * until the box is left.
   *
   * No effect syncing the box from the form: one would fight with the typing it is meant to
   * leave alone.
   */
  const settle = (next: BrokerForm) => {
    setForm(next);
    setAddressText(next.host);
    // Whatever the form was filled from, it is not that any more — unless it still matches, and
    // that is the chip's own question rather than this one's.
    setFrom((current) => (current && matches(next, current) ? current : null));
  };

  /** Whether the form still holds what the named broker holds. */
  const matches = (candidate: BrokerForm, name: string) => {
    const profile = profiles?.find((one) => one.name === name);

    return (
      profile !== undefined &&
      profile.connection.host === candidate.host &&
      profile.connection.port === candidate.port &&
      profile.connection.useTls === isEncrypted(candidate.scheme) &&
      profile.connection.transport === choiceOf(candidate.scheme).transport
    );
  };

  /**
   * A saved broker back into the form.
   *
   * Everything but the passwords, which the API never sends back — the same rule the saved
   * settings keep, and the form says so under the box that wants them.
   */
  const usePicked = (profile: SavedProfile) => {
    settle(formFromSaved(profile.connection));
    setFrom(profile.name);
  };


  /**
   * The two answers, put back together into the one thing the API is told.
   *
   * `Scheme` stays the form's own shape, every other part of the panel being written against it,
   * and this is where the transport and the encryption box meet it again. `schemeOf` has always
   * been that translation; it just never had two controls to translate for.
   *
   * Either answer moves the port with it, but only when the port on screen is the one the old
   * combination filled in by itself — see portFor. The path stays where it is: ticking Encrypted
   * over a WebSocket is the commonest change of the four and keeps the same path, and a path
   * typed under TCP is dropped on the way out rather than saved against a connection that never
   * used it.
   */
  const pickWay = (transport: MqttTransport, useTls: boolean) => {
    const scheme = schemeOf(transport, useTls);

    settle({ ...form, scheme, port: portFor(form.scheme, scheme, form.port) });
  };

  /**
   * A link coming up is the end of this panel's job — once the link holds.
   *
   * It stands aside and hands its column back to the traffic it just started; the rail's lamp and
   * the address under it carry the state from here, and the menu button reopens it.
   *
   * But it does not step aside on the announcement of a link. A broker that takes the connection
   * and then closes it a moment later is the ordinary case out on the public internet rather than
   * the strange one: every topic is what this console asks for on connect, and a broker that will
   * not give you every topic answers by hanging up. Against mqtt.hsl.fi the whole of that —
   * connected, subscribed, gone — lands inside 150ms, so the panel was already shut when the
   * sentence explaining it arrived, and the reader had to reopen the panel to find out what had
   * become of the connect they had just pressed.
   *
   * So the link coming up arms the close, and only a link still up a beat later fires it. Anything
   * that takes it down in between disarms it and the panel stays exactly where it is, with the
   * failure and its way out under the button. The beat is twice that 150ms and no more: long
   * enough to catch the broker hanging up, short enough that a link which holds still reads as
   * one the panel got out of the way of rather than one it stopped to think about.
   *
   * Only on the change, and only after the API has answered once. Opened over a link that is
   * already up — to read the summary, or to disconnect — nothing has just happened, and a panel
   * that shut itself the moment it was asked for would be unusable.
   */
  const wasOnline = useRef<boolean | null>(null);
  const [settling, setSettling] = useState(false);
  useEffect(() => {
    if (!answered) return;
    const before = wasOnline.current;
    wasOnline.current = isOnline;

    if (before === false && isOnline) setSettling(true);
    else if (!isOnline) setSettling(false);
  }, [answered, isOnline]);

  // onClose is rebuilt on every render of the console, so the timer below cannot depend on it
  // without being restarted by renders that have nothing to do with the link — which is a timer
  // that never fires.
  const closer = useRef(onClose);
  useEffect(() => {
    closer.current = onClose;
  });

  useEffect(() => {
    if (!settling) return;

    const held = setTimeout(() => closer.current(), SETTLE);

    return () => clearTimeout(held);
  }, [settling]);

  // Arrives after first render; neither password is ever returned by the API.
  useEffect(() => {
    if (!saved) return;

    settle(formFromSaved(saved));
  }, [saved]);

  // Where a reader who opened this panel is going to type first. Not over a live link: that
  // panel was opened to read the summary or to end the connection, and a cursor in a box the
  // reader is not filling in is a cursor in the way.
  //
  // Once, on the way in. `answered` is what makes that possible to say: before the API answers,
  // isOnline is a guess, and focusing on a guess means focusing and then taking it away.
  const focused = useRef(false);
  useEffect(() => {
    if (!answered || focused.current) return;
    focused.current = true;
    if (!isOnline) addressRef.current?.focus();
  }, [answered, isOnline]);

  // Read off the attempt that failed, not the form, which the user may have edited since.
  // Once this panel is closed that attempt is gone, so the connection state carries its own
  // copy of both the reason and the broker it is about — which is also what a dropped link
  // reports. Never the saved settings: those only record a connect that worked.
  const attempted = connectMutation.variables?.request;
  const failure =
    (attempted && describeConnectFailure(connectMutation.error, attempted)) ??
    (faulted && describeFailureReason(faulted.reason, faulted));

  // Only ever beside the sentence it answers, and about the same attempt that sentence is about
  // — never the form, which the reader may have edited since. An offer to switch to a scheme
  // they have already switched to is worse than no offer.
  //
  // The gate on `failure` inherits everything describeConnectFailure refuses to speak about: a
  // field error the inputs print themselves, and an attempt the reader called off.
  const suggestion = failure
    ? (attempted && suggestScheme(errorReason(connectMutation.error), attempted)) ||
      (faulted && suggestScheme(faulted.reason, faulted)) ||
      undefined
    : undefined;

  // The broker took the connection and then refused what was asked of it. Listening to every
  // topic is what this panel asks for, and a good many brokers out on the internet will not
  // allow it — so the dead end gets a way out rather than a sentence and nothing to press.
  const filterRefused = faulted?.reason === 'filterRefused' || faulted?.reason === 'notPermitted';

  const encrypted = isEncrypted(form.scheme);
  const overWebSocket = isWebSocket(form.scheme);
  // Anything filled in under Encryption, which holds the box on: a certificate is a statement
  // that this connection is encrypted, and there is nothing else it could mean.
  const certified = hasTlsMaterial(form);
  // A certificate names the two fields that go with it. Until there is one, a key and a password
  // are fields for a file that does not exist.
  const clientCert = form.clientCertPath.trim();
  // A .pfx carries its own key. Asking for one beside it is asking for a file nobody has.
  const bundled = /\.(pfx|p12)$/i.test(clientCert);
  const sessionKept = !form.cleanSession;

  const set = <K extends keyof BrokerForm>(key: K, value: BrokerForm[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  /**
   * The same, for the fields under Encryption, which answer the encryption question by existing.
   *
   * Naming a certificate is not a preference about encryption, it is encryption — so the box
   * comes on and the port moves with it, exactly as if the box had been ticked by hand. Only
   * ever on: clearing the field again lets go of the box without turning anything off, an
   * unticking nobody asked for being a surprise, and the box is right there.
   */
  const setTls = <K extends keyof BrokerForm>(key: K, value: BrokerForm[K]) =>
    setForm((current) => {
      const next = { ...current, [key]: value };
      if (isEncrypted(next.scheme) || !hasTlsMaterial(next)) return next;

      const scheme = schemeOf(choiceOf(next.scheme).transport, true);

      return { ...next, scheme, port: portFor(next.scheme, scheme, next.port) };
    });

  // The box's text is reconciled here rather than relied on to have been reconciled by the blur.
  // A pure function called from both places means there is no ordering of events in which the
  // box shows one broker and the attempt goes to another.
  const submit = () => {
    const resolved = applyAddress(form, addressText);
    settle(resolved);
    guardedConnect({ request: buildConnectRequest(resolved), autoSubscribe });
  };

  /**
   * The form, kept under the name in the box.
   *
   * Through the same reconciliation Connect goes through, so a broker saved with the address box
   * still focused is saved as the address that box shows.
   */
  const keep = () => {
    const name = naming?.trim();
    if (!name) return;

    const resolved = applyAddress(form, addressText);
    settle(resolved);
    keepMutation.mutate({ name, form: resolved });
  };

  // The offer, taken. Mirrors submit exactly — the same reconciliation, the same request — with
  // the scheme replaced and the port moved the way pressing the chip would move it.
  const retryOn = (scheme: Scheme) => {
    const current = applyAddress(form, addressText);
    const next = { ...current, scheme, port: portFor(current.scheme, scheme, current.port) };
    settle(next);
    guardedConnect({ request: buildConnectRequest(next), autoSubscribe });
  };

  /**
   * Enter, from anywhere in the form.
   *
   * The commonest thing a pair of hands does after typing an address, and until now it did
   * nothing at all. Not a `<form>`: the panel holds two submits — Connect, and Save under the
   * name box — and a form would give Enter to whichever button came first whatever the reader
   * was typing in.
   *
   * The name box answers Enter itself, so a keystroke that reaches here from inside it has
   * already been handled. Nothing fires over a live link either, which is the one thing Connect
   * cannot do.
   */
  const onEnter = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Enter' || naming !== null || isOnline || attemptRunning) return;
    // Not from inside a fold's summary, where Enter is what opens it.
    if ((e.target as HTMLElement).tagName !== 'INPUT') return;

    e.preventDefault();
    submit();
  };

  return (
    <PanelShell title="Broker" onClose={onClose}>
      {/* First, and on its own, while there is a link. A panel reopened over a working
          connection was reopened to read it or to end it — not to fill in a form that would
          replace it — and the form underneath answers a question this reader has already
          answered. */}
      {isOnline && (
        <div className={styles.live}>
          <ConnectionSummary lead />
          <div className={styles.actions}>
            <button
              type="button"
              className="ghost"
              onClick={() => guardedDisconnect()}
              disabled={disconnectMutation.isPending}
            >
              Disconnect
            </button>
          </div>
        </div>
      )}

      {/* One column, in the order the questions arrive: where to point it, who it says it is
          when it gets there, and how the channel is secured.

          It was two columns, the broker beside the client. The pair only ever held at the two
          widest windows — under about 660px it stacked anyway — so the same panel read down one
          order on a desktop and a different one on a laptop, and neither was the order anybody
          would say the questions in. One order, at every width, is the whole of the change.

          The column is capped and centred rather than let out to the window; see `.form`. */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
      <div className={styles.form} onKeyDown={onEnter}>
        <section className={styles.group}>
          {/* Named, now that the three blocks stand one under another rather than in columns a
              reader could take in at a glance. A heading each is what tells a scrolling eye which
              question it has arrived at. */}
          <h3 className={styles.groupTitle}>Broker</h3>
          {/* The address, first, because it is the only thing the reader actually has. The way in
              stands at the head of it, where a scheme stands in a URL — and it is two words rather
              than four, because mqtt against mqtts was never one question. It was two, multiplied
              together and asked in a letter nobody can see. */}
          <div className={styles.row}>
            <Field label="Broker address" htmlFor="address">
              <div className={styles.addressLine}>
                <select
                  id="transport"
                  aria-label="Transport"
                  value={choiceOf(form.scheme).transport}
                  onChange={(e) => pickWay(e.target.value as MqttTransport, encrypted)}
                >
                  {/* Written with the `://` they carry in an address, this being where they stand
                      and what they are standing in for. */}
                  <option value="tcp">mqtt://</option>
                  <option value="webSocket">ws://</option>
                </select>
                <input
                  id="address"
                  type="text"
                  ref={addressRef}
                  value={addressText}
                  placeholder="broker.example"
                  onChange={(e) => setAddressText(e.target.value)}
                  // On the paste and on the way out of the box, never on the keystroke. Splitting
                  // as it is typed takes the address apart at whatever it happens to be halfway
                  // through a hostname — `mqtts://b` is a complete address and would leave `b` in
                  // this box with the rest of the name typed after it. A paste arrives whole, and
                  // by the time the box is left the reader has finished writing in it.
                  onPaste={(e) => {
                    e.preventDefault();
                    settle(applyAddress(form, e.clipboardData.getData('text')));
                  }}
                  onBlur={(e) => settle(applyAddress(form, e.target.value))}
                />
              </div>
              {/* Keyed on Host, which is what the API calls what this box holds. */}
              <FieldError error={connectMutation.error} field="Host" />
            </Field>
            <Field label="Port" htmlFor="port" narrow>
              <input
                id="port"
                type="number"
                value={form.port}
                onChange={(e) => set('port', Number(e.target.value))}
                // On the way out, for the same reason the address box splits on the way out: a
                // number halfway through being typed is not a number. See schemeForPort.
                onBlur={() => settle({ ...form, scheme: schemeForPort(form.scheme, form.port) })}
              />
              <FieldError error={connectMutation.error} field="Port" />
            </Field>
          </div>

          {/* The second question, in the word everybody has for it. The s in mqtts asks exactly this
              and asks it in a letter nobody can see. Three things answer it — the port above, a
              pasted address, and a certificate — and all three tick this box. */}
          <div className={styles.checks}>
            <label>
              <input
                type="checkbox"
                checked={encrypted}
                disabled={certified}
                onChange={(e) => pickWay(choiceOf(form.scheme).transport, e.target.checked)}
              />
              {' Encrypted (TLS)'}
            </label>
          </div>

          {/* Only where it means something. On TCP there is no path, and an empty box asking for
              one reads as a field somebody forgot to fill in. */}
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
                {/* No FieldError: the API refuses no path, deliberately. A wrong one comes back as
                    a refused upgrade, which says more than any rule here could. */}
              </Field>
            </div>
          )}
        </section>

        <section className={styles.group}>
          <h3 className={styles.groupTitle}>User</h3>
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

          {/* Plainly, not behind a line. It was folded with the version picker and the session, as
              three settings nobody changes — but the version is not asked at all any more, and a
              client ID is a thing brokers refuse connections over and log by. It is one field, and a
              reader looking for why a broker turned them away should find it without opening
              anything. */}
          <div className={styles.row}>
            <Field label="Client ID" htmlFor="clientId">
              <input
                id="clientId"
                type="text"
                value={form.clientId}
                onChange={(e) => set('clientId', e.target.value)}
              />
              <FieldError error={connectMutation.error} field="ClientId" />
            </Field>
          </div>

          <div className={styles.checks}>
            <label>
              <input
                type="checkbox"
                checked={form.cleanSession}
                onChange={(e) => set('cleanSession', e.target.checked)}
              />
              {' Clean session'}
            </label>
          </div>

          {/* Unticking the box is what makes session lifetime a question at all. Offered under Auto
              because Auto tries 5.0 first and against nearly every broker in service that is what it
              gets; a broker that steps down to 3.x ignores the number, which is the same outcome as
              not sending one. */}
          {sessionKept && (
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
          )}
        </section>

        {/* The third of the three, and a fold rather than a block: six fields the great majority
            of connections never need would otherwise stand between the password and the button
            that uses it. It stands in the stack with the other two — third, where it was asked
            for — so Enter reaches a certificate path the same way it reaches an address.

            It used to appear only under an encrypted scheme, which made naming a certificate
            impossible until encryption was already on — and a certificate is not something you
            want after deciding to encrypt, it is the reason you were encrypting. Filling any of
            these in ticks the box above.

            Inside, only what the answers so far make sense of: a key and a password are for a
            certificate, and a certificate in a .pfx carries its own key. */}
        <details className={styles.groupFold}>
          <summary>Encryption</summary>

          <div className={styles.checks}>
            <label>
              <input
                type="checkbox"
                checked={form.allowUntrusted}
                onChange={(e) => setTls('allowUntrusted', e.target.checked)}
              />
              {' Accept any certificate'}
            </label>
          </div>
          <PathField
            label="Extra CA certificate"
            id="caPath"
            kind="authority"
            placeholder="/path/to/ca.crt"
            value={form.caPath}
            onPath={(path) => setTls('caPath', path)}
            files={files}
          />

          {/* A row each, rather than two to a row. Paths are the longest thing anyone types
              into this panel, and half a column shows about six characters of one — measured,
              after the two shared a row and 'Client certificate' wrapped to two lines while
              'Private key' did not, leaving their boxes at different heights. */}
          <PathField
            label="Client certificate"
            id="clientCertPath"
            kind="certificate"
            placeholder="/path/to/client.pfx or .crt"
            value={form.clientCertPath}
            onPath={(path) => setTls('clientCertPath', path)}
            files={files}
          />

          {/* Only where there is a certificate for it to belong to, and only where that
              certificate does not already carry it. */}
          {clientCert !== '' && !bundled && (
            <PathField
              label="Private key"
              id="clientKeyPath"
              kind="key"
              placeholder="/path/to/client.key"
              value={form.clientKeyPath}
              onPath={(path) => setTls('clientKeyPath', path)}
              files={files}
            />
          )}

          {clientCert !== '' && (
            <>
              <div className={styles.row}>
                <Field label="Certificate password" htmlFor="clientCertPassword">
                  <input
                    id="clientCertPassword"
                    type="password"
                    placeholder="optional"
                    value={form.clientCertPassword}
                    onChange={(e) => setTls('clientCertPassword', e.target.value)}
                  />
                </Field>
              </div>
            </>
          )}

          {/* The other two, behind a line of their own: neither is about a certificate, and
              neither is asked for by any broker you reach at its own address on its own port.
              Kept rather than dropped, because without ALPN there is no way to reach AWS IoT Core
              on 443, which is the documented way through a firewall that allows only HTTPS. */}
          <details className={styles.more}>
            <summary>Server name and ALPN</summary>

            <div className={styles.row}>
              <Field label="Server name" htmlFor="sniHost">
                <input
                  id="sniHost"
                  type="text"
                  placeholder="defaults to the host"
                  value={form.sniHost}
                  onChange={(e) => setTls('sniHost', e.target.value)}
                />
              </Field>
            </div>
            <div className={styles.row}>
              <Field label="ALPN protocol" htmlFor="alpnProtocol">
                <input
                  id="alpnProtocol"
                  type="text"
                  placeholder="e.g. x-amzn-mqtt-ca"
                  value={form.alpnProtocol}
                  onChange={(e) => setTls('alpnProtocol', e.target.value)}
                />
                <FieldError error={connectMutation.error} field="Tls.AlpnProtocol" />
              </Field>
            </div>
          </details>
        </details>
      </div>

      {/* Not one of the three questions above — it is what happens the moment they are answered
          — so it stands with the button that answers them rather than among the client's own
          fields, where it used to sit between a client ID and a clean session and belonged to
          neither.

          What it asks for is everything. It used to carry a filter box beside it, because a
          bare # is refused by a good many brokers out on the internet — one of them by closing
          the session. That is now answered where it happens rather than guarded against here:
          the refusal says so, and hands over a button to the panel that fixes it. */}
      <div className={styles.checks}>
        <label>
          <input
            type="checkbox"
            checked={autoSubscribe}
            onChange={(e) => setAutoSubscribe(e.target.checked)}
          />
          {' Listen to every topic on connect'}
        </label>
      </div>

      {/* Two things to do with a form: use it, or keep it. Disconnect is neither and stands with
          the link it would end, which is the block above and only on screen when there is one. */}
      <div className={styles.actions}>
        {attemptRunning && (
          <button
            type="button"
            className={styles.steadyWidth}
            onClick={() => guardedAbort()}
            disabled={abortMutation.isPending}
          >
            Abort
          </button>
        )}

        {/* Absent over a live link rather than greyed. A live link is not something you connect
            over — the API would either report it unchanged or tear the session down, so
            Disconnect is the only way forward — and a button that cannot be pressed is a button
            that has to say why. It said so, in a line under it, until that line went with every
            other line on this panel. Nothing to explain is better than something to explain: the
            one button on screen while a link is up is the one that ends it. */}
        {!attemptRunning && !isOnline && (
          <button type="button" className={styles.steadyWidth} onClick={submit}>
            Connect
          </button>
        )}

        {/* Offered whatever is on screen, including over a live link: a broker worth keeping is
            most obviously worth keeping once it has connected. The name defaults to the address,
            which is what somebody with one broker would have typed anyway. */}
        {naming === null && (
          <button
            type="button"
            className="ghost"
            onClick={() => setNaming(from ?? `${form.host}:${form.port}`)}
          >
            Save this broker
          </button>
        )}
      </div>

      {/* The name, asked for where the button was rather than in a dialog over the form: the
          reader is naming what they are looking at, and a box that covers it is a box that makes
          them remember it instead. */}
      {naming !== null && (
        <div className={styles.row}>
          <Field label="Save as" htmlFor="profileName">
            <input
              id="profileName"
              type="text"
              value={naming}
              placeholder="a name you will recognise"
              autoFocus
              onChange={(e) => setNaming(e.target.value)}
              // Enter keeps it, Escape gives up. Neither is discoverable on its own, which is
              // why both buttons are there too — these are for the hands already on the keys.
              onKeyDown={(e) => {
                if (e.key === 'Enter') keep();
                if (e.key === 'Escape') setNaming(null);
              }}
            />
          </Field>
          <div className={styles.namingActions}>
            <button
              type="button"
              onClick={keep}
              disabled={naming.trim() === '' || keepMutation.isPending}
            >
              Save
            </button>
            <button type="button" className="ghost" onClick={() => setNaming(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* At the foot, and only once there is something to put here. It used to hold eleven
          brokers somebody else runs; these are the ones the reader kept. */}
      {profiles !== undefined && profiles.length > 0 && (
        <div className={styles.saved}>
          <h3 className={styles.savedTitle}>Saved brokers</h3>
          <SavedBrokers
            profiles={profiles}
            active={from}
            onPick={usePicked}
            onForget={(name) => forgetMutation.mutate(name)}
          />        </div>
      )}

      {failure && (
        <p className={styles.fault} role="alert">
          {failure}
        </p>
      )}

      {/* Under the sentence that explains the failure, not beside the button that caused it:
          it is the answer to what just happened, and it only exists because of it. */}
      {suggestion && !attemptRunning && (
        <div className={styles.actions}>
          <button type="button" className="ghost" onClick={() => retryOn(suggestion.scheme)}>
            {`Try ${suggestion.scheme}:// instead`}
          </button>
        </div>
      )}

      {/* The other dead end, and the other way out. The box above asks for every topic; a broker
          that will not give you every topic leaves you connected to nothing, and the panel that
          asks for less is the answer. */}
      {filterRefused && !attemptRunning && (
        <div className={styles.actions}>
          <button type="button" className="ghost" onClick={() => open('subscribe')}>
            Ask for less in Filters
          </button>
        </div>
      )}
    </PanelShell>
  );
}
// The reason off an error that carries one. Anything else — a network error, a thrown string —
// names no reason, and a suggestion needs one to be about.
const errorReason = (error: unknown) => (error instanceof ApiError ? error.reason : undefined);

/**
 * A path, and the dialog that fills it in.
 *
 * The box is the field; the button beside it is a shortcut, and it is only there on a host that
 * has a dialog to open. Nothing about the box changes when it is missing — a path typed in by
 * hand is what these fields have always taken, and it is still what the API is sent.
 *
 * The dialog answers with a path or with nothing. Nothing is a dialog somebody dismissed, and the
 * box is left exactly as it was: a reader who opened the dialog to look, thought better of it and
 * found their field emptied would have lost something they never asked to change.
 */
function PathField({
  label,
  id,
  kind,
  placeholder,
  value,
  onPath,
  files,
}: {
  label: string;
  id: string;
  kind: CertificateFileKind;
  placeholder: string;
  value: string;
  onPath: (path: string) => void;
  files: ReturnType<typeof useCertificateFile>;
}) {
  return (
    <div className={styles.row}>
      <Field label={label} htmlFor={id}>
        <div className={styles.pathLine}>
          <input
            id={id}
            type="text"
            placeholder={placeholder}
            value={value}
            onChange={(e) => onPath(e.target.value)}
          />
          {files.canChoose && (
            <button
              type="button"
              className="ghost"
              // The word on it says which of the two things it does; the label says which of the
              // three boxes it does it to, since three buttons reading Choose… are one button as
              // far as anything reading them out is concerned. The field's own name, uncased:
              // lowering it turned Extra CA certificate into 'extra ca certificate'.
              aria-label={`Choose ${label}`}
              // One dialog at a time — the host refuses a second — so the other two wait on the
              // one that is open rather than failing when they are pressed.
              disabled={files.choosing}
              onClick={async () => {
                const path = await files.choose(kind);
                if (path) onPath(path);
              }}
            >
              {value.trim() === '' ? 'Choose…' : 'Change…'}
            </button>
          )}
        </div>
      </Field>
    </div>
  );
}

function FieldError({ error, field }: { error: unknown; field: string }) {
  const message = fieldError(error, field);
  return message ? <p className={styles.note}>{message}</p> : null;
}

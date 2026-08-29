import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { MqttTransport, SavedProfile } from '../../types/api';
import type { PanelId } from '../panels';
import {
  deleteProfile,
  getSavedProfiles,
  getSavedSettings,
  saveProfile,
} from '../../api/connection';
import { queryKeys } from '../../api/queryKeys';
import { Save } from '../brand/icons';
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
import { applyAddress, buildConnectRequest, formFromSaved, type BrokerForm } from './brokerForm';

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
  // The Address box's own text. Normally the host, the way in being the control to its
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
  const { connectMutation, disconnectMutation, abortMutation, everythingRefused } =
    useConnectionActions();
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
  // Before the paint, not after it. The live block is gated on this flag, and a plain effect runs
  // once the browser has already drawn the frame the flag was meant to suppress — one frame of
  // the very block this exists to keep off the screen.
  useLayoutEffect(() => {
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
    // Not while the attempt is still running. The connect is not over when the broker says yes:
    // the subscription this console asks for on connect goes out inside the same mutation, and
    // the answer to it is the difference between a link worth stepping aside for and a link that
    // is listening to nothing. Waiting here is what makes everythingRefused knowable in time.
    if (!settling || attemptRunning || everythingRefused) return;

    const held = setTimeout(() => closer.current(), SETTLE);

    return () => clearTimeout(held);
  }, [settling, attemptRunning, everythingRefused]);

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
  //
  // Two shapes, and the second is the quiet one. A broker can close the session, which arrives as
  // a fault with a reason on it; or it can refuse the SUBACK and leave the link up, which is not a
  // failure anywhere and used to leave the reader connected, listening to nothing, with the panel
  // already gone because the link held. See everythingRefused in useConnectionActions.
  const filterRefused =
    faulted?.reason === 'filterRefused' || faulted?.reason === 'notPermitted' || everythingRefused;

  const encrypted = isEncrypted(form.scheme);
  const overWebSocket = isWebSocket(form.scheme);
  // A certificate names the two fields that go with it. Until there is one, a key and a password
  // are fields for a file that does not exist.
  const clientCert = form.clientCertPath.trim();
  // A .pfx carries its own key. Asking for one beside it is asking for a file nobody has.
  const bundled = /\.(pfx|p12)$/i.test(clientCert);
  const sessionKept = !form.cleanSession;

  const set = <K extends keyof BrokerForm>(key: K, value: BrokerForm[K]) =>
    setForm((current) => ({ ...current, [key]: value }));


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
          {/* The address, first, because it is the only thing the reader actually has. Labelled
              with the half of its name the heading above does not already say — BROKER over
              BROKER ADDRESS put the same word on screen twice, in two different voices, one line
              apart. The way in stands at the head of it, where a scheme stands in a URL — and it is two words rather
              than four, because mqtt against mqtts was never one question. It was two, multiplied
              together and asked in a letter nobody can see. */}
          <div className={styles.row}>
            <Field label="Address" htmlFor="address">
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
              pasted address, and a certificate — and all three tick this box.

              Tick it, is all they do. It used to be held shut while anything under Encryption was
              filled in, on the reasoning that a certificate is a statement that this connection is
              encrypted and can mean nothing else — which is true of the statement and wrong about
              the box. It made a dead end that could be walked into in three moves: tick Accept any
              certificate, name a CA under it, untick Accept any certificate. The thing you turned
              on is off, the box is still shut, and what is holding it is a path two fields down
              that nobody said anything about. Getting out meant knowing a rule the panel never
              stated — and the line that stated it is gone, along with every other line here.

              So the box opens. Unticking it is a real answer and the request already carries it:
              buildConnectRequest sends no TLS block at all under a plain scheme, so a certificate
              left in a box under an unencrypted connection is not sent rather than sent wrongly. */}
          <div className={styles.checks}>
            <label>
              <input
                type="checkbox"
                checked={encrypted}
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

            Inside, only what the answers so far make sense of: a key and a password are for a
            certificate, and a certificate in a .pfx carries its own key.

            And all of it follows the box above, which is the one rule this block has. Every field
            in here is TLS material; under a plain scheme the server is never even shown it —
            buildConnectRequest sends tls: null, and ConfigureTls is only reached when UseTls — so
            with encryption off these controls do nothing whatever they hold. They now look like
            it. One fieldset carries that for all of them at once rather than seven expressions
            that could drift apart.

            The fold and both summaries stay pressable: reading what a connection could be given
            is never blocked, only writing it. And the checkbox itself is deliberately outside —
            it is the way back on, and a control that turns something on cannot be turned off by
            the thing it turns on.

            What this replaces is the affordance running the other way: filling a certificate used
            to tick the box for you. It was there because the fold used to be reachable only under
            an encrypted scheme, so a reader with a certificate and no encryption had nowhere to
            start. That is not this panel any more — the box is one line above the fold, always on
            screen, always operable — and a fold that cannot be typed into while encryption is off
            cannot flip encryption on by being typed into. So setTls goes with it. */}
        <details className={styles.groupFold}>
          <summary>Encryption</summary>

          <fieldset className={styles.foldFields} disabled={!encrypted}>
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
          <PathField
            label="Extra CA certificate"
            id="caPath"
            kind="authority"
            placeholder="/path/to/ca.crt"
            value={form.caPath}
            onPath={(path) => set('caPath', path)}
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
            onPath={(path) => set('clientCertPath', path)}
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
              onPath={(path) => set('clientKeyPath', path)}
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
                    onChange={(e) => set('clientCertPassword', e.target.value)}
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
                  onChange={(e) => set('sniHost', e.target.value)}
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
                  onChange={(e) => set('alpnProtocol', e.target.value)}
                />
                <FieldError error={connectMutation.error} field="Tls.AlpnProtocol" />
              </Field>
            </div>
          </details>
          </fieldset>
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

      {/* Two things to do with a form: keep it, or use it. Disconnect is neither and stands with
          the link it would end, which is the block at the foot and only on screen when there is
          one.

          Keeping reads first and acting reads last, at the far end of the row. It was the other
          way round, the two of them together at the left, which put the smaller claim in the
          place a hand goes for the bigger one. */}
      <div className={styles.actions}>
        {/* Offered whatever is on screen, including over a live link: a broker worth keeping is
            most obviously worth keeping once it has connected. The name defaults to the address,
            which is what somebody with one broker would have typed anyway.

            The one button here that wears a mark. It is the quieter of the two and the only one
            whose word is a verb somebody could miss on a row they are scanning for Connect; the
            disk finds it without being read. Connect needs no such help — it is the filled one,
            and it is where the eye already went.

            One word, and the mark carries the rest. It read 'Save this broker' when it was the
            second button on a row that started at the left and had nothing to distinguish it but
            its own sentence. It is the left-hand button on its own row now, with a disk on it, in
            a panel whose every heading says Broker — so 'this broker' was the panel's name said a
            fourth time. The name box it opens says what is being saved anyway. */}
        {naming === null && (
          <button
            type="button"
            className={`ghost ${styles.iconButton}`}
            onClick={() => setNaming(from ?? `${form.host}:${form.port}`)}
          >
            <Save />
            Save
          </button>
        )}

        {attemptRunning && (
          <button
            type="button"
            className={`${styles.steadyWidth} ${styles.trailing}`}
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
          <button
            type="button"
            className={`${styles.steadyWidth} ${styles.trailing}`}
            onClick={submit}
          >
            Connect
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

      {/* What is up right now, at the foot of the panel, with the one button that ends it.

          It stood first for a while, on the reasoning that a panel reopened over a working
          connection was reopened to read it or to end it rather than to fill in a form. That is
          still true of why the panel was opened, and it was the wrong conclusion about where the
          block goes: the panel is read top to bottom as a form, and a block of facts in front of
          the first field is a paragraph between the reader and the thing they came to type in.
          The link is not asked for, it is reported — so it reads last, under everything the
          reader could do about it, which is where a footer goes.

          Not while the link is settling, which is the same beat the close waits out. Connecting
          to a broker that hangs up on the subscribe put this block on screen and took it off
          again inside 110ms — measured, 752px to 1077px to 874px — and a 325px block opening and
          shutting under the reader's eyes is the whole of what that felt like. A link that is not
          going to hold should move nothing at all. So through the settle the panel stays as it
          was mid-attempt, and at the end of it either the panel goes (the link held) or the
          failure appears (it did not).

          Which means this block is on screen only in the case it was written for: a panel opened
          over a link that was already up. That is not a transition, so nothing is settling.

          No `lead`: the block draws its own rule now, because it has the whole panel above it to
          be set apart from. */}
      {isOnline && !settling && (
        <div className={styles.live}>
          <ConnectionSummary />
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

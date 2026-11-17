import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatBrokerAddress, formatEndpoint } from './address';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import type { MqttTransport, RecentBroker, SavedConnection, SavedProfile } from '../../types/api';
import {
  deleteProfile,
  forgetRecentBroker,
  getRecentBrokers,
  getConnectionDefaults,
  getSavedProfiles,
  getSavedSettings,
  saveProfile,
} from '../../api/connection';
import { queryKeys } from '../../api/queryKeys';
import { useNow } from '../../lib/useNow';
import { useHubStatusStore } from '../../stores/hubStatusStore';
import { Chevron, Cross, Link, Plus, Save, Unlink } from '../brand/icons';
import { Field } from '../../components/Field';
import { PanelShell } from '../../components/PanelShell';
import { Segmented } from '../../components/Segmented';
import styles from '../../styles/panel.module.css';
import { useConnectionState } from '../../api/useConnectionState';
import { fieldError } from '../../lib/problemDetails';
import { logFault } from '../../stores/logStore';
import { useLinkWatchStore } from '../../stores/linkWatchStore';
import { useGuardedMutate } from '../../lib/useGuardedMutate';
import type { CertificateFileKind } from '../../api/connection';
import {
  containerHint,
  describeConnectFailure,
  describeFailureReason,
  wasAborted,
} from './connectFailure';
import { ConnectionSummary } from './ConnectionSummary';
import { AutoReconnectSwitch } from './AutoReconnectSwitch';
import { BrokerEvents } from './BrokerEvents';
import { ReconnectNotice } from './ReconnectNotice';
import { SavedBrokers } from './SavedBrokers';
import { RecentBrokers } from './RecentBrokers';
import { appendFilter, parseFilters, removeFilter } from '../subscribe/parseFilters';
import { useCertificateFile } from './useCertificateFile';
import { EVERYTHING, SYSTEM, useConnectionActions } from './useConnectionActions';
import {
  choiceOf,
  isEncrypted,
  isWebSocket,
  portFor,
  schemeForPort,
  schemeOf,
  SCHEMES,
  type Scheme,
} from './scheme';
import {
  applyAddress,
  buildConnectRequest,
  formFromSaved,
  sameConnection,
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

/**
 * How long a dial has to run before the panel counts it and says why it may be slow, in
 * milliseconds. 'Connecting to …' itself goes up on the press; this is for what is only worth
 * saying about a dial that has not answered yet.
 *
 * Measured against the brokers to hand: one on this machine answers in 1–10ms, one in a container
 * in 140, one across the internet in 190 — and that same broker over TLS in six seconds, which is
 * slow and perfectly healthy, since a certificate chain has to be fetched and verified before the
 * CONNECT can go. So the line has to clear the first group without coming anywhere near the
 * second. A second is five times the slowest connect that is over before a reader can look at it,
 * and it still leaves nineteen of the twenty a stalled dial runs for with the line up.
 */
export const SAY_AFTER = 1000;

/** The three sheets under the address, in the order the questions arrive. */
type SettingsGroup = 'client' | 'subscription' | 'encryption';

/** The two filters nearly everybody wants, and what each is in two words. */
const COMMON_FILTERS: ReadonlyArray<readonly [filter: string, what: string]> = [
  [EVERYTHING, 'all topics'],
  [SYSTEM, 'broker statistics'],
];

/** Whose word is taken for the broker's certificate. Exactly one of the three is true of a link. */
type Trust = 'system' | 'own' | 'any';

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
  subscriptions: EVERYTHING,
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
 *  - the form, which is the address and its button, and under them one line for each thing
 *    most connections never change — who is signing in, what to listen to, how the link is
 *    secured — each saying what it holds and opening where it stands;
 *  - the brokers the reader kept and the ones the console has reached, in a column beside it.
 *
 * The form is a single stack at every width, and centred in whatever the panel is given. It was
 * two columns for one release: the broker beside the client. The pair only held at the two
 * widest windows — under about 660px it stacked anyway — so the same panel read down one order
 * on a desktop and another on a laptop, and neither was the order anyone would say the questions
 * in. See .form and the measure in Workspace.module.css.
 *
 * Nearly nothing here explains itself. Every grey line under a field — what an empty WebSocket
 * path defaults to, what the seconds counted — has been taken out on purpose, and putting one
 * back is a decision rather than an improvement. What is left says something that has happened:
 * a field the API refused, and the sentence naming why a connect failed. Placeholders carry what
 * a box wants; the README carries what the fields are for.
 *
 * Two exceptions, each a decision. A list with no broker in it says what it will hold and what
 * a first connection is made of, and stops the moment there is a broker to list. And accepting
 * any certificate says what it gives up, in the one colour kept for a warning, because it is the
 * one setting here that makes a link less safe than it looks.
 */
export function BrokerPanel({ onClose }: { onClose: () => void }) {
  const [form, setForm] = useState(DEFAULTS);
  // The Address box's own text. Normally the host, the way in being the control to its
  // left and the port the one to its right — but the box takes a whole address too, and while
  // one is being typed this holds however much of it has arrived. Separate from the form because
  // a box built from it directly would have to be re-parsed on every keystroke, which is exactly
  // what splitting on the way out of the box exists to avoid.
  const [addressText, setAddressText] = useState(DEFAULTS.host);
  const addressRef = useRef<HTMLInputElement>(null);
  /**
   * What to listen to the moment the link is up, as the reader writes it: one filter to a line.
   *
   * It was two checkboxes — everything, and the broker's own statistics — and they are still the
   * first two lines of it, because those are the two answers nearly everybody wants and neither
   * should cost any typing. What they were not was a list: a reader who wanted three branches of
   * a plant and nothing else had to connect to everything first and narrow it afterwards, in
   * another panel, after the flood had already arrived.
   *
   * One list, and the boxes are a view of it rather than a second copy: a box is ticked when the
   * list holds its filter, ticking puts it in and unticking takes it out — so deleting '#' from
   * the list unticks the box by itself, which is the only way two controls over one fact can be
   * kept honest.
   *
   * Text rather than an array because it is what a textarea holds and a reader edits, and because
   * a list halfway through being typed is not a list of filters yet. `parseFilters` is the one
   * reading of it, and it is the same one the Filters panel's own box goes through.
   *
   * It lives in the form rather than beside it because it is saved with the rest of it: a reload,
   * and a saved broker, come back listening to what they were told to listen to.
   */

  /**
   * Which of the settings sheets under the address are open, if any.
   *
   * They are lines down the column now rather than tabs across one plate, and they open
   * independently: a username and a certificate are both part of one connection, and a reader
   * setting up both should not have one shut on them for opening the other. None is open until
   * somebody asks, because a bench broker needs nothing but the address. Pressing an open one
   * shuts it again.
   *
   * A refused client ID or ALPN protocol is exactly the kind of thing a saved broker carries
   * without anybody having opened the sheet to type it. So the sheet whose field the server named
   * opens itself, once, and the reader can shut it again — the line writes back, so it is their
   * answer either way.
   */
  const [openGroups, setOpenGroups] = useState<ReadonlySet<SettingsGroup>>(() => new Set());
  const toggleGroup = (group: SettingsGroup) =>
    setOpenGroups((open) => {
      const next = new Set(open);
      if (!next.delete(group)) next.add(group);

      return next;
    });
  const showGroup = (group: SettingsGroup) =>
    setOpenGroups((open) => (open.has(group) ? open : new Set(open).add(group)));

  /* Whether the record at the foot of the page is open. Held here rather than in the bar, because
     the bar is built again when the page changes face — a link coming up must not shut a record
     somebody opened to watch it come up — and not past this panel, because a panel opened again
     starts with the record shut. */
  const [recordOpen, setRecordOpen] = useState(false);

  // A filter on its way into the list: the box under the chips, as far as it has been typed.
  const [filterDraft, setFilterDraft] = useState('');

  /* 'Also trust my own CA', chosen but not yet given a path. The form holds no such state — an
     empty path is the system's authorities and nothing else — so without this the radio would
     spring back the moment it was pressed, before there was anywhere to type the path it asks
     for. The path a reader had, kept while they look at another answer, so coming back to this
     one does not cost them the longest thing they typed on the panel. */
  const [ownCa, setOwnCa] = useState(false);
  const caKept = useRef('');

  /* The secrets the saved broker under this form was last kept with, as far as this panel knows:
     nothing when it was filled from a card — the API never sends one back — and whatever was in
     the boxes when Save last succeeded. It is what 'edited' compares the two password boxes
     against, since the saved connection itself cannot be asked. */
  const [keptSecrets, setKeptSecrets] = useState({ password: '', clientCertPassword: '' });



  // The one reading of the list, and the same one the Filters panel's list goes through: lines and
  // commas both separate, and a filter written twice is one filter.
  const wanted = parseFilters(form.subscriptions);

  /** Puts a filter in the list or takes it out, which is the whole of what the two boxes do. */
  const askFor = (filter: string, on: boolean) =>
    set(
      'subscriptions',
      on ? appendFilter(form.subscriptions, filter) : removeFilter(form.subscriptions, filter),
    );
  // The name box, and whether it is on screen at all. Null is "not saving"; a string is the name
  // as far as it has been typed. Two states in one, because "empty box open" and "no box" are
  // different things and a boolean beside a string would let them disagree.
  const [naming, setNaming] = useState<string | null>(null);
  // Which saved broker the form was last filled from, so its chip can say so. Cleared by every
  // edit that moves the address, since after that the form is no longer that broker.
  const [from, setFrom] = useState<string | null>(null);
  const { data: saved } = useQuery({ queryKey: queryKeys.savedSettings, queryFn: getSavedSettings });

  // The client ID a fresh form suggests. It carries a suffix this install keeps, because MQTT
  // allows one client of a given ID on a broker at a time and every install used to offer the
  // same one — so two MQTTForges pointed at one broker took the link from each other, once a
  // second, for as long as both were running. Only ever applied to a form nobody has typed into
  // and that no saved broker has filled.
  const { data: defaults } = useQuery({
    queryKey: queryKeys.connectionDefaults,
    queryFn: getConnectionDefaults,
    staleTime: Infinity,
  });
  const { data: profiles } = useQuery({
    queryKey: queryKeys.savedProfiles,
    queryFn: getSavedProfiles,
  });

  /* Every broker this console reached, kept or not.
   *
   * Written by connecting rather than by pressing anything, so it is refetched whenever the panel
   * is shown again rather than trusted for the session: the link may have been put back by the
   * supervisor, or made from the phone the QR code opened, with nothing on this side pressed. */
  const { data: history } = useQuery({
    queryKey: queryKeys.recentBrokers,
    queryFn: getRecentBrokers,
  });

  const queryClient = useQueryClient();
  const refreshProfiles = () =>
    void queryClient.invalidateQueries({ queryKey: queryKeys.savedProfiles });
  const refreshHistory = () =>
    void queryClient.invalidateQueries({ queryKey: queryKeys.recentBrokers });

  const keepMutation = useMutation({
    mutationFn: ({ name, form: kept, id }: { name: string; form: BrokerForm; id?: string }) =>
      saveProfile(name, buildConnectRequest(kept), id),
    onSuccess: (_result, { name, form: kept }) => {
      setNaming(null);
      setFrom(name);
      setKeptSecrets({ password: kept.password, clientCertPassword: kept.clientCertPassword });
      refreshProfiles();
    },
    onError: (error) => logFault('Save failed', error),
  });

  const dropMutation = useMutation({
    mutationFn: forgetRecentBroker,
    onSuccess: refreshHistory,
    onError: (error) => logFault('Forget failed', error),
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

  useEffect(() => {
    if (fieldError(connectMutation.error, 'ClientId')) showGroup('client');
    else if (fieldError(connectMutation.error, 'Tls.AlpnProtocol')) showGroup('encryption');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectMutation.error]);
  const { state: linkState, isOnline, isConnecting, failure: faulted, link, answered, seenAt } =
    useConnectionState();
  /* Whether this console can reach its own server at all.
   *
   * The summary above already says so in a sentence — 'lost its own server … everything here is
   * the last thing it heard' — and the two controls under it went on offering to do things that
   * have to go through that server. Pressing Disconnect sent a request nothing was going to
   * answer: the button disabled itself for the wait and stayed disabled, because a fetch to a
   * server that accepts the connection and then says nothing does not fail, it waits. Said on the
   * control now, which is where somebody about to press it is looking. */
  const lostServer = useHubStatusStore((state) => state.status) === 'reconnecting';
  const guardedConnect = useGuardedMutate(connectMutation);
  const guardedDisconnect = useGuardedMutate(disconnectMutation);
  const guardedAbort = useGuardedMutate(abortMutation);

  // Two sources because they cover different gaps: isPending answers the instant this panel
  // fires, before the API has been asked anything; isConnecting is the only one a panel that
  // was closed when the attempt started — or reopened since — has to go on.
  const attemptRunning = isConnecting || connectMutation.isPending;
  /* Still reaching for the broker, as against still finishing a connect that has reached it.
     The mutation runs on past the broker's yes — the subscriptions go out inside it, which is
     seconds on a broker with a long list — and everything that said 'dialling' off the mutation
     alone went on saying it over a link that was up: the strip read 'Connecting to …' and then
     'Not connected', and Abort stood beside an address that was already answering, until the
     subscriptions were done and the panel finally caught up with the link. What the reader sees
     follows the link; `attemptRunning` still holds the close back until the connect is over. */
  /* And the failure the same way. The link reports Faulted over the hub the moment the broker
     refuses, and the request answers a beat later; in that beat the plate already said 'Nothing
     is listening at …' while the strip over it still said Connecting. A Faulted heard after this
     panel pressed Connect is this dial's answer, whatever the request is still doing — one heard
     before it is the last dial's, and does not count. */
  const dialFailed =
    connectMutation.isPending &&
    linkState === 'Faulted' &&
    seenAt !== undefined &&
    connectMutation.submittedAt > 0 &&
    seenAt >= connectMutation.submittedAt;
  const dialling = attemptRunning && !isOnline && !dialFailed;
  /* What the running attempt is aimed at, and when it started. `variables` is what this panel
     sent; the form is what a panel opened mid-dial has to go on, and the two agree in every case
     but that one. `submittedAt` is 0 until this panel fires, which is the same question asked
     the other way. */
  const dialled = connectMutation.variables?.request ?? form;
  const startedAt = connectMutation.submittedAt > 0 ? connectMutation.submittedAt : null;
  // A beat while a dial is running, which is the only thing on this panel that changes on its own.
  const now = useNow(attemptRunning ? 1000 : null);
  /* When this panel first saw a dial running, which is not always when the dial started: a panel
     opened over one already in progress knows only the second. It decides when to speak, and
     nothing else — the count below is drawn from the attempt's own instant or not at all. */
  const [sawDial, setSawDial] = useState<number | null>(null);
  useEffect(() => {
    if (!attemptRunning) {
      setSawDial(null);

      return;
    }

    setSawDial((first) => first ?? Date.now());
  }, [attemptRunning]);

  /* Said only once the dial has run long enough to be worth saying. A local broker answers inside
     ten milliseconds, and a line that appeared and went again in that time is a flicker on a
     panel where nothing went wrong. */
  const dialTakingTime =
    dialling && (startedAt ?? sawDial) !== null && now - (startedAt ?? sawDial)! >= SAY_AFTER;


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
    refill(formFromSaved(profile.connection));
    setFrom(profile.name);
  };

  /**
   * The form filled from somewhere else entirely: a card, or nothing.
   *
   * `settle`, and the two things that belong to the form that was there before and not to this
   * one — the secrets it was kept with, and a CA answer chosen but never given a path.
   */
  const refill = (next: BrokerForm) => {
    settle(next);
    setKeptSecrets({ password: '', clientCertPassword: '' });
    setOwnCa(false);
    caKept.current = '';
  };

  /**
   * A blank form, for a broker that is in neither list.
   *
   * The way out of a card somebody pressed to look at: without it the only way to stop editing
   * 'Plant floor' was to type over its address, and its username, filters and certificate came
   * along to whatever was typed. The client ID is this install's own, the same one a form nobody
   * has touched suggests.
   */
  const startNew = () => {
    refill({ ...DEFAULTS, clientId: defaults?.clientId ?? DEFAULTS.clientId });
    setFrom(null);
    setNaming(null);
    addressRef.current?.focus();
    addressRef.current?.select();
  };

  /**
   * One out of the history, into the form.
   *
   * The same fill as a saved broker's, and no name set: these cards have none. `settle` keeps a
   * saved card's ring only if that saved broker is still at the address now in the form — so
   * picking the history row of a broker that is also kept leaves the kept one marked as well, which
   * is true. The history card says it is the one in the form by its own fields — see `heldFrom`.
   */
  const useReached = (broker: RecentBroker) => refill(formFromSaved(broker.connection));


  /**
   * The two answers, put back together into the one thing the API is told.
   *
   * `Scheme` stays the form's own shape, every other part of the panel being written against it,
   * and this is where a way in — one of the four in the box at the head of the address — meets
   * it again.
   *
   * The answer moves the port with it, but only when the port on screen is the one the old
   * combination filled in by itself — see portFor. The path stays where it is: going from ws to
   * wss is the commonest change of the four and keeps the same path, and a path typed under TCP
   * is dropped on the way out rather than saved against a connection that never used it.
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

  /* A link that came up wrote a row in the history, whoever made it — this panel's Connect, the
     desktop window's, or the supervisor putting one back after an outage. Watched on the state
     rather than hung off this panel's own mutation for exactly that reason. */
  useEffect(() => {
    if (isOnline) refreshHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOnline]);

  // onClose is rebuilt on every render of the console, so the timer below cannot depend on it
  // without being restarted by renders that have nothing to do with the link — which is a timer
  // that never fires.
  const closer = useRef(onClose);
  useEffect(() => {
    closer.current = onClose;
  });

  /**
   * Whether this panel is one the reader opened, or one a fault opened for them.
   *
   * The difference decides the close above. A panel the reader asked for has done its job when
   * the link comes up and steps aside, which is right for a form they have just finished with. A
   * panel a fault opened is not that: they never asked for it, so closing it "back" the moment
   * the supervisor succeeds would take the answer away at the exact moment it arrived — the link
   * went, and came back, and the reader would be left with no sign that either happened.
   *
   * So a fault-opened panel stays, and what it shows instead is ReconnectNotice's 'back' face:
   * what broke the link, how long it was gone, and that it is up again.
   */
  const openedByFault = useLinkWatchStore((watch) => watch.openedByFault);

  /**
   * Whether the notice at the foot is up, in which case the red line under the form is not.
   *
   * Both read the same link, and on a dropped link they would say two things a few lines apart:
   * the notice names what broke the link, and the line names what the latest retry ran into,
   * which after a rung or two is a different sentence about the same outage. Two sentences read
   * as two things having gone wrong. The notice wins, because it is the one that also says what
   * is being done; and it wins outright rather than only when the words match, because the
   * words stop matching the moment the ladder makes its second try.
   */
  const noticeUp = useLinkWatchStore(
    (watch) => watch.droppedAt !== null || watch.recoveredAt !== null,
  );

  useEffect(() => {
    // Not while the attempt is still running. The connect is not over when the broker says yes:
    // the subscription this console asks for on connect goes out inside the same mutation, and a
    // panel that stepped aside before the answer would leave a 'Subscribe failed' line to land
    // on a screen the reader had already been sent away from.
    if (!settling || attemptRunning) return;

    const held = setTimeout(() => {
      // The beat ends whatever comes of it, and this line is the whole of that. It used to end
      // only by the panel closing, which was true for as long as closing was the only thing that
      // could happen next — and stopped being true the moment a fault-opened panel was allowed to
      // stay. Left latched, `settling` held `live` false over a link that was up, so the reader
      // got the form back under a notice saying the link had come back.
      setSettling(false);

      // And the close, which is a different question: whether this panel was the reader's to
      // begin with.
      if (!openedByFault) closer.current();
    }, SETTLE);

    return () => clearTimeout(held);
  }, [settling, attemptRunning, openedByFault]);

  // Arrives after first render; neither password is ever returned by the API.
  useEffect(() => {
    if (!saved) return;

    settle(formFromSaved(saved));
  }, [saved]);

  // ...and if there is nothing saved, the client ID this install suggests. Only over the shipped
  // stem, so a reader who has typed their own — or a saved broker that filled the box — is never
  // overwritten by an answer that arrived a beat later.
  useEffect(() => {
    if (!defaults?.clientId) return;

    setForm((current) =>
      current.clientId === DEFAULTS.clientId ? { ...current, clientId: defaults.clientId } : current,
    );
  }, [defaults]);

  // Where a reader who opened this panel is going to type first. Not over a live link: that
  // panel was opened to read the summary or to end the connection, and a cursor in a box the
  // reader is not filling in is a cursor in the way.
  //
  // Once, on the way in. `answered` is what makes that possible to say: before the API answers,
  // isOnline is a guess, and focusing on a guess means focusing and then taking it away.
  /**
   * Closing by hand ends the hold a fault had on this panel.
   *
   * Without it, a reader who read the notice and shut the panel would find it reopening itself
   * at the next thing that touched the link — the hold is what suppresses the auto-close, and a
   * hold nobody ever released would outlast the outage it was about.
   */
  const releaseThenClose = () => {
    useLinkWatchStore.getState().released();
    onClose();
  };

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
  /**
   * Whether this panel is reporting a link or asking for one. They are two different panels.
   *
   * Over a live link there is nothing to fill in: the settings that produced the link are not a
   * question any more, they are a fact, and a form holding them is an invitation to edit fields
   * that cannot take effect until the connection is torn down. So the form goes and the summary
   * takes the panel — which is also the only way a reader can tell, at a glance, which of the two
   * states they are looking at.
   *
   * Not while it is settling, which is the beat the auto-close waits out. A broker that takes the
   * connection and hangs up a moment later would otherwise swap the whole panel for a summary and
   * swap it back inside 300ms, and the reader would be left looking at the form they started with
   * wondering what they had just seen.
   */
  const live = isOnline && !settling;

  /* Every broker this console has reached, the saved ones included.
   *
   * A record of where the console has been, and a broker being kept is no reason to leave it out
   * of that: the list underneath answers "which brokers did I name", this one "which did I use,
   * and when". The server keeps each broker in it once, at its latest connection. */
  const reached = history ?? [];

  /* Which history card, if any, is what the form is holding. The saved list answers this with a
     name it was filled from; these have no names, so it is asked of the fields themselves. */
  const heldBroker = reached.find((broker) => sameConnection(form, formFromSaved(broker.connection)));
  const heldFrom = heldBroker?.id ?? null;

  /* The saved broker the form was filled from, while the form is still at its address. */
  const picked = from ? profiles?.find((one) => one.name === from) : undefined;

  /* Whether the form has moved away from the saved broker it was filled from: any field but the
     address, which makes it another broker and is `settle`'s question. The two password boxes are
     compared with what this panel last saved rather than with the broker, which cannot be asked. */
  const edited =
    picked !== undefined &&
    (!sameConnection(form, formFromSaved(picked.connection)) ||
      form.password !== keptSecrets.password ||
      form.clientCertPassword !== keptSecrets.clientCertPassword);

  /**
   * Whether saving over the picked broker would throw away a secret it holds.
   *
   * The API never sends a password back, so a form filled from a card has both boxes empty —
   * and a profile is saved as exactly what the form holds. Saving that form over the broker it
   * came from would write the broker back without the password it was kept with, and the first
   * the reader would hear of it is the broker refusing them next morning. So the one-press save
   * is not offered until the box has been filled in again; Save as, which asks for a name and
   * can be pointed elsewhere, is still there.
   */
  const dropsSecret =
    picked !== undefined &&
    ((picked.connection.hasPassword && !!form.username && form.password === '') ||
      (picked.connection.tls?.hasClientCertificatePassword === true &&
        form.clientCertPath.trim() !== '' &&
        form.clientCertPassword === ''));

  /* How many brokers this console knows, once both lists have answered — and whether that is
     none, which is the one state the panel explains itself in. Null until then: a list that has
     not answered yet is not an empty list, and saying so for a frame would put the first-run
     words in front of a reader with a dozen brokers. */
  const known = profiles === undefined || history === undefined ? null : profiles.length + reached.length;
  const firstRun = known === 0;

  const kept = profiles ?? [];

  /* A beat under the history's '3 hours ago', slow enough to be free and quick enough that a
     panel left open does not go on saying 'just now' into the afternoon. */
  const historyNow = useNow(reached.length > 0 ? 60_000 : null);

  const attempted = connectMutation.variables?.request;

  // The reader pressed Connect and it failed. That sentence is theirs whatever else is on the
  // panel: with an outage notice up it used to be hidden along with the outage's own line — and
  // a reader who dialled a second broker mid-outage and was refused saw nothing about it at all.
  const ownAttemptFailed = connectMutation.isError;

  /* The last thing this panel did, said once.
   *
   * `describeConnectFailure` refuses to speak about an attempt the reader called off — they know
   * what happened and nothing went wrong — and without the second line here the standing failure
   * underneath took its place. A dial called off leaves the link exactly where it found it, so on
   * a second try after a failed first one that is the FIRST attempt's red line, reappearing at
   * the instant Abort was pressed and reading as though the abort had caused it. Nothing on
   * screen from a dial nobody completed; the record keeps both attempts, in order, with the
   * words for each. */
  const failure = wasAborted(connectMutation.error)
    ? undefined
    : (attempted && describeConnectFailure(connectMutation.error, attempted)) ??
      (faulted && describeFailureReason(faulted.reason, faulted));

  /**
   * Whether an empty password box will be answered by the one already saved.
   *
   * The API never sends a password back, so the box comes up empty whenever the form is filled
   * from what was saved — and a reader who pressed Disconnect and Connect again used to be told
   * their password was wrong about one they had never typed. The server now keeps the stored
   * password for the same broker and the same user (see ConnectionService), and this is the box
   * saying so rather than the reader having to find out by pressing Connect.
   */
  const passwordKept =
    saved?.hasPassword === true &&
    !!form.username &&
    saved.username === form.username &&
    saved.host === form.host &&
    saved.port === form.port;

  const certificatePasswordKept =
    saved?.tls?.hasClientCertificatePassword === true &&
    !!form.clientCertPath &&
    saved.tls?.clientCertificatePath === form.clientCertPath;

  const encrypted = isEncrypted(form.scheme);
  const overWebSocket = isWebSocket(form.scheme);
  // A certificate names the two fields that go with it. Until there is one, a key and a password
  // are fields for a file that does not exist.
  const clientCert = form.clientCertPath.trim();
  // A .pfx carries its own key. Asking for one beside it is asking for a file nobody has.
  const bundled = /\.(pfx|p12)$/i.test(clientCert);
  const sessionKept = !form.cleanSession;

  /* Which of the three answers about the broker's certificate the form is giving. Read off the
     form, so a saved broker that carries a CA comes back with the middle one chosen; `ownCa` only
     holds that answer open between choosing it and typing the path it asks for. */
  const trust: Trust = form.allowUntrusted
    ? 'any'
    : ownCa || form.caPath.trim() !== ''
      ? 'own'
      : 'system';

  /**
   * One of the three, chosen.
   *
   * 'System' means no path at all, so it takes the path out of the form — and keeps it here, so
   * a reader who looked at the first answer and came back to the second finds what they typed.
   * 'Any' leaves the path where it is: the server ignores it while nothing is being checked, and
   * it is still there when checking is turned back on.
   */
  const pickTrust = (next: Trust) => {
    if (form.caPath.trim() !== '') caKept.current = form.caPath;
    setOwnCa(next === 'own');
    setForm((current) => ({
      ...current,
      allowUntrusted: next === 'any',
      caPath:
        next === 'system'
          ? ''
          : next === 'own' && current.caPath.trim() === ''
            ? caKept.current
            : current.caPath,
    }));
  };

  /* What is in the box under the chips, into the list: one filter, or several separated the way
     the Filters panel's own box separates them. */
  const addFilters = () => {
    set('subscriptions', parseFilters(filterDraft).reduce(appendFilter, form.subscriptions));
    setFilterDraft('');
  };

  const set = <K extends keyof BrokerForm>(key: K, value: BrokerForm[K]) =>
    setForm((current) => ({ ...current, [key]: value }));


  // The box's text is reconciled here rather than relied on to have been reconciled by the blur.
  // A pure function called from both places means there is no ordering of events in which the
  // box shows one broker and the attempt goes to another.
  const submit = () => {
    const resolved = applyAddress(form, addressText);
    settle(resolved);
    guardedConnect({ request: ownedBy(resolved, from), filters: wanted });
  };

  /**
   * The request for a form, carrying the saved broker it was filled from.
   *
   * Which broker it is decides which colour and alert rules apply once the link is up, so it goes
   * with the connect. Asked of the form being sent rather than read off `from`: `settle` lets go of
   * the name only on the next render, and an address typed over a saved broker's is not that
   * broker any more by the time this one is sent.
   */
  const ownedBy = (next: BrokerForm, name: string | null) => {
    const request = buildConnectRequest(next);
    const profile = name && matches(next, name) ? profiles?.find((one) => one.name === name) : undefined;

    return profile ? { ...request, profileId: profile.id } : request;
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

    // Over a live link, what is saved is the link. The form is a draft on that face — the reader
    // may have typed an address during an outage and never pressed Connect, and the ladder may
    // have brought the old broker back underneath it — so saving the form kept a broker nobody
    // had connected to, under a name taken from the one they had.
    if (live && saved) {
      keepMutation.mutate({ name, form: formFromSaved(saved) });
      return;
    }

    const resolved = applyAddress(form, addressText);
    settle(resolved);
    keepMutation.mutate({ name, form: resolved });
  };

  /**
   * What was changed, kept under the name it already has.
   *
   * The same save as the name box makes, without the box: the name is not in question, and
   * asking for it again made 'I changed the filters on Plant floor' a three-step job that ended
   * on a button offering to overwrite something.
   */
  const saveChanges = () => {
    if (!picked || dropsSecret) return;

    const resolved = applyAddress(form, addressText);
    settle(resolved);
    // By its id as well as its name: the id is what its colour and alert rules hold it by.
    keepMutation.mutate({ name: picked.name, form: resolved, id: picked.id });
  };

  /* The broker the form is holding, forgotten: the saved one if it came from the saved list, the
     history's row otherwise. One button for both, because to the reader it is one question —
     'not this one any more' — asked about whatever is named over the form. */
  const forget = () => {
    if (from) forgetMutation.mutate(from);
    else if (heldFrom) dropMutation.mutate(heldFrom);
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

  /**
   * The name, asked for where the button was rather than in a dialog over the form: the reader is
   * naming what they are looking at, and a box that covers it is a box that makes them remember it
   * instead.
   *
   * Held in a variable rather than written where it renders, because Save is offered on both of
   * this panel's two faces — a broker is most obviously worth keeping once it has connected — and
   * a second copy of this box would be a second set of answers to the same three questions.
   */
  const nameBox = naming !== null && (
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
                if (e.key !== 'Escape') return;

                // And no further: the window stack closes its topmost floating window on the
                // same key, so backing out of this box was also destroying a pinned chart.
                e.stopPropagation();
                setNaming(null);
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
            <button type="button" onClick={() => setNaming(null)}>
              Cancel
            </button>
          </div>
        </div>
    );

  /**
   * The panel over a live link: what is up, and the two things to do about it.
   *
   * A separate return rather than a conditional threaded through the one below, because these are
   * two panels and not one panel with parts hidden. The form is four hundred lines of question,
   * every one of which is already answered — and answered by the connection itself, which is what
   * the summary reports. Wrapping it all in `{!live && …}` would leave the two faces sharing a
   * shape neither of them wants and re-indent the whole file to say so.
   *
   * What a reader can still do here is keep this broker — the moment it has connected is the
   * moment it is most obviously worth keeping — and end the link. Nothing else on this panel is
   * about a connection that already exists.
   */
  /* Whether the sentence about a failed attempt is on screen. One reading, because two places
     follow it: the sentence itself, and the tone of the plate and the strip it stands in. */
  const failureShown = failure && (!noticeUp || ownAttemptFailed);

  /* What the link column is saying, as a tone: a dial that has gone on long enough to be worth
     saying, a failure, or neither. The strip at the head of the column and the plate under it
     wear the same one, so the state is read in one place and coloured in one place. */
  const tone = isOnline
    ? 'live'
    : dialling
      ? 'dial'
      : failureShown
        ? 'fault'
        : undefined;

  /* A card's arrow: fill the form from it and dial, in one press. The form is filled too, rather
     than the request sent behind its back, so what is on screen is always what was tried. */
  const dial = (next: BrokerForm, name: string | null = null) => {
    refill(next);
    guardedConnect({ request: ownedBy(next, name), filters: parseFilters(next.subscriptions) });
  };

  /* What each sheet holds, in a few words. It is the line's description: read out after its name
     to anything reading the page, and not drawn. It was drawn beside the name once, and a line
     that reads 'SIGN-IN  anonymous · mqttforge-console-7f3a' is a row of a report rather than
     something to press — the name alone is the heading it is. */
  const says: Record<SettingsGroup, string> = {
    client: `${form.username.trim() || 'anonymous'} · ${form.clientId.trim() || 'no client ID'}`,
    subscription:
      wanted.length === 0
        ? 'nothing on connect'
        : wanted.length <= 2
          ? wanted.join(', ')
          : `${wanted.slice(0, 2).join(', ')} +${wanted.length - 2}`,
    encryption: !encrypted
      ? 'off'
      : `${form.allowUntrusted ? 'any certificate' : form.caPath.trim() ? 'extra CA' : 'system CAs'}${
          clientCert ? ' · client certificate' : ''
        }`,
  };

  /* The brokers this console knows, as a column of its own down the left of the page: kept ones
     first, then the ones it has reached. They were behind a tab on a rail, shut until asked for;
     but picking a broker is the commonest way anybody starts here, and a list that has to be
     opened before it can be pressed is two presses for the one thing most visits are for.

     The column picks and dials, and that is all it does. Keeping a broker and forgetting one are
     at the head of the form, about the broker the form is holding. New stands at the column's
     head because it is the other thing a list offers: none of these. */
  const brokersColumn = (
    <aside className={`${styles.linkCol} ${styles.brokersCol}`} aria-label="Brokers">
      <div className={styles.colHead}>
        <h3 className={styles.colTitle}>Brokers</h3>
        {!firstRun && (
          <button
            type="button"
            className={`${styles.iconButton} ${styles.colAction}`}
            onClick={startNew}
          >
            <Plus />
            New
          </button>
        )}
      </div>
      <div className={styles.colBody}>
        <div className={styles.library}>
          {kept.length > 0 && (
            <div className={styles.saved}>
              <h3 className={styles.savedTitle}>
                Saved
                <span className={styles.savedCount} aria-hidden="true">{` · ${kept.length}`}</span>
              </h3>
              <SavedBrokers
                profiles={kept}
                active={from}
                onPick={usePicked}
                onConnect={
                  attemptRunning
                    ? undefined
                    : (profile) => {
                        dial(formFromSaved(profile.connection), profile.name);
                        setFrom(profile.name);
                      }
                }
              />
            </div>
          )}
          {reached.length > 0 && (
            <div className={styles.saved}>
              {/* One word. The panel's own head says BROKER across the top of it, so 'Recent brokers'
                  and 'Saved brokers' said the panel's name twice more to make two headings out of
                  two words — the same reasoning that took 'Broker events' down to 'Events'.
                  The count beside it is for the eye alone: read out, the list says how many it
                  holds by being read. */}
              <h3 className={styles.savedTitle}>
                Recent
                <span className={styles.savedCount} aria-hidden="true">{` · ${reached.length}`}</span>
              </h3>
              <RecentBrokers
                brokers={reached}
                active={heldFrom}
                onPick={useReached}
                onConnect={attemptRunning ? undefined : (broker) => dial(formFromSaved(broker.connection))}
                now={historyNow}
              />
            </div>
          )}

          {/* Nothing kept and nothing reached: the one state in which this column says what it is
              for. Three steps because a first connection is three things, in this order — and
              each names the control it means by the word that is on it. */}
          {firstRun && (
            <div className={styles.firstRun}>
              <p className={styles.firstRunLead}>No brokers yet</p>
              <p className={styles.note}>
                Every broker you connect to is listed here. Save keeps one under a name.
              </p>
              <h3 className={styles.savedTitle}>First connection</h3>
              <ol className={styles.steps}>
                <li>
                  <span>
                    Enter the broker’s address, or paste a whole one such as{' '}
                    <code>mqtts://user@host:8883</code> and it is split for you.
                  </span>
                </li>
                <li>
                  <span>
                    Press Connect. The console subscribes to <code>#</code> and lists every topic
                    the broker carries.
                  </span>
                </li>
                <li>
                  <span>Save it under a name. Next time it is one press from this list.</span>
                </li>
              </ol>
            </div>
          )}
        </div>
      </div>
    </aside>
  );

  /* The record of what the link has done, as a bar across the foot of the page under the
     other columns, shut until it is pressed. As a third column it took a fixed share of every
     width for a list most visits never read; at the foot it is one line that says how much there
     is and what happened last, and opens upwards when somebody wants the rest. */
  const eventsColumn = (
    <aside className={`${styles.linkCol} ${styles.eventsCol}`}>
      <BrokerEvents docked expanded={recordOpen} onExpanded={setRecordOpen} />
    </aside>
  );

  if (live) {
    return (
      <PanelShell title="Broker" named onClose={releaseThenClose}>
        {/* The same page as the form's, less the column of brokers: picking one fills a form
            that is not on screen while a link is up. The link's column and the record's keep
            their places, so the page does not rearrange itself around a connection. */}
        <div className={styles.spread} data-face="live">
        <div className={styles.linkPage}>
        <div className={styles.linkCol}>
          <div className={styles.colHead} data-tone="live">
            <h3 className={styles.colTitle}>Link</h3>
          </div>
          <div className={styles.colBody}>
          <div className={styles.live}>
            <ConnectionSummary lead />
            <div className={styles.actions}>
              <button
                type="button"
                className={styles.iconButton}
                onClick={() =>
                  setNaming(
                    from ??
                      (link ? formatEndpoint(link.host, link.port) : formatEndpoint(form.host, form.port)),
                  )
                }
              >
                <Save />
                Save
              </button>
              <button
                type="button"
                className={`ends ${styles.iconButton} ${styles.trailing}`}
                onClick={() => guardedDisconnect()}
                disabled={disconnectMutation.isPending || lostServer}
                title={
                  lostServer
                    ? 'The console cannot reach its own server, so it cannot end the link either.'
                    : undefined
                }
              >
                <Unlink />
                Disconnect
              </button>
            </div>
            {nameBox}
          </div>
          <ReconnectNotice />
          </div>
        </div>
        {eventsColumn}
        </div>
        </div>
      </PanelShell>
    );
  }

  /* What the form is holding, in a name and a word. A saved broker by the name it was kept under;
     one out of the history by its address, which is the only name it has; anything else is a
     connection nobody has made yet. */
  const subjectName = from ?? (heldBroker ? formatEndpoint(form.host, form.port) : 'New connection');
  const subjectTag = from ? (edited ? 'Edited' : 'Saved') : heldBroker ? 'Recent' : 'Not saved';

  /* Whether the dial that is running is an encrypted one. `dialled` is the request this panel
     sent, or the form when the dial was started somewhere else, and the two say it differently. */
  const dialEncrypted = 'useTls' in dialled ? dialled.useTls : isEncrypted(dialled.scheme);

  /* What the address means here, said before the attempt rather than after it — but only to a
     reader with no broker yet, who has nothing to compare 'localhost' against. Once the attempt
     has failed the sentence is part of the failure, and this one would say it twice. */
  const starter = firstRun && !failureShown ? containerHint(form.host, defaults?.inContainer) : undefined;

  return (
    <PanelShell title="Broker" named onClose={releaseThenClose}>
      {/* Three columns across the page, each under a strip of the same height: the brokers this
          console knows, the link, and the record of what the link has done. Under about 900px
          they stand one over another in that order, which is the order the questions arrive in.

          The link's strip says what the link is doing, and the plate under it holds the address
          and the one button that changes it: Connect, Abort while a dial runs, and on the live
          face Disconnect. One place to look and one place to press, at every state. */}
      <div className={styles.spread}>
      <div className={styles.linkPage}>
      {brokersColumn}
      <div className={styles.linkCol}>
        <div className={styles.colHead} data-tone={tone}>
          <h3 className={styles.colTitle}>Link</h3>
          <span className={styles.colLamp} aria-hidden="true" />
          {/* From the press, not a second after it: the strip is the first place the eye goes after
              Connect, and a second of 'Not connected' under a button just pressed read as a press
              that had not taken. The count is what waits — under a second it only ever says 0s. */}
          {dialling && (
            <p className={styles.colSays} data-testid="dialling" role="status">
              Connecting to {formatEndpoint(dialled.host, dialled.port)}
              {dialTakingTime &&
                startedAt !== null &&
                ` · ${Math.max(0, Math.round((now - startedAt) / 1000))}s`}
            </p>
          )}

          {/* Off the link itself, so the strip says Connected the moment the broker does — the form
              stays on screen for the beat the connect takes to finish, and a strip saying 'Not
              connected' over it was the panel contradicting the link it was watching. */}
          {isOnline && (
            <p className={styles.colSays} role="status">
              Connected{link ? ` to ${formatEndpoint(link.host, link.port)}` : ''}
            </p>
          )}
          {/* What went wrong, in the place that says what the link is doing — it stood in red at
              the head of the plate under a strip saying 'Not connected', two lines about one
              thing, and the strip caught up with the sentence a beat after it. One line now,
              changed in one step. */}
          {!isOnline && !dialling && failureShown && (
            <p className={styles.colSays} role="alert">
              {failure}
            </p>
          )}
          {!isOnline && !dialling && !failureShown && (
            <p className={styles.colSays}>Not connected</p>
          )}
        </div>
        <div className={styles.colBody}>
      {/* Which broker this is, over the form that describes it, with the three things that can be
          done to a broker as a thing: keep what was changed, keep it under a name, forget it.
          They stood in the list — a Save at its head and a × on every card — which put saving a
          column away from what was being saved and forgetting a few pixels from connecting. */}
      <div className={styles.subject}>
        <h4 className={styles.subjectName}>{subjectName}</h4>
        <span className={styles.subjectTag} data-tone={edited ? 'warn' : undefined}>
          {subjectTag}
        </span>
        <div className={styles.subjectActions}>
          {edited && (
            <button
              type="button"
              className={styles.iconButton}
              onClick={saveChanges}
              disabled={dropsSecret || keepMutation.isPending}
              title={
                dropsSecret
                  ? 'Type the password again first: a saved one is never sent back, so saving now would lose it.'
                  : undefined
              }
            >
              <Save />
              Save changes
            </button>
          )}
          {naming === null && (
            <button
              type="button"
              className={`ghost ${styles.iconButton}`}
              onClick={() => setNaming(from ?? formatEndpoint(form.host, form.port))}
            >
              <Save />
              Save as…
            </button>
          )}
          {(from !== null || heldBroker !== undefined) && (
            <button
              type="button"
              className="ghost ends"
              aria-label={`Forget ${from ?? endpointOf(heldBroker!.connection)}`}
              onClick={forget}
              disabled={forgetMutation.isPending || dropMutation.isPending}
            >
              Forget
            </button>
          )}
        </div>
      </div>
      {nameBox}

      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
      <div className={styles.form} onKeyDown={onEnter}>
        <section className={styles.plate} data-tone={tone}>
          {/* No heading of its own. The lines that follow say their names on the line you press;
              this one is what the page opens on, and the page says BROKER across the top of
              itself — see PanelShell's band. A second BROKER here, a centimetre under the first
              and in the same voice, named nothing that was not already named.
              The address, because it is the only thing the reader actually has. Labelled with
              the half of its name the band above does not already say — BROKER over BROKER
              ADDRESS put the same word on screen twice, in two different voices, one line apart. */}
          <div className={styles.dialRow}>
            <Field label="Address" htmlFor="address">
              {/* One bar, the way an address is one thing: the way in, the host and the port, in
                  the order a URL writes them. The port gave up its own label over the box for the
                  colon that stands in front of it in every address; it is still named Port to
                  anything that reads it out.

                  The way in is one box of four, where a scheme stands in a URL. It was a box of
                  two and a tick under it — mqtt against mqtts as two questions the reader had to
                  know multiplied — and then four chips on a line of their own over the bar, which
                  said it plainly and cost a line to say it. Four in one box says it in the room
                  the scheme already had: each is written with the `://` it carries in an address,
                  and choosing one moves the port the way pasting an address with it would. */}
              <div className={`${styles.addressLine} ${styles.dialBar}`}>
                <select
                  id="scheme"
                  aria-label="Protocol"
                  value={form.scheme}
                  onChange={(e) => {
                    const choice = choiceOf(e.target.value as Scheme);
                    pickWay(choice.transport, choice.useTls);
                  }}
                >
                  {SCHEMES.map((choice) => (
                    <option key={choice.scheme} value={choice.scheme}>
                      {`${choice.scheme}://`}
                    </option>
                  ))}
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
                <span className={styles.dialColon} aria-hidden="true">
                  :
                </span>
                <input
                  id="port"
                  type="number"
                  aria-label="Port"
                  className={styles.dialPort}
                  value={form.port}
                  onChange={(e) => set('port', Number(e.target.value))}
                  // On the way out, for the same reason the address box splits on the way out: a
                  // number halfway through being typed is not a number. See schemeForPort.
                  onBlur={() => settle({ ...form, scheme: schemeForPort(form.scheme, form.port) })}
                />
              </div>
              {/* Keyed on Host, which is what the API calls what this box holds. */}
              <FieldError error={connectMutation.error} field="Host" />
              <FieldError error={connectMutation.error} field="Port" />
            </Field>

            {/* The button the panel exists for, beside the address it uses rather than at the foot
                of a form most connections never open. Absent over a live link rather than greyed:
                the one button on screen while a link is up is the one that ends it. */}
            {dialling && (
              <button
                type="button"
                className={`ends ${styles.iconButton} ${styles.dialButton}`}
                onClick={() => guardedAbort()}
                disabled={abortMutation.isPending}
              >
                <Cross />
                <span className={styles.steadyLabel}>Abort</span>
              </button>
            )}
            {!dialling && !isOnline && (
              <button
                type="button"
                className={`${styles.iconButton} ${styles.dialButton}`}
                onClick={submit}
              >
                <Link />
                <span className={styles.steadyLabel}>Connect</span>
              </button>
            )}
          </div>

          {/* Under the address, on one line: the path a WebSocket asks for, when the way in is
              one — the one part of a WebSocket address most brokers never need said — and what
              the console does if the link goes. The second was a line of its own among the
              settings, with a name over it; it is one tick, it takes effect the moment it is
              pressed, and a tick with its own words beside it needs no heading to say them
              again. */}
          <div className={styles.dialOptions}>
            {overWebSocket && (
              <div className={styles.dialPath}>
                <label htmlFor="webSocketPath">WebSocket path</label>
                <input
                  id="webSocketPath"
                  type="text"
                  value={form.webSocketPath}
                  placeholder="/mqtt"
                  onChange={(e) => set('webSocketPath', e.target.value)}
                />
              </div>
            )}
            <AutoReconnectSwitch id="brokerAutoReconnect" />
          </div>

          {/* Slow is not the same as stuck, and over TLS a healthy dial can be slow: the chain is
              fetched and checked before the CONNECT goes. Said only once the dial has run long
              enough for somebody to wonder, and only about a dial it is true of. */}
          {dialTakingTime && dialEncrypted && (
            <p className={styles.note}>
              Over TLS the broker’s certificate is checked before anything else is sent, which can
              take several seconds.
            </p>
          )}

          {starter && (
            <p className={styles.note}>
              {starter}{' '}
              <button
                type="button"
                className={`ghost ${styles.starter}`}
                onClick={() => settle({ ...form, host: 'host.docker.internal' })}
              >
                Use host.docker.internal
              </button>
            </p>
          )}
        </section>

        {/* The settings most connections never open, one to a line down the column rather than
            three tabs across one plate. Each line says what it holds, so a reader can tell there
            is a username behind one or a certificate behind another without opening either, and
            opens where it stands. Disclosure buttons rather than ARIA tabs, because none open is
            the usual answer and a tab list always has one chosen. */}
        <div className={styles.sheets}>

        {/* Everything that says who is connecting: the name and password the broker asks for,
            the ID it files the session under, and whether that session survives the link going.
            'User' named half of it — a clean session is not a fact about a username — and the
            half it left out is the half that is keyed on the ID sitting in the same fold.

            A fold, like the two under it: most brokers on a bench want none of this, an anonymous
            listener takes an address and nothing else, and a client ID the console invents for
            itself is an answer rather than a question. */}
        <Sheet
          name="Sign-in"
          id="brokerSheetClient"
          says={says.client}
          open={openGroups.has('client')}
          onToggle={() => toggleGroup('client')}
        >
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
                placeholder={passwordKept ? 'kept' : 'optional'}
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

          {/* Two answers side by side rather than one box to untick. 'Clean session' unticked
              left the reader to work out what the other state was called; it is called keeping
              the session, and it is the one that has a number to go with it. */}
          <Segmented
            label="Session"
            name="brokerSession"
            options={SESSIONS}
            value={form.cleanSession ? 'clean' : 'kept'}
            onChange={(session) => set('cleanSession', session === 'clean')}
          />

          {/* Keeping the session is what makes its lifetime a question at all. Offered under Auto
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
        </Sheet>

        {/* What the console should be listening to the moment the link is up, which is a question
            about the connection and belongs with the ones that make it.

            One list, drawn as the things in it. The two answers nearly everybody wants are ticks
            — a tick is on when the list holds its filter, and pressing it puts the filter in or
            takes it out — and every other filter is a chip with its own way out. It was two tick
            boxes over a text box behind a fold, and a reader who wanted three branches of a plant
            had to find the fold before they could find out the list was theirs to write. */}
        <Sheet
          name="Topics on connect"
          id="brokerSheetSubscription"
          says={says.subscription}
          open={openGroups.has('subscription')}
          onToggle={() => toggleGroup('subscription')}
        >
          <div className={styles.topics} role="group" aria-label="Subscribed on connect">
            {/* $SYS is its own tick because it is its own SUBSCRIBE: a filter that begins with a
                wildcard is not allowed to match a topic that begins with '$', so a console
                listening to everything is still blind to what the broker says about itself. Off
                by default, and the reason is the traffic rather than the value — these are
                republished on a timer, so a reader who did not ask would find a subtree they
                never subscribed to churning through their log all day. */}
            {COMMON_FILTERS.map(([filter, what]) => (
              <label key={filter} className={styles.topicToggle}>
                <input
                  type="checkbox"
                  checked={wanted.includes(filter)}
                  onChange={(e) => askFor(filter, e.target.checked)}
                />
                <span>{filter}</span> <span className={styles.hint}>{what}</span>
              </label>
            ))}
            {wanted
              .filter((filter) => filter !== EVERYTHING && filter !== SYSTEM)
              .map((filter) => (
                <span key={filter} className={styles.topicChip}>
                  {filter}
                  <button
                    type="button"
                    aria-label={`Remove ${filter}`}
                    onClick={() => askFor(filter, false)}
                  >
                    ×
                  </button>
                </span>
              ))}
          </div>

          <div className={styles.row}>
            <Field label="Add a topic filter" htmlFor="onConnectFilter">
              <div className={styles.pathLine}>
                <input
                  id="onConnectFilter"
                  type="text"
                  spellCheck={false}
                  placeholder="plant/+/temp"
                  value={filterDraft}
                  onChange={(e) => setFilterDraft(e.target.value)}
                  // Enter adds what is in the box, and goes no further: the form's own Enter is
                  // Connect, and a reader halfway through a list of filters has not finished
                  // saying what to connect with. An empty box lets it through, as every other
                  // box here does.
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter' || filterDraft.trim() === '') return;

                    e.preventDefault();
                    e.stopPropagation();
                    addFilters();
                  }}
                />
                <button
                  type="button"
                  className="ghost"
                  onClick={addFilters}
                  disabled={filterDraft.trim() === ''}
                >
                  Add
                </button>
              </div>
            </Field>
          </div>

          <p className={styles.note}>
            {wanted.length === 0
              ? 'No filters — nothing is subscribed on connect.'
              : `${wanted.length} ${wanted.length === 1 ? 'filter' : 'filters'}, subscribed on connect.`}
          </p>
        </Sheet>

        {/* The third of the three: six fields the great majority of connections never need would
            otherwise stand between the password and the button that uses it. It stands in the
            stack with the other two — third, where it was asked for — so Enter reaches a
            certificate path the same way it reaches an address.

            Inside, only what the answers so far make sense of: a path is for the answer that asks
            for one, a key and a password are for a certificate, and a certificate in a .pfx
            carries its own key.

            And all of it follows the way in, which is the one rule this block has. Every field in
            here is TLS material; under a plain scheme the server is never even shown it —
            buildConnectRequest sends tls: null, and ConfigureTls is only reached when UseTls — so
            with encryption off these controls do nothing whatever they hold. They look like it.
            One fieldset carries that for all of them at once rather than seven expressions that
            could drift apart.

            The line stays pressable: reading what a connection could be given is never blocked,
            only writing it. And the way back on is outside the fieldset — the box at the head of
            the address — because a control that turns something on cannot be turned off by the
            thing it turns on. There was a second way back on, a button beside this line that
            picked the encrypted twin of whatever was chosen; it is gone, so that the whole line
            is one thing to press and the way in is chosen in one place. */}
        <Sheet
          name="Security"
          id="brokerSheetEncryption"
          says={says.encryption}
          open={openGroups.has('encryption')}
          onToggle={() => toggleGroup('encryption')}
        >
          {/* The fieldset below greys itself under a plain scheme; this says why, once. */}
          {!encrypted && (
            <p className={styles.note}>{`${form.scheme}:// is not encrypted, so none of this is sent.`}</p>
          )}

          <fieldset className={styles.foldFields} disabled={!encrypted}>
          {/* Three answers to one question, and they were a tick box and a path that could both
              be filled in at once: 'accept anything' ticked over a CA nobody would ever consult.
              As radios the form can only say one of them, and the path is asked for by the one
              answer it belongs to. */}
          <fieldset className={styles.trust}>
            <legend>Broker’s certificate</legend>
            <div className={styles.trustLine}>
              <label>
                <input
                  type="radio"
                  name="brokerTrust"
                  checked={trust === 'system'}
                  onChange={() => pickTrust('system')}
                />
                Trust the system’s certificate authorities
              </label>
            </div>
            <div className={styles.trustLine}>
              <label>
                <input
                  type="radio"
                  name="brokerTrust"
                  checked={trust === 'own'}
                  onChange={() => pickTrust('own')}
                />
                Also trust my own CA
              </label>
            </div>
            {trust === 'own' && (
              <div className={styles.trustPath}>
                <PathField
                  label="Extra CA certificate"
                  id="caPath"
                  kind="authority"
                  placeholder="/path/to/ca.crt"
                  value={form.caPath}
                  onPath={(path) => set('caPath', path)}
                  files={files}
                />
              </div>
            )}
            <div className={styles.trustLine}>
              <label>
                <input
                  type="radio"
                  name="brokerTrust"
                  checked={trust === 'any'}
                  aria-describedby="brokerTrustAny"
                  onChange={() => pickTrust('any')}
                />
                Accept any certificate
              </label>
              <span id="brokerTrustAny" className={styles.trustWarn}>
                Not checked. For test brokers only.
              </span>
            </div>
          </fieldset>

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
                    placeholder={certificatePasswordKept ? 'kept' : 'optional'}
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
        </Sheet>
        </div>
      </div>

      {/* What became of the link and what is being done, under the form that answers it. Not
          above the fields: a block of red between the reader and the address box, when the form
          is the answer to it. */}
      <ReconnectNotice />
        </div>
      </div>
      {eventsColumn}
      </div>
      </div>
    </PanelShell>
  );
}

/** The two things a session can be, as the two words on the control. */
const SESSIONS = [
  { value: 'clean', label: 'Clean session' },
  { value: 'kept', label: 'Keep session' },
] as const;

/**
 * Where a broker points, written the way the cards beside the form write it.
 *
 * Through the same two functions the saved and recent cards go through, so what the search box
 * looks in and what Forget names are the string the reader can see on the card.
 */
const endpointOf = (connection: SavedConnection): string =>
  `${formatBrokerAddress(schemeOf(connection.transport, connection.useTls), connection.host)}:${connection.port}`;

/**
 * One setting's line, and the sheet under it.
 *
 * The line is a disclosure button: the name it is asked for by, and nothing else on screen. What
 * the sheet holds is its description rather than part of its name or of what is drawn, so the
 * name stays the one or two words it is and what is behind it is still read out after it. The
 * button is the whole line, edge to edge, so there is nowhere on it to press that does not open
 * it.
 *
 * And it has to look like something that opens. A name, a value and a small grey chevron at the
 * far end read as a line of a report: what the setting is, and nothing to do about it. So the
 * chevron leads the line, in the signal blue, pointing at the line while it is shut and down
 * into the sheet once it is open, and the whole line darkens under the pointer. A word at the
 * far end saying 'Edit' was tried and taken off again: three framed words down the column's edge
 * were three more things to read on a panel whose point is that most of it need not be.
 */
function Sheet({
  name,
  id,
  says,
  open,
  onToggle,
  children,
}: {
  name: string;
  id: string;
  says: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div className={styles.sheet}>
      <button
        type="button"
        className={styles.sheetHead}
        aria-expanded={open}
        aria-controls={id}
        aria-describedby={`${id}Says`}
        onClick={onToggle}
      >
        <Chevron />
        <span className={styles.sheetName}>{name}</span>
        <span id={`${id}Says`} hidden>
          {says}
        </span>
      </button>
      <div id={id} className={styles.sheetPanel} hidden={!open}>
        {children}
      </div>
    </div>
  );
}

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

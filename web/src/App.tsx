import { Fragment, useEffect, useState, type ReactNode } from 'react';
import styles from './App.module.css';
import { AppearancePanel } from './features/appearance/AppearancePanel';
import { Mark, Wordmark } from './features/brand/marks';
import { ChartPanel } from './features/chart/ChartPanel';
import { ColoursPanel } from './features/colours/ColoursPanel';
import { BrokerPanel } from './features/connection/BrokerPanel';
import { useLinkWatch } from './features/connection/useLinkWatch';
import { MobilePanel } from './features/mobile/MobilePanel';
import { useBrokerAddress, useConnectionState } from './api/useConnectionState';
import { useReconnectStatus } from './api/useReconnectStatus';
import { Windows } from './features/monitor/Windows';
import { StreamPause } from './features/monitor/StreamPause';
import { HealthStrip } from './features/health/HealthStrip';
import { useAppearanceStore } from './stores/appearanceStore';
import { TrafficPane } from './features/monitor/TrafficPane';
import { useZoomStore } from './features/monitor/useZoom';
import { LogCount, WireLog } from './features/monitor/WireLog';
import { TopicTree } from './features/topics/TopicTree';
import { Warning } from './features/brand/icons';
import { PANELS, type PanelId } from './features/panels';
import { useProseSelection } from './lib/useProseSelection';
import { PublishPanel } from './features/publish/PublishPanel';
import { SubscribePanel } from './features/subscribe/SubscribePanel';
import { Workspace } from './features/workspace/Workspace';
import type { Hub } from './realtime/hub';
import { useHubBridge } from './realtime/useHubBridge';
import { useHubStatusStore } from './stores/hubStatusStore';
import { AlertsPanel, worst } from './features/alerts/AlertsPanel';
import { SoundPrompt } from './features/alerts/SoundButton';
import { useSoundStore } from './features/alerts/alertSound';
import { useAlertStore } from './stores/alertStore';
import { useLinkWatchStore } from './stores/linkWatchStore';

/** The width the workspace stops being columns at, and the rail starts lying over it. */
const NARROW = '(max-width: 760px)';

/**
 * What every panel is handed.
 *
 * `open` is here for the one panel that has somewhere to send the reader: connecting with the
 * broker refusing a subscription to everything is a dead end unless the Filters panel is a button
 * away. Panels with nowhere to send anyone simply do not name it.
 */
type PanelProps = { onClose: () => void; open: (id: PanelId) => void };

const PANEL_VIEWS: Record<PanelId, (props: PanelProps) => ReactNode> = {
  broker: BrokerPanel,
  subscribe: SubscribePanel,
  colours: ColoursPanel,
  chart: ChartPanel,
  alerts: AlertsPanel,
  mobile: MobilePanel,
  settings: AppearancePanel,
};

/**
 * The whole console: a rail down the left, and the workspace taking everything else.
 *
 * There used to be a bar across the top carrying the name and the connection state. On a laptop
 * it cost sixty pixels of height for two facts that never move — and height is the scarce
 * dimension here, since every pane in the workspace is a list, a form or a plot that wants more
 * of it. Both facts sit in the rail now, which was already there and had room, and the rail
 * shuts to a strip when the reader wants the width instead.
 */
export function App({ hub }: { hub: Hub }) {
  useHubBridge(hub);
  useProseSelection();
  // Mounted here rather than in the Broker panel, and that is the point: the panel is shut
  // most of the time, and a drop that happened while it was shut is exactly the drop the
  // reader most needs told about.
  useLinkWatch();

  // Connecting comes first; reopen from the menu once closed.
  const [openPanel, setOpenPanel] = useState<PanelId | null>('broker');
  // Shut on a narrow screen, where the rail lies over the workspace rather than beside it: two
  // things covering the traffic before the reader has done anything is not an opening state.
  // Read once, on the first render — a reader who opens it should keep it open through a resize.
  const [menuOpen, setMenuOpen] = useState(() => !window.matchMedia?.(NARROW).matches);

  const { state, failure } = useConnectionState();
  const health = useAppearanceStore((state) => state.health);
  // What is alarming, read here rather than only in the panel: the panel is shut most of the
  // time and the health strip is off by default, so the rail is the one place a standing alarm
  // is always visible.
  const alerting = useAlertStore((state) => state.active);
  const loudest = worst(alerting);
  // The preference outlives the page and the armed audio context cannot, so the row has to be
  // able to say that the switch is on and no sound is coming.
  const soundWanted = useAppearanceStore((state) => state.alertSound);
  const soundArmed = useSoundStore((state) => state.armed);

  /**
   * Whether an outage is being worked on, which is a different thing from the link being down.
   *
   * Red is 'it is down and nobody is doing anything about it' — a failed connect, a link somebody
   * closed. Amber is 'it is down and something is happening'. Before this the two were one colour,
   * and a reader could not tell a broker that had gone for good from one that was three seconds
   * from coming back.
   */
  const retrying = useReconnectStatus().status.active && state !== 'Connected';

  const where = useBrokerAddress();
  /** The broker the row is about, whether or not there is a link to it right now. */
  // The live link names it while there is one; a failure names it while there is not. Without the
  // second, the row loses the address at the exact moment a reader wants to know which broker has
  // gone — see BrokerFailure, which carries the endpoint for this reason.
  const pointedAt = where ?? (failure ? `${failure.host}:${failure.port}` : undefined);
  const hubStatus = useHubStatusStore((s) => s.status);
  const zoomed = useZoomStore((s) => s.zoomed);
  const zoomBox = useZoomStore((s) => s.box);

  /**
   * A link that broke brings the reader to the panel that can explain it.
   *
   * Only a link that was up and then faulted, which is what the watch sets this on — never a
   * failed Connect the reader pressed themselves. That is not a disconnection, the panel is
   * already open and in front of them, and reopening it would be the app arguing with somebody
   * who is already there.
   *
   * Closing the panel by hand clears the flag (see BrokerPanel), so this cannot reopen a panel
   * the reader has deliberately shut.
   */
  const openedByFault = useLinkWatchStore((watch) => watch.openedByFault);
  useEffect(() => {
    if (openedByFault) setOpenPanel('broker');
  }, [openedByFault]);

  const close = () => setOpenPanel(null);

  /**
   * What the Broker row wears, which is now the only place the link's state is said.
   *
   * It used to be said twice: a lamp and a word at the top of the rail, and a tint on this row.
   * One console, one link, one place to read it — and this is the row that leads to the panel
   * that can do something about it.
   *
   * Green connected, red for the two that are wrong, and the rail's ordinary grey for the two
   * that are neither. Not red for "not connected": the console opens disconnected, having been
   * asked to do nothing yet, and a red that is on at rest is a red nobody looks at when it
   * finally means something.
   *
   * Reconnecting is the hub rather than the broker, but the reader's question is the same one —
   * is this console showing me anything real — and the answer is no either way.
   */
  const linkState =
    hubStatus === 'reconnecting'
      ? 'Reconnecting'
      : // Ahead of Connecting, and that is the whole of what makes this state readable. A ladder
        // puts the link through Faulted → Connecting → Faulted once a rung, so a row that read the
        // link's own state would flash between two colours for the length of an outage — which
        // says 'something keeps happening' where the truth is 'one thing is happening, still'.
        // The supervisor's own answer does not flicker, so neither does the row.
        retrying
        ? 'Retrying'
        : state === 'Connecting'
          ? 'Waiting'
          : state;

  /** Said out loud on the row, since nothing else says it any more. */
  // 'Retrying' names the broker and 'Reconnecting' does not, because the second one is the
  // console's own link to its server. Two rows both reading 'reconnecting' would be a screen
  // reader saying the same thing about two different failures.
  const LINK_SAID: Partial<Record<typeof linkState, string>> = {
    Connected: 'connected',
    Faulted: 'connection faulted',
    Reconnecting: 'reconnecting',
    Retrying: 'reconnecting to the broker',
    Waiting: 'connecting',
  };
  const Panel = openPanel && PANEL_VIEWS[openPanel];

  return (
    <>
      <div className={styles.body}>
      {/* Never removed, only narrowed. With no bar above it, a rail that vanished would take the
          way back to itself with it. */}
      <div className={styles.rail} data-open={menuOpen ? '' : undefined}>
        {/* What this is. */}
        <div className={styles.railHead}>
          <span className={styles.mark} aria-hidden="true">
            <Mark />
          </span>
          {menuOpen && (
            <h1 className={styles.wordmark}>
              <Wordmark />
            </h1>
          )}
          <button
            type="button"
            className={styles.railToggle}
            aria-expanded={menuOpen}
            aria-controls="panel-menu"
            aria-label="Panel menu"
            title={menuOpen ? 'Narrow the rail' : 'Open the rail'}
            onClick={() => setMenuOpen((open) => !open)}
          >
            {menuOpen ? '‹' : '›'}
          </button>
        </div>

        {/* Kept at both widths. Shut, the labels go and the icons stay, so narrowing the rail
            costs the reader the words rather than the way to every panel in the app. */}
        <nav id="panel-menu" className={styles.menu} aria-label="Panels">
          {PANELS.map((panel, index) => {
            const Icon = panel.icon;
            // The first row of a group. Open, the group says its name; shut, there is no room
            // for one, so the same division is drawn as a rule between the icons.
            const opens = PANELS[index - 1]?.group !== panel.group;
            // Two rows carry a state of their own; the rest are ways in. Both say it in the
            // row's own name, because an aria-label replaces the contents rather than adding to
            // them and a badge that only existed as a colour would say nothing at all here.
            const linkSaid = panel.id === 'broker' ? LINK_SAID[linkState] : undefined;
            const alertSaid =
              panel.id === 'alerts' && alerting.length > 0
                ? `${alerting.length} alerting, worst ${loudest}`
                : undefined;
            const extra = linkSaid ?? alertSaid;
            const said = extra ? `${panel.label}, ${extra}` : undefined;
            // The broker it is pointed at, or — on the Settings row, which is where the switch
            // is — the one thing about alerting a reader can put right without opening anything.
            const hint =
              panel.id === 'broker' && pointedAt
                ? `${panel.label} · ${pointedAt}`
                : panel.id === 'settings' && soundWanted && !soundArmed
                  ? 'Sound is not ready — click to turn it on'
                  : menuOpen
                    ? undefined
                    : panel.label;

            return (
              <Fragment key={panel.id}>
                {opens &&
                  (menuOpen ? (
                    <h2 className={styles.menuGroup}>{panel.group}</h2>
                  ) : (
                    index > 0 && <span className={styles.menuSplit} aria-hidden="true" />
                  ))}
                <button
                  type="button"
                  className={styles.menuBtn}
                  aria-expanded={openPanel === panel.id}
                  // The one row that carries a state of its own. Everything else is a way in.
                  data-link={panel.id === 'broker' ? linkState : undefined}
                  // The row's own name says the state, since nothing else does any more. The
                  // panel's name goes in with it whatever the rail is doing: an aria-label
                  // replaces the contents rather than adding to them, so leaving it out on an
                  // open rail named the row 'connected' and nothing else.
                  aria-label={said ?? (menuOpen ? undefined : panel.label)}
                  // The broker it is pointed at, for a reader who wants it without opening the
                  // panel. It used to have a line of its own under the rail's readout.
                  title={hint}
                  onClick={() => setOpenPanel((current) => (current === panel.id ? null : panel.id))}
                >
                  <Icon />
                  {menuOpen && <span>{panel.label}</span>}
                  {/* At the end of the row, so the name is still what the eye lands on and this
                      is what it finds next. A shape as well as a colour, because a colour on its
                      own says nothing to a reader who cannot tell these two apart. */}
                  {panel.id === 'broker' &&
                    (linkState === 'Faulted' ||
                      linkState === 'Reconnecting' ||
                      linkState === 'Retrying') && (
                      <span className={styles.menuWarn} aria-hidden="true">
                        <Warning />
                      </span>
                    )}
                  {/* Same corner of the same row as the broker's warning triangle, and for the
                      same reason: it is the note at the end of the name, not the name. The
                      number is drawn as a number — the colour is the second signal, and a badge
                      that was only a coloured dot would tell a reader something is wrong and
                      not how much. */}
                  {panel.id === 'alerts' && alerting.length > 0 && (
                    <span
                      className={styles.menuCount}
                      data-testid="alert-badge"
                      data-severity={loudest ?? undefined}
                      aria-hidden="true"
                    >
                      {alerting.length}
                    </span>
                  )}
                </button>
              </Fragment>
            );
          })}
        </nav>

        {/* At the foot, and the full width of it. What it stops is different from what the state
            above reports — whether there is a broker, against whether we are taking anything from
            it — and a reader can stop the second without touching the first. Standing here it is
            the last thing in the rail rather than a control floating in the middle of it, and it
            can afford to say what it does in words. The narrower pause, one run in one pane, is
            in that pane's foot. */}
        <div className={styles.railFoot}>
          <StreamPause compact={!menuOpen} live={state === 'Connected'} />
        </div>
      </div>

      <Workspace
        panel={Panel ? <Panel onClose={close} open={setOpenPanel} /> : undefined}
        // Three of the seven, for two different reasons. See Workspace's own note on both.
        wide={
          openPanel === 'broker'
            ? 'full'
            : openPanel === 'alerts' || openPanel === 'colours'
              ? 'fill'
              : undefined
        }
        tree={
          <section className={styles.treePane}>
            {/* The live link, so every topic hangs off the broker it actually came from. */}
            <TopicTree broker={where} />
          </section>
        }
        log={
          <section className={styles.wire}>
            <WireLog />
          </section>
        }
        logCount={<LogCount />}
        chart={
          // Thrown open, the region leaves the column and takes the window. The strip that folds
          // it stays where it was, so the column does not rearrange itself underneath.
          <section
            className={styles.chartPane}
            data-zoomed={zoomed ? '' : undefined}
            // Where the reader put it. Inline because it is a place rather than a style: the
            // stylesheet says what a thrown-open chart looks like, and this says where this one
            // is standing right now.
            style={
              zoomed && zoomBox
                ? {
                    left: zoomBox.x,
                    top: zoomBox.y,
                    // The opening inset in the stylesheet sets all four sides; a placed window
                    // is two sides and a size, so the other two are given back.
                    right: 'auto',
                    bottom: 'auto',
                    width: zoomBox.w,
                    height: zoomBox.h,
                  }
                : undefined
            }
          >
            <TrafficPane />
          </section>
        }
        publish={<PublishPanel />}
      />

      {/* AlertWall stood here: a third plate in the row, after the rail and the workspace, holding
          every standing alarm down the inline-end edge. It is off the console for now, and the
          alerts panel took the job by taking the whole workspace instead — the component and its
          tests are kept because 'for now' is what was asked for. */}

      {/* Over everything, and outside the workspace: a chart window is placed against the
          viewport, and every ancestor inside the workspace is a grid track with a share of a
          height. */}
      <Windows />
      </div>

      {/* Outside the workspace and under it: the workspace is a grid with a share of the height,
          and this is a line the reader has asked for rather than part of the tool. */}
      {health && <HealthStrip />}

      {/* In the corner the alarm wall no longer uses, and outside `.body`: it explains why an
          alarm made no sound, which is a thing about the console rather than a thing on the
          wall. */}
      <SoundPrompt />
    </>
  );
}

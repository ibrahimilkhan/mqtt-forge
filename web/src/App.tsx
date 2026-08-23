import { Fragment, useState, type ReactNode } from 'react';
import styles from './App.module.css';
import { StatusReadout } from './components/StatusReadout';
import { AppearancePanel } from './features/appearance/AppearancePanel';
import { Mark, Wordmark } from './features/brand/marks';
import { ChartPanel } from './features/chart/ChartPanel';
import { ColoursPanel } from './features/colours/ColoursPanel';
import { BrokerPanel } from './features/connection/BrokerPanel';
import { MobilePanel } from './features/mobile/MobilePanel';
import { useBrokerAddress, useConnectionState } from './api/useConnectionState';
import { ChartWindows } from './features/monitor/ChartWindows';
import { StreamPause } from './features/monitor/StreamPause';
import { HealthStrip } from './features/health/HealthStrip';
import { useAppearanceStore } from './stores/appearanceStore';
import { TrafficPane } from './features/monitor/TrafficPane';
import { useZoomStore } from './features/monitor/useZoom';
import { WireLog } from './features/monitor/WireLog';
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

  // Connecting comes first; reopen from the menu once closed.
  const [openPanel, setOpenPanel] = useState<PanelId | null>('broker');
  // Shut on a narrow screen, where the rail lies over the workspace rather than beside it: two
  // things covering the traffic before the reader has done anything is not an opening state.
  // Read once, on the first render — a reader who opens it should keep it open through a resize.
  const [menuOpen, setMenuOpen] = useState(() => !window.matchMedia?.(NARROW).matches);

  const { state } = useConnectionState();
  const health = useAppearanceStore((state) => state.health);

  const where = useBrokerAddress();
  const hubStatus = useHubStatusStore((s) => s.status);
  const zoomed = useZoomStore((s) => s.zoomed);
  const zoomBox = useZoomStore((s) => s.box);

  const close = () => setOpenPanel(null);

  /**
   * What the Broker row wears, which is the link's own state and nothing else.
   *
   * Green connected, red faulted, and the rail's ordinary grey for everything in between. Not
   * red for "not connected": the console opens disconnected, having been asked to do nothing
   * yet, and a red that is on at rest is a red nobody looks at when it means something.
   *
   * A hub that is reconnecting makes the broker state stale rather than false, so it reads as
   * neither — the readout at the top of the rail is where that is said, and saying it twice in
   * two vocabularies would be worse than saying it once.
   */
  const linkState =
    hubStatus === 'reconnecting' ? 'Unknown' : state === 'Connecting' ? 'Unknown' : state;
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

        {/* Straight under the name, because it is the second thing anyone wants from the rail and
            the whole console is a lie without it: identity, link, panels, flow, in that order.
            Shut, it is the lamp alone — which is all anyone reads it for from across a room. */}
        <div
          className={styles.railState}
          data-state={hubStatus === 'reconnecting' ? 'Reconnecting' : state}
        >
          <StatusReadout
            state={state}
            reconnecting={hubStatus === 'reconnecting'}
            compact={!menuOpen}
          />
          {menuOpen && where && (
            <p className={styles.where} title={where}>
              {where}
            </p>
          )}
        </div>

        {/* Kept at both widths. Shut, the labels go and the icons stay, so narrowing the rail
            costs the reader the words rather than the way to every panel in the app. */}
        <nav id="panel-menu" className={styles.menu} aria-label="Panels">
          {PANELS.map((panel, index) => {
            const Icon = panel.icon;
            // The first row of a group. Open, the group says its name; shut, there is no room
            // for one, so the same division is drawn as a rule between the icons.
            const opens = PANELS[index - 1]?.group !== panel.group;

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
                  // Shut, the label is not on the page, so the button has to carry it itself.
                  aria-label={menuOpen ? undefined : panel.label}
                  title={menuOpen ? undefined : panel.label}
                  onClick={() => setOpenPanel((current) => (current === panel.id ? null : panel.id))}
                >
                  <Icon />
                  {menuOpen && <span>{panel.label}</span>}
                  {/* At the end of the row, so the name is still what the eye lands on and this
                      is what it finds next. A shape as well as a colour, because a colour on its
                      own says nothing to a reader who cannot tell these two apart. */}
                  {panel.id === 'broker' && state === 'Faulted' && (
                    <span className={styles.menuWarn} role="img" aria-label="Connection faulted">
                      <Warning />
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
        // The broker panel only. See Workspace's own note on why it is the one.
        wide={openPanel === 'broker'}
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

      {/* Over everything, and outside the workspace: a chart window is placed against the
          viewport, and every ancestor inside the workspace is a grid track with a share of a
          height. */}
      <ChartWindows />
      </div>

      {/* Outside the workspace and under it: the workspace is a grid with a share of the height,
          and this is a line the reader has asked for rather than part of the tool. */}
      {health && <HealthStrip />}
    </>
  );
}

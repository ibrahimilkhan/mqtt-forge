import { useEffect, useRef, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Corner, Expand, Shrink } from '../brand/icons';
import { MessageDetail } from './MessageDetail';
import styles from './Floating.module.css';
import { fullBox, moved, sized, useFloating } from './floating';
import { Pin } from './Pin';
import { TrafficChart } from './TrafficChart';
import { stampMeaning, type LogEntry } from '../../stores/logStore';
import { useWindows, type FloatWindow } from './useWindows';
import { useRunsFor } from './useTraffic';
import { useZoomStore } from './useZoom';

/**
 * The windows a reader has opened, floating over the console — a chart taken off the selection,
 * or one message taken out of the run.
 *
 * They are drawn here, at the top of the app, rather than anywhere near the pane they were
 * opened from: a window is placed against the viewport, and everything between the pane and the
 * viewport is a grid track holding a share of a height.
 */
export function Windows() {
  const windows = useWindows((state) => state.windows);
  const place = useWindows((state) => state.place);

  // A window placed against one viewport and left there while the window got smaller can end up
  // with no bar on screen — and the bar is the only way to bring it back. Sizing and moving each
  // of them by nothing is enough: those are what clamp them. The size as well as the corner,
  // since a window wider than the viewport keeps its close and its grip off the far edge.
  useEffect(() => {
    const settle = () => {
      for (const chart of useWindows.getState().windows) {
        // A window filling the screen follows the screen. Clamping the box it happens to hold
        // would leave it the old viewport's size in the new one, which is a window that filled
        // the screen until the reader touched the corner of theirs.
        const box = chart.full ? fullBox() : moved(sized(chart.box, 0, 0), 0, 0);
        if (box.x !== chart.box.x || box.y !== chart.box.y || box.w !== chart.box.w || box.h !== chart.box.h) {
          place(chart.id, box);
        }
      }
    };

    window.addEventListener('resize', settle);

    return () => window.removeEventListener('resize', settle);
  }, [place]);

  // Escape shuts the one on top. Not the one with focus: a reader who pressed it is asking for
  // the thing in front of them to go, and after it goes the next press asks the same of the next.
  //
  // Except while the chart is thrown open, which is drawn above every window and has its own
  // Escape. Two listeners for one key is what this console already does — the reading card and
  // the colour picker have theirs too — and this is the one pair that overlap on screen.
  useEffect(() => {
    const shut = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (useZoomStore.getState().zoomed) return;

      const top = useWindows.getState().windows.at(-1);
      if (top) useWindows.getState().close(top.id);
    };

    window.addEventListener('keydown', shut);

    return () => window.removeEventListener('keydown', shut);
  }, []);

  return (
    <>
      {windows.map((chart, index) => (
        // The order they are held in is the order they stack, said out loud rather than left to
        // the order they happen to be drawn in: the newest is on top, and touching one brings it
        // up. Two windows opening in the same place is ordinary here, so which is in front is
        // not a detail that can be left to work itself out.
        <Frame key={chart.id} pane={chart} depth={index} />
      ))}
    </>
  );
}

function Frame({ pane: chart, depth }: { pane: FloatWindow; depth: number }) {
  const close = useWindows((state) => state.close);
  const place = useWindows((state) => state.place);
  const fix = useWindows((state) => state.fix);
  const swell = useWindows((state) => state.swell);
  const raise = useWindows((state) => state.raise);
  const { bar, grip } = useFloating(chart.box, (box) => place(chart.id, box));
  const frame = useRef<HTMLElement>(null);
  const message = chart.pane.kind === 'message';
  // Filling the screen holds a window still as surely as the pin does, and for a plainer reason:
  // there is nowhere left to move it to.
  const held = chart.fixed || chart.full;

  // A window opened onto one message takes the focus, because it was opened by a keystroke or a
  // press on a row and there is nothing else on screen it could mean. On the way out the focus
  // goes back where it came from — and where it came from is usually gone: the pane draws one row
  // at rest, keyed on the entry, so the next arrival unmounts the button that opened this. The
  // region is the named fallback, which is where the reader was looking anyway.
  useEffect(() => {
    if (!message) return;

    const opener = document.activeElement as HTMLElement | null;
    frame.current?.focus();

    return () => {
      if (opener && document.contains(opener)) opener.focus();
      else document.getElementById('region-log')?.focus();
    };
  }, [message]);

  /**
   * Select all, in a window, means the message in it.
   *
   * The browser's own answer is the whole document — the tree, the log, the publish form and the
   * message together — which on this screen is never what anybody meant. A window opened onto one
   * arrival exists to be read and taken away, and the reader who presses this is two keys from
   * having the payload in their clipboard.
   *
   * Caught here rather than in the detail below, because the focus is here: the section is what
   * takes focus when a window opens, and what a click on anything unfocusable inside it falls
   * back to, so a handler further down would never see the key at all.
   *
   * Nothing to select in a chart, so a chart window leaves the browser to it.
   */
  const selectMessage = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'a') return;

    const body = frame.current?.querySelector('[data-message]');
    if (!body) return;

    event.preventDefault();

    const range = document.createRange();
    range.selectNodeContents(body);

    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  };

  const where: CSSProperties = {
    left: chart.box.x,
    top: chart.box.y,
    width: chart.box.w,
    height: chart.box.h,
    zIndex: 22 + depth,
  };

  return (
    <section
      className={styles.window}
      style={where}
      ref={frame}
      data-testid={message ? 'message-window' : 'chart-window'}
      data-filter={chart.pane.kind === 'chart' ? chart.pane.filter : undefined}
      data-fixed={chart.fixed ? '' : undefined}
      data-full={chart.full ? '' : undefined}
      aria-label={message ? `${chart.label}, opened` : `${chart.label} chart`}
      // Focusable only as a message: a chart window is read, and its own controls are the way in.
      tabIndex={message ? -1 : undefined}
      // On the way down rather than on the click: a reader reaching for a control in a window
      // behind another one should have the window they are reaching into come forward first,
      // not after they have already pressed something on it. Focus counts as reaching in: a
      // reader tabbing into a window that is behind another one would otherwise be working a
      // window they cannot see.
      onPointerDownCapture={() => raise(chart.id)}
      onFocusCapture={() => raise(chart.id)}
      onKeyDown={message ? selectMessage : undefined}
    >
      <div
        className={styles.bar}
        // Pinned, the bar is a label with controls on it rather than a handle. The window still
        // comes forward when it is touched — it is being moved that the pin stops.
        {...(held ? {} : bar)}
        // In the tab order only while it can do something, and named for what the arrow keys
        // will do with it once it is there.
        tabIndex={held ? undefined : 0}
        role={held ? undefined : 'application'}
        aria-label={held ? undefined : `Move the ${chart.label} chart`}
        title={
          chart.full
            ? 'Filling the screen — put it back to move it'
            : chart.fixed
              ? 'Pinned in place — unpin to move it'
              : 'Drag to move — the corner sizes it'
        }
      >
        {/* At the near end of the bar, not the far one. A window opens in the middle at the size
            the chart opens at, so the far end of this bar is exactly where the control that
            opened it was standing a moment ago — and a second press there, the one that asks
            'did that work?', would have landed on whatever is put in that corner. */}
        {/* Gone while it fills the screen. The pin is about whether a window may be moved, and
            one that has nowhere to move to is a pin that answers a question nobody is asking. Its
            state is kept underneath, so putting the window back puts the pin back too. */}
        {!chart.full && (
          <button
            type="button"
            className={styles.pin}
            aria-pressed={chart.fixed}
            aria-label={chart.fixed ? `Let ${chart.label} move` : `Pin ${chart.label} in place`}
            title={
              chart.fixed
                ? `${chart.label} is pinned where it stands — unpin it to move or size it`
                : `Pin ${chart.label} where it stands`
            }
            onClick={() => fix(chart.id, !chart.fixed)}
          >
            <Pin />
          </button>
        )}

        {/* Beside the pin, a message wears the same chips its row wears — qos, retained, the
            weight, and 'bin' where the body is a byte dump. They are the row's own strings, taken
            off the entry rather than built again here: 'the chips from the log' is a promise that
            only holds while one place decides what a chip says, and a second opinion in this file
            would agree with `toEntry` right up until the day somebody changed one of them.

            They stand where the name stood, and the name goes with them. A message window's name
            is 'HH:MM:SS topic', and the summary thirty pixels below now draws that topic at
            reading size in its rule's colour with the whole timestamp under it — so keeping both
            put one topic on screen twice, six pixels apart, at two sizes. Measured, the name had
            three characters and an ellipsis left beside three chips in the narrowest window a
            reader can drag this to. A chart window keeps its name: it has no summary under it,
            and the name is the one thing telling two pinned charts of two topics apart.

            Spans rather than buttons. The bar is the handle, and the only press it declines is one
            with a button above it — a chip made into a control would cut a dead patch out of the
            middle of the thing the window is dragged by.

            Only where there are stamps to draw. An entry pushed into the store by hand carries
            none, and a window over an empty group would be a bar with sixteen pixels of nothing
            in the middle of it. */}
        {chart.pane.kind === 'message' && chart.pane.entry.stamps?.length ? (
          <span className={styles.stamps} data-testid="stamps">
            {chipsFor(chart.pane.entry).map((stamp) => (
              <span
                key={stamp}
                className={styles.stamp}
                data-stamp={stamp}
                // The same meanings the log row's chips carry, from the same place: 'qos 0' and
                // 'not retained' are about this delivery, not about the publish behind it.
                title={stampMeaning(stamp)}
              >
                {stamp}
              </span>
            ))}
          </span>
        ) : (
          <span className={styles.name}>{chart.label}</span>
        )}

        {/* Beside the close rather than anywhere else: the two of them are what a reader reaches
            for when a window is in the way, and they should be found in one place. */}
        <button
          type="button"
          className={styles.swell}
          data-testid="swell"
          aria-pressed={chart.full}
          aria-label={
            chart.full ? `Put ${chart.label} back` : `Fill the screen with ${chart.label}`
          }
          title={chart.full ? 'Put it back' : 'Fill the screen'}
          onClick={() => swell(chart.id, !chart.full)}
        >
          {chart.full ? <Shrink /> : <Expand />}
        </button>

        <button
          type="button"
          className={styles.close}
          aria-label={`Close the ${chart.label} chart`}
          title="Close this window"
          onClick={() => close(chart.id)}
        >
          ×
        </button>
      </div>

      <div className={styles.body}>
        {chart.pane.kind === 'chart' ? (
          <ChartBody filter={chart.pane.filter} label={chart.label} />
        ) : (
          <MessageDetail entry={chart.pane.entry} />
        )}
      </div>

      {/* Gone while it is pinned rather than shown and refusing: a corner that can be taken hold
          of and does nothing is a broken window, and the pin beside it says why it is not there. */}
      {!held && (
        <button
          type="button"
          className={styles.grip}
          aria-label={`Resize the ${chart.label} chart`}
          title="Drag to size"
          {...grip}
        >
          <Corner />
        </button>
      )}
    </section>
  );
}

/**
 * The chips a message window's bar wears.
 *
 * The row's own stamps, with the one answer the row leaves out. The log stamps RETAINED when a
 * message was and nothing at all when it was not, which is the right silence in a run of
 * twenty-five rows and the wrong one in a window opened to ask about one message — a reader opens
 * this to find out whether the value in front of them is live traffic or a leftover the broker
 * kept, and no chip is not an answer to that.
 *
 * It goes where RETAINED would have stood, so the two answers to one question are read in the
 * same spot rather than at opposite ends of the row. Everything else is `toEntry`'s, unread and
 * unrebuilt: 'the chips from the log' is a promise that only holds while one place decides what a
 * chip says.
 */
function chipsFor(entry: LogEntry): string[] {
  const worn = entry.stamps ?? [];
  if (entry.retain !== false) return worn;

  // Straight after the QoS stamp, and in front of everything if there is not one.
  const at = worn.findIndex((stamp) => stamp.startsWith('QoS')) + 1;

  return [...worn.slice(0, at), 'not retained', ...worn.slice(at)];
}

/**
 * The chart half of a window.
 *
 * Its own component because of the hook: a window draws one thing or the other, and a hook cannot
 * be called for the half that is not being drawn.
 */
function ChartBody({ filter, label }: { filter: string; label: string }) {
  // Runs, not one merged sequence: a pinned window redraws on every batch for as long as it is
  // open, and merging a branch of thousands of topics only for the chart to split it again was
  // what made a pinned window cost two thirds of a second at a time.
  const runs = useRunsFor(filter);

  if (runs.length === 0) return <p className="empty">Nothing on {label} to chart yet.</p>;

  // Keyed on the filter like the pane's own chart: this window only ever draws one, so the key is
  // really a statement that it never changes run under the reader.
  return <TrafficChart key={filter} runs={runs} />;
}

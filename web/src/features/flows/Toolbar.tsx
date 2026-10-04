import { useCallback, useLayoutEffect, useRef, type FocusEvent, type KeyboardEvent } from 'react';
import type { FlowDto } from '../../types/api';
import { Warning } from '../brand/icons';
import { titleOf } from './flowDocument';
import { useFlowDraftStore } from './flowDraftStore';
import styles from './Toolbar.module.css';

/** The region the tabs control. Everything under them is about the flow on screen. */
export const FLOW_PANEL = 'flow-panel';

/** A tab's own id, so the region it controls can say which tab names it. */
export const tabIdOf = (flowId: string) => `flow-tab-${flowId}`;

/** Puts the keyboard on a flow's tab, for a control that is about to go out from under it. */
export const focusTab = (flowId: string) => document.getElementById(tabIdOf(flowId))?.focus();

/**
 * Puts the keyboard on the tab of the flow on screen, whichever flow that now is: for a control
 * that took its flow away with it. The region the tabs control says which tab names it.
 */
export function focusShownTab() {
  const tab = document.getElementById(FLOW_PANEL)?.getAttribute('aria-labelledby');
  if (tab) document.getElementById(tab)?.focus();
}

/** Why Activate and Update are off for a draft held back, on the buttons themselves. */
const HELD = 'Changed on the server since you started — keep yours or discard it in the flow’s pane first.';

/** The same, for a draft of a flow another console has deleted, which the tab says in those words. */
const GONE = 'Deleted on the server since you started — keep yours or discard it in the flow’s pane first.';

type Props = {
  flows: FlowDto[];
  /**
   * Flows with a draft Activate and Update send: an edit of what the server has, or a flow it never
   * had.
   */
  changed: ReadonlySet<string>;
  /**
   * Flows whose draft was started from a copy the server has since replaced, or deleted. Activate
   * and Update hold them back until the reader keeps or discards them, in the flow's own pane.
   */
  overtaken: ReadonlySet<string>;
  /** Flows the server has, whatever their drafts say. */
  deployed: ReadonlySet<string>;
  current: string;
  /** Flows the server has switched on: each runs for the application's life. */
  active: ReadonlySet<string>;
  /** Flows with a run going: their own, or a test. */
  running: ReadonlySet<string>;
  /** Flows with a test going. */
  testing: ReadonlySet<string>;
  /**
   * Flows the server has said something is wrong with: a refused save or test, or a problem in its
   * file.
   */
  refused: ReadonlySet<string>;
  /** A save, a test start or a stop is out. */
  busy: boolean;
  /** Flows whose Test is held off: pressed, and no push since the server took it shows the test yet (see useTest). */
  starting: ReadonlySet<string>;
  /** Flows whose Stop is held off: pressed, and the numbers still show the test going (see useTest). */
  stopping: ReadonlySet<string>;
  onNew: () => void;
  /**
   * Puts the flow on screen back to the copy the server has. Left out when there is nothing to go
   * back to, and for a draft held back, whose pane has the choice.
   */
  onDiscard?: () => void;
  onTest: () => void;
  onStop: () => void;
  onActivate: () => void;
  /** Saves the change to a flow that is on. Left out while there is none. */
  onUpdate?: () => void;
  /** Switches off a flow that is on. Left out for one that is not. */
  onDeactivate?: () => void;
};

/**
 * What a tab's lamp and dot say, in words, for a reader who cannot see them. Whether the flow runs
 * is said of every flow, since one the server does not have runs too while it is tested. A flow the
 * server does not have is not saved; one it has, and that has been edited since, goes on running
 * the copy that was saved, so it is its changes that are not. A draft the server moved on from
 * under says that instead.
 *
 * The lamp shows a refusal over whether the flow runs, and the words say both: a flow whose new
 * version was refused goes on running the one it had.
 */
function stateOf(flowId: string, { changed, overtaken, deployed, running, refused }: Props): string {
  const runs = running.has(flowId) ? 'running' : 'not running';
  const verdict = refused.has(flowId) ? 'refused' : null;
  const draft = overtaken.has(flowId)
    ? `${deployed.has(flowId) ? 'changed' : 'deleted'} on the server since you started`
    : !deployed.has(flowId)
      ? 'not saved'
      : changed.has(flowId)
        ? 'changes not saved'
        : null;

  return [runs, verdict, draft].flatMap((words) => (words ? [`, ${words}`] : [])).join('');
}

/**
 * Brings what took the keyboard in the tab row wholly into view. The browser does not: it scrolls
 * to a tab it cannot see at all, and leaves one it can see part of exactly where it is, focused,
 * with its name and its ring cut off at the row's edge — as the chart's field chips once were.
 * `nearest` and the row's scroll-padding put it clear of the edge, and move nothing when the tab
 * is already wholly in the row.
 */
const reveal = (event: FocusEvent) => {
  if (event.target instanceof HTMLElement) event.target.scrollIntoView?.({ inline: 'nearest', block: 'nearest' });
};

/** Where each key a tab list answers to goes, from `at` in a list of `count`. */
function step(key: string, at: number, count: number): number | null {
  switch (key) {
    case 'ArrowRight':
      return (at + 1) % count;
    case 'ArrowLeft':
      return (at - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}

/**
 * The flows as tabs, and what can be done with the one on screen.
 *
 * ▶ Test runs the drawing on screen once, as it stands, and saves nothing: the way to find out what
 * a drawing does before anything depends on it. While that test runs, the button is ■ Stop.
 * Activate saves the flow and runs it for the application's life, with this page open or not. A
 * flow that is on has Deactivate instead, which switches it off and keeps it — the server's copy,
 * so a drawing the server would refuse can never keep a flow from being stopped — and, once it has
 * changes, Update beside it, which saves them and starts its run again from Start. Each is about the
 * flow on screen and no other: a reader who pressed one meant the flow they were looking at, and a
 * button that also sent a draft on another tab would send one nobody remembers making.
 *
 * Activate and Update hold back a draft another console has overtaken — replaced or deleted the
 * copy it was started from — which sent as it stands would undo that console's work. They say so,
 * as the tab does, and the flow's own pane has Keep mine and Discard under the sentence that says
 * why. Discard here is about the drawing: it puts the flow on screen back to the server's copy, and
 * is only offered when there is one to go back to. For a flow never saved, going back would throw
 * the whole flow away, and that is Delete flow's job, which asks first.
 *
 * The tabs are one stop on the Tab key, and the arrows, Home and End go along them. Selection
 * follows the focus: showing a flow is instant, and a reader going along the tabs is looking for
 * one. The + stands outside the list, which may own tabs and nothing else.
 */
export function Toolbar(props: Props) {
  const {
    flows,
    changed,
    overtaken,
    deployed,
    current,
    active,
    running,
    testing,
    refused,
    busy,
    starting,
    stopping,
    onNew,
    onDiscard,
    onTest,
    onStop,
    onActivate,
    onUpdate,
    onDeactivate,
  } = props;
  const show = useFlowDraftStore((state) => state.show);
  const held = overtaken.has(current);
  const heldWhy = deployed.has(current) ? HELD : GONE;

  // A button that takes itself away — Activate turning into Deactivate once the flow is on, Test
  // into Stop once its test runs, Update going once its change is saved — takes the keyboard with
  // it, and a browser hands that to the body: the next Tab starts again from the top of the
  // document. The reader goes to the tab of the flow on screen instead, as they did when Deploy
  // turned off. A button says as it goes whether it had the keyboard, the last moment it can; the
  // tab takes it once the change is drawn, before the paint — unless something else has taken it.
  // Test and Stop are told apart by their keys, so Stop is a button of its own and not Test with
  // another word on it, where a second press of the key that started a test would stop it.
  const fell = useRef(false);
  const going = useCallback((button: HTMLButtonElement | null) => {
    if (button === null) return;
    return () => {
      if (document.activeElement === button) fell.current = true;
    };
  }, []);

  useLayoutEffect(() => {
    if (!fell.current) return;
    fell.current = false;
    if (document.activeElement === null || document.activeElement === document.body) focusTab(current);
  });

  const onKeyDown = (event: KeyboardEvent) => {
    // A modified arrow is the browser's — Alt and Left is Back — not the list's.
    if (event.altKey || event.ctrlKey || event.metaKey) return;

    const to = step(event.key, flows.findIndex((flow) => flow.id === current), flows.length);
    if (to === null) return;

    event.preventDefault();
    show(flows[to].id);
    focusTab(flows[to].id);
  };

  return (
    <div className={styles.toolbar}>
      <span className={styles.beta} title="Flows are an experiment: how they are drawn and kept may change between versions.">
        Experimental
      </span>

      {/* The + scrolls with the tabs, so it is always just after the last one. It stands beside
          the tab list rather than in it, because ARIA lets a tab list own tabs and nothing else. */}
      <div className={styles.tabs} onFocus={reveal}>
        <div className={styles.tabList} role="tablist" aria-label="Tabs" onKeyDown={onKeyDown}>
          {flows.map((flow) => (
            <button
              key={flow.id}
              id={tabIdOf(flow.id)}
              type="button"
              role="tab"
              aria-selected={flow.id === current}
              aria-controls={FLOW_PANEL}
              tabIndex={flow.id === current ? 0 : -1}
              className={styles.tab}
              data-state={refused.has(flow.id) ? 'refused' : running.has(flow.id) ? 'running' : 'stopped'}
              onClick={() => show(flow.id)}
            >
              {/* A shape as well as a colour, as the rail marks a faulted link: a refusal wears
                  the same warning triangle, and the other two a dot and a ring (the stylesheet). */}
              <span className={styles.lamp} aria-hidden="true">
                {refused.has(flow.id) && <Warning />}
              </span>
              {titleOf(flow)}
              {(changed.has(flow.id) || overtaken.has(flow.id)) && (
                <span className={styles.changed} data-overtaken={overtaken.has(flow.id) ? '' : undefined} aria-hidden="true">
                  •
                </span>
              )}
              <span className="srOnly">{stateOf(flow.id, props)}</span>
            </button>
          ))}
        </div>

        <button type="button" className={`ghost ${styles.add}`} aria-label="New flow" title="New flow" onClick={onNew}>
          +
        </button>
      </div>

      {/* Every button from here on is off while a save, a test start or a stop is out, but said
          rather than set: a button switched off in the hand that pressed it loses the focus in some
          browsers, and a save that ends in a refusal leaves it on again with the reader still on it.
          Discard too: pressed while an Update is out, it would be undone by the answer, which puts
          the flow the server kept on screen. Activate and Update are off the same way for a draft
          held back, and say why where the pointer and a screen reader find it; and Test and Stop
          for the flow whose press of them the numbers have not caught up with yet (see useTest). */}
      {onDiscard && (
        <button
          ref={going}
          type="button"
          className="ghost ends"
          aria-disabled={busy || undefined}
          onClick={() => {
            if (busy) return;
            // Discard takes itself away with the changes, and the keyboard with it.
            onDiscard();
            focusTab(current);
          }}
        >
          Discard
        </button>
      )}

      {testing.has(current) ? (
        <button
          key="stop"
          ref={going}
          type="button"
          className="ghost"
          aria-disabled={busy || stopping.has(current) || undefined}
          onClick={() => !busy && !stopping.has(current) && onStop()}
        >
          ■ Stop
        </button>
      ) : (
        <button
          key="test"
          ref={going}
          type="button"
          className="ghost"
          aria-disabled={busy || starting.has(current) || undefined}
          onClick={() => !busy && !starting.has(current) && onTest()}
        >
          ▶ Test
        </button>
      )}
      {!active.has(current) ? (
        <button
          key="activate"
          ref={going}
          type="button"
          className={styles.activate}
          aria-disabled={busy || held || undefined}
          data-held={held ? '' : undefined}
          title={held ? heldWhy : undefined}
          onClick={() => !busy && !held && onActivate()}
        >
          Activate
        </button>
      ) : (
        <>
          {onUpdate && (
            <button
              key="update"
              ref={going}
              type="button"
              className={styles.activate}
              aria-disabled={busy || held || undefined}
              data-held={held ? '' : undefined}
              title={held ? heldWhy : undefined}
              onClick={() => !busy && !held && onUpdate()}
            >
              Update
            </button>
          )}
          {onDeactivate && (
            <button
              key="deactivate"
              ref={going}
              type="button"
              className="ghost ends"
              aria-disabled={busy || undefined}
              onClick={() => !busy && onDeactivate()}
            >
              Deactivate
            </button>
          )}
        </>
      )}
    </div>
  );
}

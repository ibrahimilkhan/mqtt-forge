import { useLayoutEffect, useRef, type FocusEvent, type KeyboardEvent } from 'react';
import type { FlowDto } from '../../types/api';
import { Warning } from '../brand/icons';
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

type Props = {
  flows: FlowDto[];
  /** Flows with a draft Deploy sends: an edit of what the server has, or a flow it never had. */
  changed: ReadonlySet<string>;
  /**
   * Flows whose draft was started from a copy the server has since replaced, or deleted. Deploy
   * holds them back until the reader keeps or discards them, in the flow's own pane.
   */
  overtaken: ReadonlySet<string>;
  /** Flows the server has, whatever their drafts say. */
  deployed: ReadonlySet<string>;
  current: string;
  /** Flows running now. */
  running: ReadonlySet<string>;
  /** Flows the server has said something is wrong with: a refused deploy, or a problem in its file. */
  refused: ReadonlySet<string>;
  deploying: boolean;
  onNew: () => void;
  /** Puts the flow on screen back to what is running. Left out when there is nothing to go back to. */
  onDiscard?: () => void;
  onDeploy: () => void;
};

/**
 * What a tab's lamp and dot say, in words, for a reader who cannot see them. A flow never deployed
 * is not deployed; one that was, and has been edited since, is still running what was deployed, so
 * it is its changes that are not. A draft the server moved on from under says that instead.
 */
function stateOf(flowId: string, { changed, overtaken, deployed, running, refused }: Props): string {
  const lamp = refused.has(flowId) ? 'refused' : running.has(flowId) ? 'running' : deployed.has(flowId) ? 'not running' : null;
  const draft = overtaken.has(flowId)
    ? `${deployed.has(flowId) ? 'changed' : 'deleted'} on the server since you started`
    : !deployed.has(flowId)
      ? 'not deployed'
      : changed.has(flowId)
        ? 'changes not deployed'
        : null;

  return [lamp, draft].flatMap((words) => (words ? [`, ${words}`] : [])).join('');
}

/** What the count beside Deploy says: the changes it sends, and the ones it holds back. */
function tally(count: number, held: number): string {
  const said = [
    ...(count > 0 ? [`${count} ${count === 1 ? 'change' : 'changes'}`] : []),
    ...(held > 0 ? [`${held} held back`] : []),
  ];
  return said.length > 0 ? said.join(' · ') : 'All deployed';
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
 * The flows as tabs, and the one action that changes what runs.
 *
 * Deploy sends every changed flow, not the one on screen: a reader who edited two flows and
 * pressed Deploy meant both, and a button that quietly left one behind would leave a draft
 * nobody remembers making. The one kind it does leave behind says so, beside it and on its tab: a
 * draft of a copy another console has since replaced or deleted, which would undo that console's
 * work. Discard is only about the flow on screen, and only offered when that flow has a deployed
 * version to go back to. For a flow never deployed, going back would throw the whole flow away,
 * and that is Delete flow's job, which asks first.
 *
 * The tabs are one stop on the Tab key, and the arrows, Home and End go along them. Selection
 * follows the focus: showing a flow is instant, and a reader going along the tabs is looking for
 * one. The + stands outside the list, which may own tabs and nothing else.
 */
export function Toolbar(props: Props) {
  const { flows, changed, overtaken, current, running, refused, deploying, onNew, onDiscard, onDeploy } = props;
  const show = useFlowDraftStore((state) => state.show);
  const deployButton = useRef<HTMLButtonElement>(null);
  const nothing = changed.size === 0;

  // A run that leaves nothing to deploy turns Deploy off in the hand that pressed it, and a browser
  // drops the focus of a button that cannot be pressed. The reader goes to the tab of the flow they
  // were on rather than to the top of the document. Before the paint, while the button still has it.
  useLayoutEffect(() => {
    if (nothing && document.activeElement === deployButton.current) focusTab(current);
  }, [current, nothing]);

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
              {flow.name.trim() || 'Untitled'}
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

      <span className={styles.count} aria-live="polite">
        {tally(changed.size, overtaken.size)}
      </span>

      {onDiscard && (
        <button
          type="button"
          className="ghost ends"
          onClick={() => {
            // Discard takes itself away with the changes, and the keyboard with it.
            onDiscard();
            focusTab(current);
          }}
        >
          Discard
        </button>
      )}

      {/* Off while a run is out, but said rather than set: a button switched off in the hand that
          pressed it loses the focus in some browsers, and a run that ends in a refusal leaves it
          on again with the reader still on it. */}
      <button
        ref={deployButton}
        type="button"
        className={styles.deploy}
        disabled={nothing}
        aria-disabled={deploying || undefined}
        onClick={() => {
          if (!deploying) onDeploy();
        }}
      >
        {deploying ? 'Deploying…' : 'Deploy'}
      </button>
    </div>
  );
}

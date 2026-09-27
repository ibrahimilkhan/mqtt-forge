import type { FlowDto, FlowRunStatusDto } from '../../types/api';
import { useFlowDraftStore } from './flowDraftStore';
import styles from './Toolbar.module.css';

type Props = {
  flows: FlowDto[];
  /** Flows whose draft differs from what is running, and flows never deployed. */
  changed: ReadonlySet<string>;
  current: string;
  running: Readonly<Record<string, FlowRunStatusDto>>;
  deploying: boolean;
  onNew: () => void;
  /** Puts the flow on screen back to what is running. Left out when there is nothing to go back to. */
  onDiscard?: () => void;
  onDeploy: () => void;
};

/**
 * The flows as tabs, and the one action that changes what runs.
 *
 * Deploy sends every changed flow, not the one on screen: a reader who edited two flows and
 * pressed Deploy meant both, and a button that quietly left one behind would leave a draft
 * nobody remembers making. Discard is only about the flow on screen, and only offered when that
 * flow has a deployed version to go back to. For a flow never deployed, going back would throw
 * the whole flow away, and that is Delete flow's job, which asks first.
 */
export function Toolbar({ flows, changed, current, running, deploying, onNew, onDiscard, onDeploy }: Props) {
  const show = useFlowDraftStore((state) => state.show);
  const refusals = useFlowDraftStore((state) => state.refusals);
  const count = changed.size;

  return (
    <div className={styles.toolbar}>
      <span className={styles.beta} title="Flows are an experiment: how they are drawn and kept may change between versions.">
        Experimental
      </span>

      {/* The + scrolls with the tabs, so it is always just after the last one. It stands beside
          the tab list rather than in it, because ARIA lets a tab list own tabs and nothing else. */}
      <div className={styles.tabs}>
        <div className={styles.tabList} role="tablist" aria-label="Tabs">
          {flows.map((flow) => (
            <button
              key={flow.id}
              type="button"
              role="tab"
              aria-selected={flow.id === current}
              aria-controls="flow-canvas"
              className={styles.tab}
              data-state={refusals[flow.id] ? 'refused' : running[flow.id] ? 'running' : 'stopped'}
              onClick={() => show(flow.id)}
            >
              <span className={styles.lamp} aria-hidden="true" />
              {flow.name.trim() || 'Untitled'}
              {changed.has(flow.id) && (
                <span className={styles.changed}>
                  <span aria-hidden="true">•</span>
                  <span className="srOnly">, not deployed</span>
                </span>
              )}
            </button>
          ))}
        </div>

        <button type="button" className={`ghost ${styles.add}`} aria-label="New flow" title="New flow" onClick={onNew}>
          +
        </button>
      </div>

      <span className={styles.count} aria-live="polite">
        {count === 0 ? 'All deployed' : `${count} ${count === 1 ? 'change' : 'changes'}`}
      </span>

      {onDiscard && (
        <button type="button" className="ghost ends" onClick={onDiscard}>
          Discard
        </button>
      )}

      <button type="button" disabled={count === 0 || deploying} onClick={onDeploy}>
        {deploying ? 'Deploying…' : 'Deploy'}
      </button>
    </div>
  );
}

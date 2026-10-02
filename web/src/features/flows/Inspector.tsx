import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useContext, useState } from 'react';
import { flushSync } from 'react-dom';
import { deleteFlow, isFlowUnknown } from '../../api/flows';
import { queryKeys } from '../../api/queryKeys';
import { Field } from '../../components/Field';
import { nodeKey, useFlowStatusStore } from '../../stores/flowStatusStore';
import { logFault } from '../../stores/logStore';
import panel from '../../styles/panel.module.css';
import type { FlowDto, FlowNodeDto, FlowsDto } from '../../types/api';
import { Failures } from './failures';
import { focusCanvas } from './FlowCanvas';
import { fingerprint, removeNodes, setConfig, type Problems } from './flowDocument';
import { useFlowDraftStore } from './flowDraftStore';
import { NodeSettings } from './NodeSettings';
import { specOf } from './nodeTypes';
import { focusShownTab } from './Toolbar';
import styles from './Inspector.module.css';

type Facts = { allowWebhooks: boolean; alertTopicPrefix: string };

type Props = {
  flow: FlowDto;
  /** The flow as the server has it, or undefined when it has none: never deployed, or deleted since. */
  deployed: FlowDto | undefined;
  running: boolean;
  /** The flow's draft was started from a copy the server has since replaced, or deleted. */
  overtaken: boolean;
  /** What the server said last, keyed flow / node:{id} / edge:{id}. */
  problems: Problems;
  facts: Facts;
};

/** The picked node's settings, or — with nothing picked — the flow's own. */
export function Inspector({ flow, deployed, running, overtaken, problems, facts }: Props) {
  const selected = useFlowDraftStore((state) => state.selected);
  const node = flow.nodes.find((one) => one.id === selected);

  return (
    <aside className={styles.inspector} aria-label="Inspector">
      {node ? (
        <NodePane flow={flow} node={node} problems={problems[`node:${node.id}`]} facts={facts} />
      ) : (
        <FlowPane flow={flow} deployed={deployed} running={running} overtaken={overtaken} problems={problems} />
      )}
    </aside>
  );
}

function NodePane({ flow, node, problems, facts }: { flow: FlowDto; node: FlowNodeDto; problems?: readonly string[]; facts: Facts }) {
  const edit = useFlowDraftStore((state) => state.edit);
  const select = useFlowDraftStore((state) => state.select);
  const spec = specOf(node.type);
  // The server's last word on the node as it runs: the value it last read or sent, or what last
  // went wrong. The status line under the node counts errors; this says what they were. A value
  // with nothing in it is said to be empty, as the pane says "(no topic)" of an alarm's.
  const note = useFlowStatusStore((state) => state.nodes[nodeKey(flow.id, node.id)]?.note ?? null);

  // Merged into the settings as they are in the draft at the moment of the keystroke, not as they
  // were when this render happened: two quick keystrokes in two boxes must both survive.
  const set = (patch: Record<string, unknown>) =>
    edit(flow, (current) =>
      setConfig(current, node.id, { ...(current.nodes.find((one) => one.id === node.id)?.config ?? node.config), ...patch }),
    );

  return (
    <>
      <div className={styles.paneHead}>
        <h3 className={styles.title}>{spec.label}</h3>
        <span className={styles.kind}>{spec.blurb}</span>
      </div>

      {problems?.map((problem) => (
        <p key={problem} className={panel.fault}>
          {problem}
        </p>
      ))}

      {note !== null && (
        <p className={panel.note}>
          Last: <span className={styles.mono}>{note || '(empty)'}</span>
        </p>
      )}

      <NodeSettings flowId={flow.id} node={node} set={set} facts={facts} />

      {node.type === 'alarm' && <Standing flowId={flow.id} nodeId={node.id} />}

      <div className={panel.actions}>
        <button
          type="button"
          className="ghost ends"
          onClick={() => {
            edit(flow, (current) => removeNodes(current, [node.id]));
            select(null);
            // The pane goes with the node, and this button with it. The reader was working on the
            // canvas, and goes back to it.
            focusCanvas();
          }}
        >
          Remove node
        </button>
      </div>
    </>
  );
}

/** How much of a node's line a wire's problem quotes: about what the node shows before it cuts it. */
const QUOTED = 30;

/**
 * A node as the canvas draws it: its type, and the line under that which says its settings. The
 * type alone reads "If → If" for two nodes of one type; the line is what tells them apart there.
 * A line longer than the node is cut, as the node cuts it.
 */
function drawnAs(node: FlowNodeDto): string {
  const spec = specOf(node.type);
  const line = Array.from(spec.summary(node.config));
  return `${spec.label} (${line.length > QUOTED ? `${line.slice(0, QUOTED - 1).join('')}…` : line.join('')})`;
}

/**
 * What the server said about the flow as a whole, and about each of its wires. A node's own
 * problems are in its pane and on the node; a wire has no pane, and on the canvas only its colour,
 * so this is the one place its reason is said — named by the nodes it runs between, as the reader
 * sees them drawn. A wire the flow no longer has is not listed, as a node that is gone has no pane.
 */
function flowProblems(flow: FlowDto, problems: Problems): string[] {
  const nameOf = (nodeId: string) => {
    const node = flow.nodes.find((one) => one.id === nodeId);
    return node ? drawnAs(node) : nodeId;
  };

  return [
    ...(problems.flow ?? []),
    ...flow.edges.flatMap((edge) =>
      (problems[`edge:${edge.id}`] ?? []).map((problem) => `${nameOf(edge.from)} → ${nameOf(edge.to)}: ${problem}`),
    ),
  ];
}

type FlowPaneProps = { flow: FlowDto; deployed: FlowDto | undefined; running: boolean; overtaken: boolean; problems: Problems };

function FlowPane({ flow, deployed, running, overtaken, problems }: FlowPaneProps) {
  const edit = useFlowDraftStore((state) => state.edit);
  const rebase = useFlowDraftStore((state) => state.rebase);
  const discard = useFlowDraftStore((state) => state.discard);
  // What last stopped the running flow: an event that ran too many nodes, say.
  const fault = useFlowStatusStore((state) => state.flows[flow.id]?.fault ?? null);
  const queryClient = useQueryClient();
  const failures = useContext(Failures);
  const [asking, setAsking] = useState(false);

  // Either answer takes the question away, and the keyboard with it. The reader goes to the tab of
  // the flow on screen: this one, or — once a discard has let a flow deleted elsewhere go — the
  // next, which has to be drawn before it can be given the focus.
  const choose = (choice: () => void) => {
    flushSync(choice);
    focusShownTab();
  };

  const remove = useMutation({
    // A flow that was never deployed has nothing on the server to delete. One the server says it
    // does not have was deleted on another console since this one last read the list: it is gone
    // either way, which is what the reader asked for.
    mutationFn: async (id: string) => {
      if (!deployed) return;
      try {
        await deleteFlow(id);
      } catch (error) {
        if (!isFlowUnknown(error)) throw error;
      }
    },
    onMutate: () => failures.trying('delete'),
    // The id comes with the answer rather than from the flow on screen: a mutation still out is
    // handed the callbacks of the latest render, and by the time the answer comes the reader may
    // be looking at another flow.
    onSuccess: async (_, id) => {
      // A read of the list already out was answered before the delete, and would put the flow back.
      await queryClient.cancelQueries({ queryKey: queryKeys.flows });
      // Out of the list at once, not when the read after the delete comes back: until then its tab
      // would stay, and the page would go on showing the flow that is gone.
      queryClient.setQueryData<FlowsDto>(
        queryKeys.flows,
        (old) =>
          old && {
            ...old,
            flows: old.flows.filter((one) => one.id !== id),
            problems: old.problems.filter((problem) => problem.flowId !== id),
          },
      );
      discard(id);
      useFlowStatusStore.getState().forget(id);
      void queryClient.invalidateQueries({ queryKey: queryKeys.flows });
    },
    // The page covers the log, so the page says it too.
    onError: (error, id) => {
      logFault('Flow not deleted', error);
      failures.failed('delete', id, error);
    },
  });

  const state = running
    ? 'Running.'
    : !deployed
      ? overtaken
        ? 'Not on the server.'
        : 'Never deployed.'
      : deployed.enabled
        ? 'Not running. Deploy it to start it.'
        : 'Off.';

  return (
    <>
      <div className={styles.paneHead}>
        <h3 className={styles.title}>{flow.name.trim() || 'Untitled'}</h3>
      </div>

      {/* Sent as it stands, this draft would undo what another console deployed, or bring back a
          flow somebody deleted. So Deploy leaves it out until the reader says which it is to be. */}
      {overtaken && (
        <div className={styles.overtaken}>
          <p className={panel.fault}>
            {deployed
              ? 'Changed on the server since you started, so Deploy holds your changes back. Keep yours to deploy them over it, or discard them for what the server has now.'
              : 'Deleted on the server since you started, so Deploy holds your changes back. Keep yours to deploy the flow again, or discard them.'}
          </p>
          <div className={panel.actions}>
            <button type="button" className="ghost" onClick={() => choose(() => rebase(flow.id, deployed ? fingerprint(deployed) : null))}>
              Keep mine
            </button>
            <button type="button" className="ghost ends" onClick={() => choose(() => discard(flow.id))}>
              Discard
            </button>
          </div>
        </div>
      )}

      {flowProblems(flow, problems).map((problem, index) => (
        <p key={index} className={panel.fault}>
          {problem}
        </p>
      ))}

      <Field label="Name" htmlFor={`${flow.id}-name`}>
        <input
          id={`${flow.id}-name`}
          value={flow.name}
          maxLength={80}
          onChange={(event) => edit(flow, (current) => ({ ...current, name: event.target.value }))}
        />
      </Field>

      <label className={styles.check}>
        <input
          type="checkbox"
          checked={flow.enabled}
          onChange={(event) => edit(flow, (current) => ({ ...current, enabled: event.target.checked }))}
        />
        Run it once deployed
      </label>

      <p className={panel.note}>{state}</p>
      {fault !== null && <p className={panel.fault}>{fault}</p>}

      {flow.nodes.length === 0 && (
        <p className={panel.hint}>Add a trigger from the left, wire it to an action, and press Deploy.</p>
      )}

      {!asking ? (
        <div className={panel.actions}>
          <button type="button" className="ghost ends" onClick={() => setAsking(true)}>
            Delete flow
          </button>
        </div>
      ) : (
        <div className={styles.confirm}>
          <p>
            {deployed
              ? `Delete ${flow.name}? It stops running.`
              : overtaken
                ? `Drop ${flow.name}? It is no longer on the server.`
                : `Drop ${flow.name}? It was never deployed.`}
          </p>
          <div className={panel.actions}>
            <button type="button" className="ghost" onClick={() => setAsking(false)}>
              Keep it
            </button>
            {/* Off while the delete is out, but said rather than set, as Deploy is: a button switched
                off in the hand that pressed it loses the focus in some browsers, and a delete that
                fails leaves the reader on it to try again. */}
            <button
              type="button"
              className="ends"
              aria-disabled={remove.isPending || undefined}
              onClick={() => {
                if (!remove.isPending) remove.mutate(flow.id);
              }}
            >
              Delete it
            </button>
          </div>
        </div>
      )}
    </>
  );
}

/** Hours and minutes, the way the alerts panel says a time. */
const clock = (at: string) =>
  new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });

function Standing({ flowId, nodeId }: { flowId: string; nodeId: string }) {
  const standing = useFlowStatusStore((state) => state.nodes[nodeKey(flowId, nodeId)]?.standing);

  if (!standing || standing.length === 0) return <p className={panel.note}>No alarm is up.</p>;

  return (
    <section className={styles.standing} aria-label="Up now">
      <h4 className={styles.subTitle}>Up now</h4>
      <ul className={styles.list}>
        {standing.map((alarm) => (
          <li key={alarm.topic} className={styles.alarm}>
            <span className={styles.mono}>{alarm.topic || '(no topic)'}</span>
            <span>{alarm.reason}</span>
            <span className={styles.since}>
              since {clock(alarm.firedAt)} · {alarm.count}×
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

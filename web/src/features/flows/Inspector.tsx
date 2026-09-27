import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { deleteFlow } from '../../api/flows';
import { queryKeys } from '../../api/queryKeys';
import { Field } from '../../components/Field';
import { nodeKey, useFlowStatusStore } from '../../stores/flowStatusStore';
import { logFault } from '../../stores/logStore';
import panel from '../../styles/panel.module.css';
import type { FlowDto, FlowNodeDto, FlowsDto } from '../../types/api';
import { removeNodes, setConfig, type Problems } from './flowDocument';
import { useFlowDraftStore } from './flowDraftStore';
import { NodeSettings } from './NodeSettings';
import { NODE_SPECS } from './nodeTypes';
import styles from './Inspector.module.css';

type Facts = { allowWebhooks: boolean; alertTopicPrefix: string };

type Props = {
  flow: FlowDto;
  /** The flow as it is running, or undefined when it was never deployed. */
  deployed: FlowDto | undefined;
  running: boolean;
  /** What the server said last, keyed flow / node:{id} / edge:{id}. */
  problems: Problems;
  facts: Facts;
};

/** The picked node's settings, or — with nothing picked — the flow's own. */
export function Inspector({ flow, deployed, running, problems, facts }: Props) {
  const selected = useFlowDraftStore((state) => state.selected);
  const node = flow.nodes.find((one) => one.id === selected);

  return (
    <aside className={styles.inspector} aria-label="Inspector">
      {node ? (
        <NodePane flow={flow} node={node} problems={problems[`node:${node.id}`]} facts={facts} />
      ) : (
        <FlowPane flow={flow} deployed={deployed} running={running} problems={problems.flow} />
      )}
    </aside>
  );
}

function NodePane({ flow, node, problems, facts }: { flow: FlowDto; node: FlowNodeDto; problems?: readonly string[]; facts: Facts }) {
  const edit = useFlowDraftStore((state) => state.edit);
  const select = useFlowDraftStore((state) => state.select);
  const spec = NODE_SPECS[node.type];

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

      <NodeSettings flowId={flow.id} node={node} set={set} facts={facts} />

      {node.type === 'alarm' && <Standing flowId={flow.id} nodeId={node.id} />}

      <div className={panel.actions}>
        <button
          type="button"
          className="ghost ends"
          onClick={() => {
            edit(flow, (current) => removeNodes(current, [node.id]));
            select(null);
          }}
        >
          Remove node
        </button>
      </div>
    </>
  );
}

function FlowPane({ flow, deployed, running, problems }: { flow: FlowDto; deployed: FlowDto | undefined; running: boolean; problems?: readonly string[] }) {
  const edit = useFlowDraftStore((state) => state.edit);
  const forget = useFlowDraftStore((state) => state.forget);
  const queryClient = useQueryClient();
  const [asking, setAsking] = useState(false);

  const remove = useMutation({
    // A flow that was never deployed has nothing on the server to delete.
    mutationFn: async (id: string) => {
      if (deployed) await deleteFlow(id);
    },
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
      forget(id);
      useFlowStatusStore.getState().forget(id);
      void queryClient.invalidateQueries({ queryKey: queryKeys.flows });
    },
    onError: (error) => logFault('Flow not deleted', error),
  });

  const state = running
    ? 'Running.'
    : !deployed
      ? 'Never deployed.'
      : deployed.enabled
        ? 'Not running. Deploy it to start it.'
        : 'Off.';

  return (
    <>
      <div className={styles.paneHead}>
        <h3 className={styles.title}>{flow.name.trim() || 'Untitled'}</h3>
      </div>

      {problems?.map((problem) => (
        <p key={problem} className={panel.fault}>
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
          <p>{deployed ? `Delete ${flow.name}? It stops running.` : `Drop ${flow.name}? It was never deployed.`}</p>
          <div className={panel.actions}>
            <button type="button" className="ghost" onClick={() => setAsking(false)}>
              Keep it
            </button>
            <button type="button" className="ends" disabled={remove.isPending} onClick={() => remove.mutate(flow.id)}>
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

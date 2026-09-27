import { useQuery } from '@tanstack/react-query';
import { ReactFlowProvider, useReactFlow } from '@xyflow/react';
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { getFlows, getFlowStatus } from '../../api/flows';
import { queryKeys } from '../../api/queryKeys';
import { describeError } from '../../lib/problemDetails';
import { useFlowStatusStore } from '../../stores/flowStatusStore';
import panel from '../../styles/panel.module.css';
import type { FlowNodeType } from '../../types/api';
import { DebugStrip } from './DebugStrip';
import { exampleFlows } from './examples';
import { FlowCanvas } from './FlowCanvas';
import { addNode, emptyFlow, newId, nextName, problemsOf, sameFlow, withDrafts, type Problems } from './flowDocument';
import { useFlowDraftStore } from './flowDraftStore';
import { Inspector } from './Inspector';
import { Palette } from './Palette';
import { Toolbar } from './Toolbar';
import { useDeploy } from './useDeploy';
import styles from './FlowsPage.module.css';

/**
 * The problems of a flow with none. One object for every render: the canvas rebuilds its nodes when
 * what it is handed changes, and the page renders again on every push of the numbers.
 */
const NOTHING_WRONG: Problems = {};

/**
 * The Flows page. The default export, because React.lazy loads a module's default.
 *
 * A browser with no ResizeObserver cannot size a canvas, so it is told so rather than shown a
 * blank one. Every browser this console supports has it; the only place without it is jsdom,
 * which is why the test suite sees this sentence when it opens every panel in turn.
 */
export default function FlowsPage() {
  if (typeof ResizeObserver === 'undefined')
    return <p className={styles.missing}>The canvas needs a browser that can measure what it draws.</p>;

  return (
    <ReactFlowProvider>
      <Page />
    </ReactFlowProvider>
  );
}

function Page() {
  const { data, isPending } = useQuery({ queryKey: queryKeys.flows, queryFn: getFlows });
  const drafts = useFlowDraftStore((state) => state.drafts);
  const current = useFlowDraftStore((state) => state.current);
  const refusals = useFlowDraftStore((state) => state.refusals);
  const running = useFlowStatusStore((state) => state.flows);
  const deploy = useDeploy();
  const { screenToFlowPosition } = useReactFlow();
  const added = useRef(0);

  // The numbers the hub has not pushed since the page opened. The store may already hold them —
  // the bridge feeds it from the moment the console opens — and this only fills a first gap.
  // Pushes carry nothing to put them in order by, so the answer is kept only if no push has come
  // in while it was out: one that has is newer than the answer. Every push builds a new picture,
  // which is what makes an identity check enough. A page that has shut has no gap left to fill.
  useEffect(() => {
    let open = true;
    const asked = useFlowStatusStore.getState().flows;

    getFlowStatus().then(
      (status) => {
        if (open && useFlowStatusStore.getState().flows === asked) useFlowStatusStore.getState().setStatus(status);
      },
      () => {},
    );

    return () => {
      open = false;
    };
  }, []);

  const deployed = useMemo(() => data?.flows ?? [], [data]);
  const byId = useMemo(() => new Map(deployed.map((flow) => [flow.id, flow])), [deployed]);
  const flows = useMemo(() => withDrafts(deployed, drafts), [deployed, drafts]);
  const changed = useMemo(
    () => new Set(flows.filter((flow) => drafts[flow.id] && !sameFlow(drafts[flow.id], byId.get(flow.id))).map((flow) => flow.id)),
    [flows, drafts, byId],
  );
  const serverProblems = useMemo(() => problemsOf(data?.problems ?? []), [data]);

  // What the server has said is wrong with each flow: its answer to this page's last deploy of it,
  // or else what it found reading its own file. The tabs, the canvas and the inspector all mark
  // this one answer, so no pane can call a flow clean that another marks as wrong.
  const problems = useMemo(() => ({ ...serverProblems, ...refusals }), [serverProblems, refusals]);
  const refused = useMemo(() => new Set(Object.keys(problems)), [problems]);

  // A flow edited back to what is running has no draft left for its refusal to be about. Only the
  // page holds both halves of that comparison, so it is the one that tells the store. Before the
  // paint, so the flow is never drawn for a frame with the old refusal still on it.
  useLayoutEffect(() => {
    const lapsed = Object.keys(refusals).filter((id) => !changed.has(id));
    if (lapsed.length > 0) useFlowDraftStore.getState().lapse(lapsed);
  }, [changed, refusals]);

  if (isPending) return <p className={styles.missing}>Reading the flows…</p>;

  // Only when there has never been an answer. A read that fails once the flows are on screen
  // keeps them there: the drafts are all still here, and a deploy says for itself when the
  // server cannot be reached.
  if (!data)
    return <p className={panel.fault}>The flows could not be read from the server. Nothing here has changed.</p>;

  if (data.unreadable)
    return (
      <p className={panel.fault}>
        The flows file could not be read, so no flows are running. Repair it or move it aside; nothing here will write over it.
      </p>
    );

  const shown = flows.find((flow) => flow.id === current) ?? flows[0];
  if (!shown) return <Start />;

  // For its actions, which the handlers below call when they run. Actions never change, so a
  // subscription to them would only re-render the page for nothing.
  const store = useFlowDraftStore.getState();

  // A click in the palette puts the node in the middle of what is on screen, each one a little
  // down and to the right of the last, so three clicks are three nodes and not one stack.
  const add = (type: FlowNodeType) => {
    const box = document.getElementById('flow-canvas')?.getBoundingClientRect();
    const nudge = (added.current++ % 6) * 24;
    const at = screenToFlowPosition({
      x: (box ? box.left + box.width / 2 : 0) - 94 + nudge,
      y: (box ? box.top + box.height / 2 : 0) - 40 + nudge,
    });
    const id = newId('n');

    store.edit(shown, (flow) => addNode(flow, type, at, id));
    store.select(id);
  };

  return (
    <div className={styles.page}>
      <div className={styles.top}>
        <Toolbar
          flows={flows}
          changed={changed}
          current={shown.id}
          running={running}
          refused={refused}
          deploying={deploy.isPending}
          onNew={() => {
            const flow = emptyFlow(nextName(flows));
            store.put(flow);
            store.show(flow.id);
          }}
          onDiscard={changed.has(shown.id) && byId.has(shown.id) ? () => store.discard(shown.id) : undefined}
          onDeploy={() => deploy.mutate(flows.filter((flow) => changed.has(flow.id)))}
        />

        {/* The page covers the log, so a deploy that did not go through says why here as well.
            A refusal is not one of these: it marks the nodes it is about instead. */}
        {deploy.isError && <p className={panel.fault}>Not deployed. {describeError(deploy.error)}</p>}
      </div>

      <div className={styles.body}>
        <Palette onAdd={add} />
        <FlowCanvas key={shown.id} flow={shown} running={running[shown.id] !== undefined} problems={problems[shown.id] ?? NOTHING_WRONG} />
        <Inspector
          flow={shown}
          deployed={byId.get(shown.id)}
          running={running[shown.id] !== undefined}
          problems={problems[shown.id] ?? NOTHING_WRONG}
          facts={{ allowWebhooks: data.allowWebhooks, alertTopicPrefix: data.alertTopicPrefix }}
        />
      </div>

      <DebugStrip flow={shown} />
    </div>
  );
}

/** No flows at all: what the page is for, and the two ways to start. */
function Start() {
  const put = useFlowDraftStore((state) => state.put);
  const show = useFlowDraftStore((state) => state.show);

  return (
    <div className={styles.start}>
      <p>
        Draw what should happen to a message — raise an <b>alarm</b>, <b>publish</b> an answer — and deploy it. Deployed
        flows run on the server, with this page open or not.
      </p>
      <div className={panel.actions}>
        <button
          type="button"
          onClick={() => {
            const flows = exampleFlows();
            flows.forEach(put);
            show(flows[0].id);
          }}
        >
          Start from an example
        </button>
        <button
          type="button"
          className="ghost"
          onClick={() => {
            const flow = emptyFlow('Flow 1');
            put(flow);
            show(flow.id);
          }}
        >
          New flow
        </button>
      </div>
    </div>
  );
}

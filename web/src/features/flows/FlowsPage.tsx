import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ReactFlowProvider, useReactFlow } from '@xyflow/react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useShallow } from 'zustand/react/shallow';
import { getFlows } from '../../api/flows';
import { queryKeys } from '../../api/queryKeys';
import { describeError } from '../../lib/problemDetails';
import { alarmSource, useFlowAlarmStore } from '../../stores/flowAlarmStore';
import { catchUp, isLive, shownRun, useFlowStatusStore } from '../../stores/flowStatusStore';
import panel from '../../styles/panel.module.css';
import type { FlowDto, FlowNodeType, FlowsDto } from '../../types/api';
import { DebugStrip } from './DebugStrip';
import { exampleFlows } from './examples';
import { Failures, type Attempt } from './failures';
import { CANVAS, FlowCanvas, NODE_HEIGHT, NODE_WIDTH } from './FlowCanvas';
import {
  addNode,
  emptyFlow,
  freeSpot,
  newId,
  nextName,
  placesInView,
  problemsOf,
  standingOf,
  titleOf,
  withDrafts,
  type DraftStanding,
  type Problems,
} from './flowDocument';
import { useFlowDraftStore } from './flowDraftStore';
import { Inspector } from './Inspector';
import { Palette } from './Palette';
import { FLOW_PANEL, focusTab, tabIdOf, Toolbar } from './Toolbar';
import { useDeploy } from './useDeploy';
import styles from './FlowsPage.module.css';

/**
 * The problems of a flow with none. One object for every render: the canvas rebuilds its nodes when
 * what it is handed changes, and the page renders again on every push of the numbers.
 */
const NOTHING_WRONG: Problems = {};

/** The room left between a node the palette adds and the nodes already on the canvas. */
const ROOM = 24;

/** The room a node takes, as the palette reckons it when it puts one down. */
const NODE_BOX = { width: NODE_WIDTH, height: NODE_HEIGHT };

/** The empty page's first way to start, where the keyboard goes once the last flow has gone. */
const START = 'flows-start';

/** What the page says of the flows a deploy had refused, by their names: "A", "A and B", "A, B and C". */
function refusedIn(names: readonly string[]): string {
  if (names.length === 1) return `The server refused ${names[0]}, so it was not deployed. What it refused is marked on it.`;

  const listed = `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `The server refused ${listed}, so they were not deployed. What it refused is marked on each.`;
}

/** A delete that did not go through: the flow it was about, and why. */
type Failed = { name: string; reason: string };

/** The flows whose drafts stand as `wanted`. */
const standingAs = (standings: ReadonlyArray<readonly [string, DraftStanding]>, wanted: DraftStanding) =>
  new Set(standings.flatMap(([id, standing]) => (standing === wanted ? [id] : [])));

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
  const bases = useFlowDraftStore((state) => state.bases);
  const current = useFlowDraftStore((state) => state.current);
  const refusals = useFlowDraftStore((state) => state.refusals);
  const unkept = useFlowDraftStore((state) => state.unkept);
  const asked = useFlowAlarmStore((state) => state.asked);
  // Which flows have a run going, and nothing else of the numbers: that is all the page draws of them,
  // and every push brings a new picture. Taken whole, each push drew the whole page again.
  const runningIds = useFlowStatusStore(
    useShallow((state) => Object.keys(state.runs).filter((id) => isLive(shownRun(state.runs[id])))),
  );
  const running = useMemo(() => new Set(runningIds), [runningIds]);
  const deploy = useDeploy();
  const { screenToFlowPosition } = useReactFlow();

  // What did not go through besides a deploy, by what was tried — see failures.ts. The inspector
  // is handed the way to say it; the page says it, under the tabs, where it stays whichever flow is
  // on screen. So it names the flow it is about, as the flow was named when it failed: in a live
  // region, a name that followed a rename would be read out with every letter.
  const queryClient = useQueryClient();
  const [failed, setFailed] = useState<Record<Attempt, Failed | null>>({ delete: null });
  const failures = useMemo<Failures>(
    () => ({
      trying: (attempt) => setFailed((was) => (was[attempt] === null ? was : { ...was, [attempt]: null })),
      failed: (attempt, flowId, error) => {
        const flow =
          useFlowDraftStore.getState().drafts[flowId] ??
          queryClient.getQueryData<FlowsDto>(queryKeys.flows)?.flows.find((one) => one.id === flowId);
        const name = flow ? titleOf(flow) : flowId;
        setFailed((was) => ({ ...was, [attempt]: { name, reason: describeError(error) } }));
      },
    }),
    [queryClient],
  );

  // The numbers the hub has not pushed since the page opened. The store may already hold them —
  // the bridge feeds it from the moment the console opens — and this only fills a first gap. A page
  // that has shut has no gap left to fill.
  useEffect(() => catchUp(), []);

  const deployed = useMemo(() => data?.flows ?? [], [data]);
  const byId = useMemo(() => new Map(deployed.map((flow) => [flow.id, flow])), [deployed]);
  const deployedIds = useMemo(() => new Set(byId.keys()), [byId]);
  const flows = useMemo(() => withDrafts(deployed, drafts), [deployed, drafts]);

  // How each draft stands against the server's copy of its flow — see standingOf. Worked out on
  // every frame of a drag, and cheap for all but the flow being dragged: what it asks is kept
  // against each flow object.
  const standings = useMemo(
    () => Object.entries(drafts).map(([id, draft]) => [id, standingOf(draft, bases[id] ?? null, byId.get(id))] as const),
    [bases, byId, drafts],
  );
  // What Deploy sends, and what it holds back until the reader keeps it or lets it go.
  const changed = useMemo(() => standingAs(standings, 'changed'), [standings]);
  const overtaken = useMemo(() => standingAs(standings, 'overtaken'), [standings]);
  const serverProblems = useMemo(() => problemsOf(data?.problems ?? []), [data]);

  // What the server has said is wrong with each flow: its answer to this page's last deploy of it,
  // or else what it found reading its own file. The tabs, the canvas and the inspector all mark
  // this one answer, so no pane can call a flow clean that another marks as wrong.
  const problems = useMemo(() => ({ ...serverProblems, ...refusals }), [serverProblems, refusals]);
  const refused = useMemo(() => new Set(Object.keys(problems)), [problems]);

  // The flows the last deploy had refused, while their refusals stand. Named as they were sent:
  // said in a live region, a name read from the draft would be said again with every letter of a
  // rename.
  const stillRefused = deploy.isSuccess ? deploy.data.filter((one) => one.id in refusals) : [];

  // A draft that holds nothing of the reader's goes: kept, it would hide a newer copy another
  // console deploys, and go back out over it with the next Deploy of anything. Only the page holds
  // both halves of that comparison, so it is the one that tells the store; before the paint, so no
  // frame shows a change that is not one; and only once the server's copies have been read, since
  // until then every flow would look deleted.
  //
  // A flow on its way to the server keeps its draft until the answer comes. What was typed in the
  // meantime is an edit of the copy that was sent (see useDeploy), and taken back to the copy the
  // server had, it says to undo the change, not that there is nothing to keep.
  const sending = deploy.isPending ? deploy.variables : undefined;
  useLayoutEffect(() => {
    if (!data || data.unreadable) return;

    const spent = standings.flatMap(([id, standing]) =>
      standing === 'nothing' && !sending?.some((flow) => flow.id === id) ? [id] : [],
    );
    if (spent.length > 0) useFlowDraftStore.getState().settle(spent);
  }, [data, sending, standings]);

  // A refusal is the server's answer about a draft. One whose draft has gone — taken back, or let go
  // in another tab — has nothing left to be about.
  useLayoutEffect(() => {
    const lapsed = Object.keys(refusals).filter((id) => !(id in drafts));
    if (lapsed.length > 0) useFlowDraftStore.getState().lapse(lapsed);
  }, [drafts, refusals]);

  // A flow alarm the reader asked to see, from its row on the alarm wall: the page opens on the
  // flow it came from, with its Alarm node picked. Only once the flows are read, since until then
  // none of them can be found; and one no flow has any more is let go.
  useLayoutEffect(() => {
    if (asked === null || !data) return;

    const source = data.unreadable ? null : alarmSource(asked, deployed);
    if (source) {
      useFlowDraftStore.getState().show(source.flowId);
      useFlowDraftStore.getState().select(source.nodeId);
    }
    useFlowAlarmStore.getState().answered();
  }, [asked, data, deployed]);

  const shown = flows.find((flow) => flow.id === current) ?? flows[0];

  // The flow on screen went — deleted here or on another console — and took whatever the keyboard
  // was on with it: its pane's own buttons, its tab, a node. A browser hands that focus to the
  // body, and the next Tab starts again from the top of the document. The reader goes to the tab of
  // the flow now on screen instead, or, with no flow left, to the first way to start one. Only when
  // the focus did fall: a reader who has gone on to something else stays there.
  const wasShown = useRef(shown?.id ?? null);
  useLayoutEffect(() => {
    const was = wasShown.current;
    wasShown.current = shown?.id ?? null;
    if (was === null || was === wasShown.current || flows.some((flow) => flow.id === was)) return;
    if (document.activeElement !== null && document.activeElement !== document.body) return;

    if (shown) focusTab(shown.id);
    else document.getElementById(START)?.focus();
  }, [flows, shown]);

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

  if (!shown) return <Start />;

  // For its actions, which the handlers below call when they run. Actions never change, so a
  // subscription to them would only re-render the page for nothing.
  const store = useFlowDraftStore.getState();

  // A click in the palette puts the node in the middle of what is on screen, or, when something is
  // already there, in the first clear place across from it and then down a row — as many across as
  // fit between the middle and the right edge of the view — so three clicks are three nodes that
  // can each be read and grabbed, and not one stack.
  const add = (type: FlowNodeType) => {
    const box = document.getElementById(CANVAS)?.getBoundingClientRect();
    const middle = screenToFlowPosition({ x: box ? box.left + box.width / 2 : 0, y: box ? box.top + box.height / 2 : 0 });
    const right = screenToFlowPosition({ x: box ? box.right : 0, y: 0 }).x;
    const { start, across } = placesInView(middle, right, NODE_BOX, ROOM);
    const at = freeSpot(shown, start, NODE_BOX, across, ROOM);
    const id = newId('n');

    store.edit(shown, (flow) => addNode(flow, type, at, id));
    store.select(id);
  };

  return (
    <Failures.Provider value={failures}>
      <div className={styles.page}>
        <div className={styles.top}>
          <Toolbar
            flows={flows}
            changed={changed}
            overtaken={overtaken}
            deployed={deployedIds}
            current={shown.id}
            running={running}
            refused={refused}
            deploying={deploy.isPending}
            onNew={() => {
              const flow = emptyFlow(nextName(flows));
              store.put(flow);
              store.show(flow.id);
            }}
            // Not for a draft held back. Its pane says why it is held, with Keep mine and Discard under
            // the sentence — where the reader is looking when they choose, and the one place both
            // answers are — so a second Discard up here would only ask the same question twice.
            onDiscard={changed.has(shown.id) && byId.has(shown.id) ? () => store.discard(shown.id) : undefined}
            onDeploy={() => deploy.mutate(flows.filter((flow) => changed.has(flow.id)))}
          />

          {/* The page covers the log, so what did not go through is said here: a deploy that
              failed, or that the server refused — which marks the nodes it is about, but a flow
              refused on another tab has only its lamp to show it — a flow not deleted, and drafts
              this browser would not keep. One polite live region, so a reader who cannot see the
              marks is told as well, and nothing in it is drawn from the numbers, so a push of them
              says nothing. */}
          <div aria-live="polite">
            {deploy.isError && <p className={panel.fault}>Not deployed. {describeError(deploy.error)}</p>}
            {stillRefused.length > 0 && <p className={panel.fault}>{refusedIn(stillRefused.map((one) => one.name))}</p>}
            {failed.delete !== null && (
              <p className={panel.fault}>
                {failed.delete.name} was not deleted. {failed.delete.reason}
              </p>
            )}
            {/* Said once, by the first draft the browser refused: its storage is full, or blocked,
                and a reload would bring back what it kept before then without a word. */}
            {unkept && (
              <p className={panel.fault}>
                This browser would not keep the drafts, so a reload may bring back older ones, or none. Deploy what you
                want to keep.
              </p>
            )}
          </div>
        </div>

        {/* What the tabs control: everything under them is about the flow on screen, the palette
            included, since what it adds goes into that flow. */}
        <div id={FLOW_PANEL} role="tabpanel" aria-labelledby={tabIdOf(shown.id)} className={styles.flow}>
          <div className={styles.body}>
            <Palette onAdd={add} />
            {/* Keyed apart as well as by flow: siblings that share a key cannot be told apart, and
                each tab shown would leave its canvas behind in the page. */}
            <FlowCanvas key={`canvas-${shown.id}`} flow={shown} problems={problems[shown.id] ?? NOTHING_WRONG} />
            {/* One inspector per flow, like the canvas: what it holds — a delete it is asking about —
                is about the flow it was opened on, and must not stand over the next one. */}
            <Inspector
              key={`inspector-${shown.id}`}
              flow={shown}
              deployed={byId.get(shown.id)}
              running={running.has(shown.id)}
              overtaken={overtaken.has(shown.id)}
              problems={problems[shown.id] ?? NOTHING_WRONG}
              facts={{ allowWebhooks: data.allowWebhooks }}
            />
          </div>

          <DebugStrip flow={shown} />
        </div>
      </div>
    </Failures.Provider>
  );
}

/** No flows at all: what the page is for, and the two ways to start. */
function Start() {
  const put = useFlowDraftStore((state) => state.put);
  const show = useFlowDraftStore((state) => state.show);

  // Either button takes this whole page away, and the keyboard with it. The reader goes to the tab
  // of the first flow made, which has to be drawn before it can be given the focus.
  const begin = (flows: FlowDto[]) => {
    flushSync(() => {
      for (const flow of flows) put(flow);
      show(flows[0].id);
    });
    focusTab(flows[0].id);
  };

  return (
    <div className={styles.start}>
      <p>
        Draw what should happen to a message — raise an <b>alarm</b>, <b>publish</b> an answer — and deploy it. Deployed
        flows run on the server, with this page open or not.
      </p>
      <div className={panel.actions}>
        <button id={START} type="button" onClick={() => begin(exampleFlows())}>
          Start from an example
        </button>
        <button type="button" className="ghost" onClick={() => begin([emptyFlow('Flow 1')])}>
          New flow
        </button>
      </div>
    </div>
  );
}

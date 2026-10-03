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
  fingerprint,
  freeSpot,
  insertAfter,
  insertOnWire,
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
import { useSave, type Held, type SaveKind, type Unsaved } from './useSave';
import { useTest } from './useTest';
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

/** A delete that did not go through: the flow it was about, and why. */
type Failed = { name: string; reason: string };

/** The flows whose drafts stand as `wanted`. */
const standingAs = (standings: ReadonlyArray<readonly [string, DraftStanding]>, wanted: DraftStanding) =>
  new Set(standings.flatMap(([id, standing]) => (standing === wanted ? [id] : [])));

/**
 * What the page says of a press the list read first held back (see Held), naming the flow as it
 * was pressed, and what was not done in the words of the button pressed. A draft held back is of a
 * flow the server has changed, or — `gone` — no longer has, in the words its tab says it in.
 *
 * A press that found done what it asked for is a note, not a fault: nothing went wrong, and the
 * flow is as the reader wanted it. One that found the flow on, but changed, is a fault all the same
 * — the flow runs, though not as the reader pressed it — and is not called not activated: it is on,
 * and Deactivate beside the tabs says so.
 */
function heldSaying(kind: SaveKind, held: Held, name: string, gone: boolean): { text: string; fault: boolean } {
  const not = kind === 'activate' ? 'activated' : 'saved';

  switch (held) {
    case 'overtaken':
      return {
        text: `${name} was ${gone ? 'deleted' : 'changed'} on another console since you started, so your changes were held back. Keep yours or discard them in the flow’s pane.`,
        fault: true,
      };
    case 'changed':
      return {
        text: `${name} was changed on another console since this page read it, so it was not ${not}. What it has now is on screen.`,
        fault: true,
      };
    case 'changedOn':
      return {
        text: `${name} was changed on another console since this page read it, and switched on there. What it has now is on screen.`,
        fault: true,
      };
    case 'deleted':
      return kind === 'deactivate'
        ? { text: `${name} was deleted on another console, so there was nothing to switch off.`, fault: true }
        : { text: `${name} was deleted on another console, so it was not ${not}.`, fault: true };
    case 'off':
      return kind === 'deactivate'
        ? { text: `${name} was already switched off on another console.`, fault: false }
        : {
            text: `${name} was switched off on another console since this page read it, so your change was not saved. Activate saves it and switches it on.`,
            fault: true,
          };
    case 'on':
      return { text: `${name} was already activated on another console.`, fault: false };
  }
}

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
  const refusedCopies = useFlowDraftStore((state) => state.refusedCopies);
  const unkept = useFlowDraftStore((state) => state.unkept);
  const asked = useFlowAlarmStore((state) => state.asked);
  // Which flows have a run going, and nothing else of the numbers: that is all the page draws of them,
  // and every push brings a new picture. Taken whole, each push drew the whole page again.
  const runningIds = useFlowStatusStore(
    useShallow((state) => Object.keys(state.runs).filter((id) => isLive(shownRun(state.runs[id])))),
  );
  const running = useMemo(() => new Set(runningIds), [runningIds]);
  // Which of those runs are tests, which the toolbar offers to stop: the same care, for the same
  // reason.
  const testingIds = useFlowStatusStore(
    useShallow((state) => Object.keys(state.runs).filter((id) => isLive(state.runs[id].test))),
  );
  const testing = useMemo(() => new Set(testingIds), [testingIds]);
  const save = useSave();
  const test = useTest();
  const { screenToFlowPosition } = useReactFlow();

  // What did not go through besides a save or a test, by what was tried — see failures.ts. The
  // inspector is handed the way to say it; the page says it, under the tabs, where it stays whichever
  // flow is on screen. So it names the flow it is about, as the flow was named when it failed: in a
  // live region, a name that followed a rename would be read out with every letter.
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
  // The flows the server has switched on, whatever their drafts say: a draft never switches one.
  const activeIds = useMemo(() => new Set(deployed.filter((flow) => flow.enabled).map((flow) => flow.id)), [deployed]);
  const flows = useMemo(() => withDrafts(deployed, drafts), [deployed, drafts]);

  // How each draft stands against the server's copy of its flow — see standingOf. Worked out on
  // every frame of a drag, and cheap for all but the flow being dragged: what it asks is kept
  // against each flow object.
  const standings = useMemo(
    () => Object.entries(drafts).map(([id, draft]) => [id, standingOf(draft, bases[id] ?? null, byId.get(id))] as const),
    [bases, byId, drafts],
  );
  // What Activate and Update send, and what they hold back until the reader keeps it or lets it go.
  const changed = useMemo(() => standingAs(standings, 'changed'), [standings]);
  const overtaken = useMemo(() => standingAs(standings, 'overtaken'), [standings]);
  const serverProblems = useMemo(() => problemsOf(data?.problems ?? []), [data]);

  // What the server has said is wrong with each flow: its answer to this page's last save or test
  // of it, or else what it found reading its own file. The tabs, the canvas and the inspector all
  // mark this one answer, so no pane can call a flow clean that another marks as wrong. An answer
  // goes with the draft it was about, however the draft goes: the store sees to that.
  const problems = useMemo(() => ({ ...serverProblems, ...refusals }), [serverProblems, refusals]);
  const refused = useMemo(() => new Set(Object.keys(problems)), [problems]);

  // A draft that holds nothing of the reader's goes: kept, it would hide a newer copy another
  // console saves, and go back out over it with the next Activate or Update. Only the page holds
  // both halves of that comparison, so it is the one that tells the store; before the paint, so no
  // frame shows a change that is not one; and only once the server's copies have been read, since
  // until then every flow would look deleted.
  //
  // A drawing on its way to the server keeps its draft until the answer comes. What was typed in
  // the meantime is an edit of the copy that was sent (see useSave), and taken back to the copy the
  // server had, it says to undo the change, not that there is nothing to keep. Deactivate sends the
  // server's copy, not the drawing, so the drawing is not on its way.
  const sending = save.isPending && save.variables.kind !== 'deactivate' ? save.variables.flow.id : null;
  useLayoutEffect(() => {
    if (!data || data.unreadable) return;

    const spent = standings.flatMap(([id, standing]) => (standing === 'nothing' && id !== sending ? [id] : []));
    if (spent.length > 0) useFlowDraftStore.getState().settle(spent);
  }, [data, sending, standings]);

  // A refusal of the server's own copy of a flow — tested, or activated, with no draft — is about
  // that copy, and has no draft to go with (see refusedCopies). Once the server has another copy,
  // or none, what was refused is not there any more: kept, the refusal would mark the copy another
  // console saved with what the server said of the one it replaced. Switched on or off, a copy is
  // the same copy. The page tells the store, as it does of the drafts, once the list has been read.
  useLayoutEffect(() => {
    if (!data || data.unreadable) return;

    const gone = Object.entries(refusedCopies).flatMap(([id, copy]) => {
      const now = byId.get(id);
      return now !== undefined && fingerprint(now) === copy ? [] : [id];
    });
    if (gone.length > 0) useFlowDraftStore.getState().lapse(gone);
  }, [byId, data, refusedCopies]);

  // A flow alarm the reader asked to see, from its row on the alarm wall: the page opens on the
  // flow it came from, with its Raise alarm node picked. Only once the flows are read, since until
  // then none of them can be found; and one no flow has any more is let go.
  //
  // Looked for in the copies the server has, then in the drafts: a test runs the drawing, which
  // can be of a flow the server has never had — the examples are only drafts until they are
  // activated — or hold a Raise alarm its saved copy does not.
  useLayoutEffect(() => {
    if (asked === null || !data) return;

    const source = data.unreadable ? null : alarmSource(asked, [...deployed, ...Object.values(drafts)]);
    if (source) {
      useFlowDraftStore.getState().show(source.flowId);
      useFlowDraftStore.getState().select(source.nodeId);
    }
    useFlowAlarmStore.getState().answered();
  }, [asked, data, deployed, drafts]);

  const shown = flows.find((flow) => flow.id === current) ?? flows[0];

  // The flow on screen went — deleted here or on another console — or none was chosen yet, and the
  // page shows the first flow in its place. The store is told, through show, so what was picked goes
  // with the flow it was picked in: flows share ids — the examples' wires are e1 to e7 in both, and
  // every flow has a start and an end — and a pick kept from a flow that went would pick the same id
  // in this one: a wire the palette would put its next node on, a node the inspector would open.
  // Asked of the store as it is now, not as this render had it: an effect before this one may just
  // have shown a flow (the alarm's, above). And only once the server's copies have been read, since
  // until then every flow would look gone.
  useLayoutEffect(() => {
    if (!data || data.unreadable || !shown) return;

    const store = useFlowDraftStore.getState();
    if (!flows.some((flow) => flow.id === store.current)) store.show(shown.id);
  }, [data, flows, shown]);

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

  // What a save held back says (see heldSaying), for as long as it is so. A draft held back is said
  // while it is held back on the copy it was started from: kept over the server's copy, or let go,
  // it is held back no longer, and the line would ask the reader for what they have done. An Update
  // held back from a flow another console switched off says Activate saves the change, which is so
  // while there is a change to save and the flow is still off: not once the reader has let the
  // change go, nor once another console has switched the flow back on. The rest stand until the
  // next save, as a failure does.
  //
  // A line that has stopped being so is gone for good, though what it stood on can come about again
  // — a new change of the same copy, the flow switched off once more — because the press it was
  // about is over: said again, it would tell the reader of a press they never made. So the page
  // keeps the answer whose line went, and says no more of it; the next save's answer is new.
  const [spent, setSpent] = useState<Unsaved | null>(null);
  const held = save.isSuccess && save.data !== null && 'held' in save.data && save.data !== spent ? save.data : null;
  const pressed = save.isSuccess ? save.variables.kind : null;
  const stands =
    held === null || pressed === null
      ? false
      : held.held === 'overtaken'
        ? overtaken.has(held.id) && bases[held.id] === held.base
        : held.held === 'off' && pressed !== 'deactivate'
          ? changed.has(held.id) && byId.get(held.id)?.enabled === false
          : true;
  useLayoutEffect(() => {
    if (held !== null && !stands) setSpent(held);
  }, [held, stands]);
  const heldLine =
    held !== null && pressed !== null && stands
      ? heldSaying(pressed, held.held, held.name, !deployedIds.has(held.id))
      : null;

  if (isPending) return <p className={styles.missing}>Reading the flows…</p>;

  // Only when there has never been an answer. A read that fails once the flows are on screen
  // keeps them there: the drafts are all still here, and a save says for itself when the
  // server cannot be reached.
  if (!data)
    return <p className={panel.fault}>The flows could not be read from the server. Nothing here has changed.</p>;

  if (data.unreadable)
    return (
      <p className={panel.fault}>
        The flows file could not be read, so no flows are running. Repair it or move it aside; nothing here will write over it.
      </p>
    );

  // For its actions, which the handlers below call when they run. Actions never change, so a
  // subscription to them would only re-render the page for nothing.
  const store = useFlowDraftStore.getState();

  // A click in the palette puts the node where the program needs it: on the wire picked, or after
  // the node picked when it has one way out, so a chain is built by clicking one node after
  // another. With neither, it goes in the middle of what is on screen, or in the first clear place
  // across from it, unwired until the reader wires it — the canvas marks it until then.
  const add = (type: FlowNodeType) => {
    const id = newId('n');
    const { wire, selected } = useFlowDraftStore.getState();
    const onWire = wire === null ? undefined : shown.edges.find((edge) => edge.id === wire);
    const after = selected === null ? undefined : shown.nodes.find((node) => node.id === selected);

    if (onWire) {
      const from = shown.nodes.find((node) => node.id === onWire.from)!;
      const to = shown.nodes.find((node) => node.id === onWire.to)!;
      const at = freeSpot(shown, { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 }, NODE_BOX, 1, ROOM);
      store.edit(shown, (flow) => insertOnWire(flow, onWire.id, type, at, id));
    } else if (after && insertAfter(shown, after.id, type, after, id) !== null) {
      const at = freeSpot(shown, { x: after.x + NODE_WIDTH + 2 * ROOM, y: after.y }, NODE_BOX, 1, ROOM);
      store.edit(shown, (flow) => insertAfter(flow, after.id, type, at, id) ?? flow);
    } else {
      const box = document.getElementById(CANVAS)?.getBoundingClientRect();
      const middle = screenToFlowPosition({ x: box ? box.left + box.width / 2 : 0, y: box ? box.top + box.height / 2 : 0 });
      const right = screenToFlowPosition({ x: box ? box.right : 0, y: 0 }).x;
      const { start, across } = placesInView(middle, right, NODE_BOX, ROOM);
      const at = freeSpot(shown, start, NODE_BOX, across, ROOM);
      store.edit(shown, (flow) => addNode(flow, type, at, id));
    }

    store.select(id);
  };

  // With no flow left — none yet, or the last one gone — the page is the way to start one, in the
  // console's own empty-page block, which sizes itself: the page's grid is for a flow on screen. The
  // line under the tabs stays where it was all the same, in the region it was in (see below).
  return (
    <Failures.Provider value={failures}>
      <div className={shown ? styles.page : undefined}>
        <div className={styles.top}>
          {shown && (
            <Toolbar
              flows={flows}
              changed={changed}
              overtaken={overtaken}
              deployed={deployedIds}
              current={shown.id}
              active={activeIds}
              running={running}
              testing={testing}
              refused={refused}
              busy={save.isPending || test.start.isPending}
              onNew={() => {
                const flow = emptyFlow(nextName(flows));
                store.put(flow);
                store.show(flow.id);
              }}
              // Not for a draft held back. Its pane says why it is held, with Keep mine and Discard
              // under the sentence — where the reader is looking when they choose, and the one place
              // both answers are — so a second Discard up here would only ask the same question twice.
              onDiscard={changed.has(shown.id) && byId.has(shown.id) ? () => store.discard(shown.id) : undefined}
              onTest={() => test.start.mutate(shown)}
              onStop={() => test.stop.mutate(shown.id)}
              onActivate={() => save.mutate({ flow: shown, kind: 'activate' })}
              // Offered for a draft held back too, off, where it says why: a flow that is on with
              // changes the reader cannot send yet is not one with nothing to send.
              onUpdate={
                changed.has(shown.id) || overtaken.has(shown.id)
                  ? () => save.mutate({ flow: shown, kind: 'update' })
                  : undefined
              }
              // The server's copy, never the drawing: a drawing the server would refuse cannot keep a
              // flow from being stopped. (useSave sends the copy it reads just before, which may be
              // newer.)
              onDeactivate={
                activeIds.has(shown.id) ? () => save.mutate({ flow: byId.get(shown.id)!, kind: 'deactivate' }) : undefined
              }
            />
          )}

          {/* The page covers the log, so what did not go through is said here: a save or a test that
              failed, or that the server refused — which marks the nodes it is about, but a flow
              refused on another tab has only its lamp to show it — a save held back, or one that
              found done what it asked for, a test that did not stop, a flow not deleted, and drafts
              this browser would not keep. One polite live region, so a reader who cannot see the
              marks is told as well, and nothing in it is drawn from the numbers, so a push of them
              says nothing. A flow is named as it was when the reader pressed: a name read from the
              draft would be said again with every letter of a rename.

              A refusal is said while the very refusal its request filed stands. A flow has one at a
              time, the last the server gave, whose marks are the ones on the drawing; the line of a
              test or a save refused before it would say marks are there that are gone.

              The region stays in the page whatever the page shows, the empty page included. A press
              can take the last flow away with it — an Activate or a Deactivate of a flow another
              console has deleted — and the line that says so goes into a region that was there
              before it: a region that comes into the page with its words already inside is not read
              out by every screen reader, and the empty page comes in with the very answer that
              holds the line. */}
          <div aria-live="polite">
            {/* In the words of the button: what a Deactivate did not do is stop the flow, which runs on. */}
            {save.isError && (
              <p className={panel.fault}>
                {save.variables.kind === 'deactivate' ? 'Not switched off.' : 'Not saved.'} {describeError(save.error)}
              </p>
            )}
            {save.data && 'refused' in save.data && refusals[save.data.id] === save.data.refused && (
              <p className={panel.fault}>The server refused {save.data.name}, so it was not saved. What it refused is marked on it.</p>
            )}
            {heldLine !== null && <p className={heldLine.fault ? panel.fault : panel.note}>{heldLine.text}</p>}
            {test.start.isError && <p className={panel.fault}>The test did not start. {describeError(test.start.error)}</p>}
            {test.start.data && refusals[test.start.variables.id] === test.start.data && (
              <p className={panel.fault}>
                The server refused {titleOf(test.start.variables)}, so the test did not start. What it refused is marked on it.
              </p>
            )}
            {test.stop.isError && <p className={panel.fault}>The test did not stop. {describeError(test.stop.error)}</p>}
            {failed.delete !== null && (
              <p className={panel.fault}>
                {failed.delete.name} was not deleted. {failed.delete.reason}
              </p>
            )}
            {/* Said once, by the first draft the browser refused: its storage is full, or blocked,
                and a reload would bring back what it kept before then without a word. */}
            {unkept && (
              <p className={panel.fault}>
                This browser would not keep the drafts, so a reload may bring back older ones, or none. Activate or Update
                what you want to keep.
              </p>
            )}
          </div>
        </div>

        {shown ? (
          // What the tabs control: everything under them is about the flow on screen, the palette
          // included, since what it adds goes into that flow.
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
                overtaken={overtaken.has(shown.id)}
                problems={problems[shown.id] ?? NOTHING_WRONG}
                facts={{ allowWebhooks: data.allowWebhooks }}
              />
            </div>

            <DebugStrip flow={shown} />
          </div>
        ) : (
          <Start />
        )}
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
        Draw what should happen, step by step, from Start to End — read a message, decide, raise an alarm, publish an
        answer. Test runs the drawing once; Activate keeps it running on the server, with this page open or not.
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

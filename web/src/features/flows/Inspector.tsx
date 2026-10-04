import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useContext, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { shallow } from 'zustand/shallow';
import { deleteFlow, isFlowUnknown } from '../../api/flows';
import { queryKeys } from '../../api/queryKeys';
import { Field } from '../../components/Field';
import { own } from '../../lib/own';
import { describeError } from '../../lib/problemDetails';
import { isLive, nodeKey, shownRun, useFlowStatusStore } from '../../stores/flowStatusStore';
import { logFault, useLogStore } from '../../stores/logStore';
import panel from '../../styles/panel.module.css';
import type { FlowDto, FlowNodeDto, FlowRunStatusDto, FlowVariableDto } from '../../types/api';
import { clock } from '../alerts/AlertsPanel';
import { Failures } from './failures';
import { focusCanvas } from './FlowCanvas';
import { fingerprint, removeNodes, setConfig, titleOf, type Problems } from './flowDocument';
import { useFlowDraftStore } from './flowDraftStore';
import { NodeSettings, type Facts } from './NodeSettings';
import { specOf, TEMPLATE_HELP } from './nodeTypes';
import { focusShownTab } from './Toolbar';
import { putInList } from './useSave';
import styles from './Inspector.module.css';

type Props = {
  flow: FlowDto;
  /** The flow as the server has it, or undefined when it has none: never saved, or deleted since. */
  deployed: FlowDto | undefined;
  /** The flow's draft was started from a copy the server has since replaced, or deleted. */
  overtaken: boolean;
  /** What the server said last, keyed flow / node:{id} / edge:{id}. */
  problems: Problems;
  facts: Facts;
};

/** The picked node's settings, or — with nothing picked — the flow's own. */
export function Inspector({ flow, deployed, overtaken, problems, facts }: Props) {
  const selected = useFlowDraftStore((state) => state.selected);
  const node = flow.nodes.find((one) => one.id === selected);

  return (
    <aside className={styles.inspector} aria-label="Inspector">
      {node ? (
        <NodePane flow={flow} node={node} problems={problems[`node:${node.id}`]} facts={facts} />
      ) : (
        <FlowPane flow={flow} deployed={deployed} overtaken={overtaken} problems={problems} />
      )}
    </aside>
  );
}

/** The nodes whose settings can fill in {{…}}, whose panes list what each placeholder gives. */
const TEMPLATED = new Set(['if', 'for', 'wait', 'set', 'publish', 'alarmRaise', 'notify', 'webhook']);

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

      {/* What the node does and how it is wired, before anything about this one: a reader who
          opened the pane to find out what the node is for reads that first. */}
      <p className={panel.hint}>{spec.help}</p>

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

      <NodeSettings flow={flow} node={node} set={set} facts={facts} />

      {/* What the node holds up comes before the placeholders: it is about this node, and about
          now, where the placeholders are one list, the same under every form that has it. */}
      {node.type === 'alarmRaise' && <Standing flowId={flow.id} nodeId={node.id} />}

      {TEMPLATED.has(node.type) && (
        <section className={styles.fills} aria-label="Fills in">
          <h4 className={styles.subTitle}>Fills in</h4>
          <dl className={styles.placeholders}>
            {TEMPLATE_HELP.map((one) => (
              <div key={one.placeholder}>
                <dt className={styles.mono}>{one.placeholder}</dt>
                <dd>{one.gives}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      {/* Not for the Start: every run begins there, so a flow keeps the one it was made with. */}
      {node.type !== 'start' && (
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
      )}
    </>
  );
}

/** How much of a node's line a wire's problem quotes: about what the node shows before it cuts it. */
const QUOTED = 30;

/**
 * A node as the canvas draws it: its type, and the line under that which says its settings. The
 * type alone reads "If → If" for two nodes of one type; the line is what tells them apart there.
 * A line longer than the node is cut, as the node cuts it. The flow is the one the node is in,
 * since a line can name another of its nodes: a Clear alarm's names the Raise alarm it closes.
 */
function drawnAs(node: FlowNodeDto, flow: FlowDto): string {
  const spec = specOf(node.type);
  const line = Array.from(spec.summary(node.config, flow));
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
    return node ? drawnAs(node, flow) : nodeId;
  };

  return [
    ...(problems.flow ?? []),
    ...flow.edges.flatMap((edge) =>
      (problems[`edge:${edge.id}`] ?? []).map((problem) => `${nameOf(edge.from)} → ${nameOf(edge.to)}: ${problem}`),
    ),
  ];
}

/** "v1", "v2" … — the first of them none of these variables is called. */
function nextVariable(variables: readonly FlowVariableDto[]): string {
  const taken = new Set(variables.map((variable) => variable.name));
  for (let n = 1; ; n++) if (!taken.has(`v${n}`)) return `v${n}`;
}

/**
 * Whether the flow pane draws two runs alike. All it draws of one is where it is, what it waits
 * for, what last stopped it and its variables — not its nodes' numbers, which move with every
 * message.
 */
const drawnAlike = (one: FlowRunStatusDto | undefined, other: FlowRunStatusDto | undefined) =>
  one === other ||
  (one !== undefined &&
    other !== undefined &&
    one.kind === other.kind &&
    one.state === other.state &&
    one.at === other.at &&
    one.fault === other.fault &&
    one.waiting?.until === other.waiting?.until &&
    one.waiting?.filter === other.waiting?.filter &&
    shallow(one.variables, other.variables));

/**
 * The run a flow's canvas shows (see shownRun), as the flow pane draws it. Every push brings a new
 * object for every run, up to four times a second, so the pane keeps the one it drew for as long as
 * a new one would draw the same — as useShallow keeps what it selected — and a push that moved
 * nothing the pane draws draws nothing.
 */
function useDrawnRun(flowId: string): FlowRunStatusDto | undefined {
  const drawn = useRef<FlowRunStatusDto | undefined>(undefined);

  return useFlowStatusStore((state) => {
    const run = shownRun(own(state.runs, flowId));
    if (!drawnAlike(drawn.current, run)) drawn.current = run;
    return drawn.current;
  });
}

/** The shown run in a line: what it is and where, or how the flow stands with none. */
function stateLine(
  flow: FlowDto,
  deployed: FlowDto | undefined,
  overtaken: boolean,
  run: FlowRunStatusDto | undefined,
  now: number,
): string {
  if (!run) {
    if (deployed) return deployed.enabled ? 'Active · not running' : 'Off';

    // The server has no copy: it never had one, or another console deleted it since this draft was
    // started, which is what an overtaken draft with no copy is. The box over the pane says so, and
    // "Not saved yet" under it would say the flow had never been there.
    return overtaken ? 'Not on the server' : 'Not saved yet';
  }

  const kind = run.kind === 'test' ? 'Test' : 'Active';
  const at = flow.nodes.find((node) => node.id === run.at);

  switch (run.state) {
    case 'finished':
      return `${kind} · finished at End`;
    case 'stopped':
      return `${kind} · stopped`;
    case 'waiting':
      if (run.waiting?.filter != null) {
        const waiting = `${kind} · waiting for a message on ${run.waiting.filter}`;

        // A test waits for the reader who pressed it, and Publish is where one is sent from. The flow
        // at work waits for the plant's own traffic, and a line that told its reader to send one would
        // read as advice to put a message into production.
        return run.kind === 'test' ? `${waiting} — send one from Publish` : waiting;
      }
      if (run.waiting?.until != null)
        return `${kind} · Wait ${(Math.max(0, Date.parse(run.waiting.until) - now) / 1000).toFixed(1)} s`;
      return `${kind} · waiting`;
    default:
      return at ? `${kind} · running at ${specOf(at.type).label}` : `${kind} · running`;
  }
}

/**
 * The run the canvas shows, in its one line (see stateLine). A run that waits for a time counts its
 * seconds down here as its node does on the canvas: a tenth at a time, and no further than none
 * left, which it goes on saying until a push says where the run went — ticking on would only draw
 * the same line ten times a second. Nothing else in the pane ticks, and nothing ticks while the run
 * waits for anything else.
 *
 * The pane keys it by when the wait ends, so a new wait is counted from the time it is then, read
 * as the wait comes in. The clock it last read may be minutes old — nothing was counting — and a
 * line worked out from it would say the wait had minutes left until the first tick put it right.
 */
function RunLine({
  flow,
  deployed,
  overtaken,
  run,
}: {
  flow: FlowDto;
  deployed: FlowDto | undefined;
  overtaken: boolean;
  run: FlowRunStatusDto | undefined;
}) {
  const until = run?.state === 'waiting' ? (run.waiting?.until ?? null) : null;
  const [now, setNow] = useState(() => Date.now());
  const counting = until !== null && now < Date.parse(until);

  useEffect(() => {
    if (!counting) return;
    const timer = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(timer);
  }, [counting]);

  return <p className={panel.note}>{stateLine(flow, deployed, overtaken, run, now)}</p>;
}

type FlowPaneProps = { flow: FlowDto; deployed: FlowDto | undefined; overtaken: boolean; problems: Problems };

function FlowPane({ flow, deployed, overtaken, problems }: FlowPaneProps) {
  const edit = useFlowDraftStore((state) => state.edit);
  const rebase = useFlowDraftStore((state) => state.rebase);
  const discard = useFlowDraftStore((state) => state.discard);
  // The run the canvas shows: where it is, what it waits for, its variables as they stand, and
  // what last stopped it — an event that ran too many nodes, say.
  const run = useDrawnRun(flow.id);
  // What the variables hold now, while the run goes. A run that is over holds what its variables
  // ended with, which is not what anything holds now.
  const holding = isLive(run) ? run?.variables : undefined;
  const fault = run?.fault ?? null;
  const queryClient = useQueryClient();
  const failures = useContext(Failures);
  const [asking, setAsking] = useState(false);
  const adder = useRef<HTMLButtonElement>(null);

  // Either answer takes the question away, and the keyboard with it. The reader goes to the tab of
  // the flow on screen: this one, or — once a discard has let a flow deleted elsewhere go — the
  // next, which has to be drawn before it can be given the focus.
  const choose = (choice: () => void) => {
    flushSync(choice);
    focusShownTab();
  };

  const remove = useMutation({
    // Asked of the server even for a flow it never had: a test of the drawing may be running there,
    // and once the flow has gone from this page nothing is left to press Stop on — the delete is
    // what stops it. The server says it has no such flow, as it says of one deleted on another
    // console since this one last read the list: either way the flow is gone, which is what the
    // reader asked for. And of a flow it never had, nothing it answers keeps the flow here: there is
    // nothing of the reader's on the server to keep.
    //
    // What it answers still matters, though. Any answer but "no such flow" — a server that failed,
    // or could not be reached — leaves the test it may have running, with the flow gone from the
    // page and the only Stop there was. The page does not say so under the tabs, as it does of a
    // flow that stays: that line is about a flow, and this one has gone. So the log does, where the
    // console keeps what a command did not do — under a label, as every verb there is, with what
    // happened said in the entry's body, ahead of what the server answered.
    mutationFn: async (id: string) => {
      try {
        await deleteFlow(id);
      } catch (error) {
        if (isFlowUnknown(error)) return;
        if (deployed) throw error;

        useLogStore.getState().push({
          kind: 'fault',
          verb: 'Flow test may still run',
          body: `${titleOf(flow)} was deleted here, but the server did not take the delete, so a test of it may still be running there. ${describeError(error)}`,
        });
      }
    },
    onMutate: () => failures.trying('delete'),
    // The id comes with the answer rather than from the flow on screen: a mutation still out is
    // handed the callbacks of the latest render, and by the time the answer comes the reader may
    // be looking at another flow.
    onSuccess: async (_, id) => {
      // Out of the list at once, not when the read after the delete comes back: until then its tab
      // would stay, and the page would go on showing the flow that is gone.
      await putInList(queryClient, id, null);
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

  // Applied to the variables as they are in the draft at the moment of the keystroke, as a node's
  // settings are, not as they were when this render happened.
  const editVariables = (change: (variables: FlowVariableDto[]) => FlowVariableDto[]) =>
    edit(flow, (current) => ({ ...current, variables: change(current.variables) }));

  return (
    <>
      <div className={styles.paneHead}>
        <h3 className={styles.title}>{titleOf(flow)}</h3>
      </div>

      {/* Sent as it stands, this draft would undo what another console saved, or bring back a flow
          somebody deleted. So Activate and Update hold it back until the reader says which it is
          to be. */}
      {overtaken && (
        <div className={styles.overtaken}>
          <p className={panel.fault}>
            {deployed
              ? 'Changed on the server since you started, so Activate and Update hold your changes back. Keep yours to save them over it, or discard them for what the server has now.'
              : 'Deleted on the server since you started, so Activate holds your changes back. Keep yours to save the flow again, or discard them.'}
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

      {/* The server's verdict on the variables comes here with the flow's other problems, under
          the flow's key: nothing in the rows below is checked as it is typed. */}
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

      <section className={styles.variables} aria-label="Variables">
        <h4 className={styles.subTitle}>Variables</h4>
        {flow.variables.map((variable, index) => {
          // A row whose name has been cleared is named by its place, as its Name box is, until it
          // has a name again: "Value of" alone names nothing.
          const called = variable.name || `variable ${index + 1}`;

          return (
            // Keyed by place, as a condition's rows are. A variable has no id, and its name is the
            // very thing being typed: a row keyed by its name would be a new row at every letter,
            // and the box being typed into would lose the keyboard.
            <div key={index} className={styles.variable}>
              <input
                className={styles.mono}
                aria-label={`Name of variable ${index + 1}`}
                value={variable.name}
                spellCheck={false}
                onChange={(event) =>
                  editVariables((all) => all.map((one, at) => (at === index ? { ...one, name: event.target.value } : one)))
                }
              />
              <input
                className={styles.mono}
                aria-label={`Value of ${called}`}
                value={variable.value}
                placeholder='90 or ["k1","k2"]'
                spellCheck={false}
                onChange={(event) =>
                  editVariables((all) => all.map((one, at) => (at === index ? { ...one, value: event.target.value } : one)))
                }
              />
              <button
                type="button"
                className={panel.subRemove}
                aria-label={`Remove ${called}`}
                onClick={() => {
                  editVariables((all) => all.filter((_, at) => at !== index));
                  // The last row goes with the button that took it away, and a browser hands the
                  // keyboard of a button taken out to the body. Add variable is under where the
                  // row was. A row above the last keeps its place, and its button, which now takes
                  // out the variable that moved up into it. Where a click gives a button the
                  // keyboard, it stays on that button; where a click does not, as in Safari, it
                  // stays where it was.
                  if (index === flow.variables.length - 1) adder.current?.focus();
                }}
              >
                ×
              </button>
              {/* Under the value it started from, after the row's own line, and read in that
                  order. Asked of the run's own names: a name is any the server takes, and
                  constructor is one every object answers to. */}
              {holding !== undefined && Object.hasOwn(holding, variable.name) && (
                <span className={styles.now}>now {holding[variable.name]}</span>
              )}
            </div>
          );
        })}
        <button
          ref={adder}
          type="button"
          className="ghost"
          onClick={() => editVariables((all) => [...all, { name: nextVariable(all), value: '' }])}
        >
          Add variable
        </button>
        <p className={panel.hint}>
          A run starts with these values; Set changes them for that run. Read one as {'{{var.name}}'}, or as var.name in a
          field.
        </p>
      </section>

      <RunLine key={run?.waiting?.until ?? ''} flow={flow} deployed={deployed} overtaken={overtaken} run={run} />
      {fault !== null && <p className={panel.fault}>{fault}</p>}

      {!asking ? (
        <div className={panel.actions}>
          <button type="button" className="ghost ends" onClick={() => setAsking(true)}>
            Delete flow
          </button>
        </div>
      ) : (
        <div className={styles.confirm}>
          <p>{deleting(flow, deployed, overtaken, isLive(run) && run?.kind === 'test')}</p>
          <div className={panel.actions}>
            <button type="button" className="ghost" onClick={() => setAsking(false)}>
              Keep it
            </button>
            {/* Off while the delete is out, but said rather than set, as Activate is: a button switched
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

/**
 * What the delete question asks: the flow, named as it is named everywhere else — a flow with no name
 * read "Delete ? It stops running." — and what deleting it does, which depends on how the server has
 * it: a flow switched on stops running, and the server forgets the copy it has; one it never had, or
 * no longer has, is only the drawing here, which goes. A test going stops with it either way: once
 * the flow is gone from the page, the delete is what stops it.
 */
function deleting(flow: FlowDto, deployed: FlowDto | undefined, overtaken: boolean, testing: boolean): string {
  const title = titleOf(flow);
  const asked = deployed
    ? `Delete ${title}? ${deployed.enabled ? 'It stops running, and the server forgets it.' : 'The server forgets it.'}`
    : overtaken
      ? `Drop ${title}? It is no longer on the server, and your changes go with it.`
      : `Drop ${title}? It was never saved, and the drawing goes with it.`;
  return testing ? `${asked} Its test stops.` : asked;
}

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

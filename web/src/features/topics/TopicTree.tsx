import { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import { SearchBox, SearchOpener } from '../../components/SearchBox';
import { WhereMenu } from '../../components/WhereMenu';
import { Fold, Unfold } from '../brand/icons';
import { EVERYTHING, treeView } from '../../lib/holds';
import { useRuleLookup } from '../../lib/useRuleLookup';
import { treeFilter } from '../../lib/topicMatch';
import {
  EMPTY_LEVEL,
  flattenTree,
  MAX_TREE_ROWS,
  searchRows,
  type TopicNode,
  type TopicRow,
} from '../../lib/topicTree';
import { HoldButton } from '../monitor/HoldButton';
import { useComposeStore } from '../../stores/composeStore';
import { useHoldStore } from '../../stores/holdStore';
import { useLogStore } from '../../stores/logStore';
import { usePauseStore } from '../../stores/pauseStore';
import { useSearchStore } from '../../stores/searchStore';
import { brokerSelection, selectionFor, useSelectionStore } from '../../stores/selectionStore';
import { isPathOpen, useTopicTreeStore } from '../../stores/topicTreeStore';
import styles from './TopicTree.module.css';
import { TreeNode } from './TreeNode';

// How long a row stays tinted after its last message. A row under steady traffic simply never
// stops being active, so it holds one colour instead of restarting a fade per message.
export const ACTIVE_WINDOW_MS = 1200;

// Reserved: a topic path can never contain a NUL, so the broker row cannot collide with one.
const BROKER_PATH = '\u0000broker';

export function TopicTree({ broker }: { broker?: string }) {
  const root = useTopicTreeStore((state) => state.root);
  const openPaths = useTopicTreeStore((state) => state.openPaths);
  const defaultOpen = useTopicTreeStore((state) => state.defaultOpen);
  const toggle = useTopicTreeStore((state) => state.toggle);
  const toggleBroker = useTopicTreeStore((state) => state.toggleBroker);
  const setAllOpen = useTopicTreeStore((state) => state.setAllOpen);

  const selectedFilter = useSelectionStore((state) => state.selected?.filter ?? null);
  const select = useSelectionStore((state) => state.select);
  const load = useComposeStore((state) => state.load);

  const brokerOpen = useTopicTreeStore((state) => state.brokerOpen);

  // Rebuilt only when the rules change, so the answers it works out survive the renders that
  // messages cause — and a row asks about its own path, which never changes.
  const ruleOf = useRuleLookup();

  // The store is read once here rather than once per row, so a message wakes this component
  // alone and only the rows whose node object actually changed re-render.
  const forgotten = useTopicTreeStore((state) => state.forgotten);
  const returnedAt = useTopicTreeStore((state) => state.returnedAt);
  // A stopped console is standing still, the way a held row is: nothing on it should move, and a
  // fade appearing while it sits there would be the one thing on screen that did. See staleSince
  // below.
  const stopped = usePauseStore((state) => state.paused);

  const { look, where } = useSearchStore((state) => state.tree);
  const setTree = useSearchStore((state) => state.setTree);
  const sought = look !== '';
  /** Whether the box is on screen. The mark on the broker's row is what opens it. */
  const [open, setOpen] = useState(false);

  /*
   * The rows: the open part of the tree, or — with something in the search box — every topic
   * that answers it, flat.
   *
   * A search is not a fold. Narrowing the tree in place would leave the reader opening three
   * branches to reach each match, which is the work the box exists to save, so under a search
   * every match stands at the top level under its whole path and the tree comes back the moment
   * the box is emptied. It also means the broker's own row keeps its meaning: what hangs off it
   * is the tree, and what replaces it is a list of answers.
   */
  const { rows, hidden } = useMemo(() => {
    if (!brokerOpen) return { rows: [] as TopicRow[], hidden: 0 };
    if (sought) return searchRows(root, look, where, MAX_TREE_ROWS);

    return flattenTree(root, (path) => isPathOpen({ openPaths, defaultOpen }, path), MAX_TREE_ROWS);
  }, [root, openPaths, defaultOpen, brokerOpen, sought, look, where]);

  // treeFilter only ever appends '/#', so peeling it off compares paths without allocating per row.
  const selectedPath = selectedFilter?.endsWith('/#') ? selectedFilter.slice(0, -2) : null;

  // Messages re-render this component anyway; silence does not, so the last tint needs one
  // more render to clear it. root.lastSubHitAt is the newest message anywhere in the tree.
  const [, retint] = useReducer((count: number) => count + 1, 0);
  const newestHitAt = root.lastSubHitAt;

  useEffect(() => {
    if (newestHitAt === 0) return;

    const remaining = ACTIVE_WINDOW_MS - (Date.now() - newestHitAt);
    if (remaining <= 0) return;

    const timer = setTimeout(retint, remaining);
    return () => clearTimeout(timer);
  }, [newestHitAt]);

  const activeSince = Date.now() - ACTIVE_WINDOW_MS;

  /*
   * The tree as the holds draw it.
   *
   * A row under a hold is drawn from the hold — a row draws its own node's fields, and a node the
   * hold froze goes on saying what it said — and a row the hold has nothing for arrived behind it
   * and is not drawn. A row under no hold is drawn live, with what the holds beneath it keep back
   * taken out of its counts. The rules are lib/holds' and nobody else's: the log and the chart
   * read the same holds the same way, where this tree used to decide for itself and the log beside
   * it decided differently.
   */
  const holding = useHoldStore((state) => state.held);
  const view = useMemo(() => treeView(holding, root), [holding, root]);

  // One click does two things: focuses the wire log on the subtree, and loads the topic into
  // the publish form so it can be sent straight back with the settings it arrived under.
  const onSelect = useCallback(
    (path: string, node: TopicNode) => {
      select(selectionFor(path, node));
      // A node that holds a message of its own hands over the whole of it — the body, and the QoS
      // and retain flag it was sent with — so that publishing it again publishes the same message.
      // A node that holds none hands over its path and nothing else: its flags are the placeholders
      // `leaf()` starts every node with, and writing those in would put a reader's ticked QoS 2
      // back to nought on the way past, which is exactly what it used to do.
      const held = node.latestMode !== null;

      // The whole body, when the tree is holding only the front of it. The tree cuts a message at
      // MAX_TREE_PAYLOAD because it keeps one per topic and there are fifty thousand of those;
      // the log keeps the run for this topic whole, so that is where the exact bytes are. Failing
      // that — a topic whose run the log has already given up — nothing is offered rather than a
      // body that would publish as a message the reader never sent.
      const body = node.latestTruncated
        ? useLogStore.getState().byTopic.get(path)?.newestFirst()[0]?.body
        : node.latestPayload ?? undefined;

      load({
        topic: path,
        payload: body,
        mode: node.latestMode ?? undefined,
        qos: held ? node.latestQos : undefined,
        retain: held ? node.latestRetain : undefined,
      });
    },
    [select, load],
  );

  // The broker is not a topic: it focuses the log on everything and has nothing to publish to.
  const brokerLabel = broker ?? 'Not connected';
  // What a hold on '#' is called: the spec's rule for naming a hold names the broker's address,
  // and 'Not connected' is a link state rather than a name — so a console with no broker yet
  // calls its one hold 'Everything' instead, which is what such a hold covers either way.
  const holdBroker = broker ?? 'Everything';
  const pickBroker = useCallback(() => select(brokerSelection(broker)), [select, broker]);

  /*
   * Glyphs, with the words kept as the accessible name and the tooltip. Three rules for the
   * fuller tree, two for the folded one — and not the ☰ that would say it best, since that is
   * already the panel menu in the bar above and would read as a second one.
   *
   * They ride on the broker's row, at its right end. What they open and close is the tree that
   * hangs off that row, and a strip of its own above the pane put a line and a band of empty
   * space between the pane's edge and the first topic to say so.
   */
  /*
   * The narrow pause, on the row it acts on.
   *
   * The selected row carries it, because what it holds is the run the selection put on screen.
   * Made once and handed to that row alone: every other row is handed nothing, so nothing about
   * them changes and the memo around each of them still holds. It is told the broker's name, which
   * is what it calls a hold on everything when it says a pane is paused with one.
   */
  const hold = useMemo(() => <HoldButton broker={holdBroker} />, [holdBroker]);

  /** The pause on a row that is not the selected one, and has a hold of its own. */
  const holdsOn = useCallback(
    (filter: string) => <HoldButton over={filter} broker={holdBroker} />,
    [holdBroker],
  );

  /**
   * Expand and collapse, over whatever the reader is actually looking at.
   *
   * With a branch picked, these two mean that branch. On a broker carrying thousands of topics
   * the whole-tree answer buries the thing they were looking at in everything they were not —
   * and the pair sits on the picked row itself, which is where a reader reads them as being about
   * it. With nothing picked there is nothing to scope to, and they mean the tree.
   *
   * The same two marks the message window puts over a folded document, because it is the same
   * gesture on the same kind of thing: everything out, everything in. They were `≡` and `=`,
   * which are two typographic characters that differ by one stroke and mean neither of those
   * things — a reader had to learn them here and could not carry what they learnt anywhere. The
   * chevron pair is one idea drawn once, and this console now draws it in both places it happens.
   */
  const treeActions = useMemo(() => {
    // A null path is nothing picked; '' is the empty first level, which is a branch like any other
    // and is spoken as the slash the row draws. A falsy test named it 'all' and expanded the tree.
    const named = selectedPath === null ? null : selectedPath === '' ? EMPTY_LEVEL : selectedPath;
    const of = named === null ? ' all' : ` ${named}`;

    return (
      <div className={styles.rowActions}>
        <button
          type="button"
          onClick={() => setAllOpen(true, selectedPath)}
          aria-label={`Expand${of}`}
          title={named === null ? 'Expand every branch' : `Expand every branch under ${named}`}
        >
          <Unfold />
        </button>
        <button
          type="button"
          onClick={() => setAllOpen(false, selectedPath)}
          aria-label={`Collapse${of}`}
          title={named === null ? 'Collapse every branch' : `Collapse every branch under ${named}`}
        >
          <Fold />
        </button>
      </div>
    );
  }, [setAllOpen, selectedPath]);

  // The broker's row keeps the two tree marks at its end whether it is picked or not, and takes
  // the pause in front of them when it is: picking it focuses the log on everything, which is a
  // run like any other and can be held like one.
  /**
   * The search, on the row the whole tree hangs off.
   *
   * Here rather than in a strip of its own above the tree, because this is the row that stands
   * for the broker and the search is a question about everything under it — and because a strip
   * would cost the pane a line of height on every console, including the ones nobody will ever
   * search. The box opens to the left of the marks and ends where they begin.
   */
  const finding = (
    <>
      {open && (
        <SearchBox
          label="Search the topics"
          value={look}
          onChange={(next) => setTree({ look: next })}
          focused
        />
      )}
      <SearchOpener
        label="Find a topic"
        open={open}
        onToggle={() => {
          // Closing lets the search go: a box that hid itself while still narrowing the tree
          // would leave rows held back with nothing on screen to say why.
          if (open) setTree({ look: '' });
          setOpen((shown) => !shown);
        }}
      />
      {open && (
        <WhereMenu
          label="Where to look in the topics"
          value={where}
          onChange={(next) => setTree({ where: next })}
        />
      )}
    </>
  );

  // The broker's row takes the pause in front of its marks when it is picked, and keeps it there
  // while everything is paused, wherever the reader has gone since: it lost it the moment another
  // row was picked, and a hold over the whole console could then only be undone from Manage.
  const brokerActions = (
    <>
      {selectedFilter === EVERYTHING ? hold : holding.has(EVERYTHING) ? holdsOn(EVERYTHING) : null}
      {finding}
      {treeActions}
    </>
  );

  return (
    <>
      <h2 className="srOnly">Topics</h2>

      {root.subTopics === 0 ? (
        // Two different nothings, and 'No topics yet' answered both with one sentence: a console
        // nobody has connected yet, and a broker that has not said anything. The first is the
        // reader's move to make and the sentence says so; the second is the broker's, and naming
        // it is what tells a reader the console is listening to the one they meant.
        <div className={styles.emptyBand}>
          <p className="empty">
            {broker ? `No topics from ${broker} yet.` : 'Connect a broker to see its topics.'}
          </p>
        </div>
      ) : (
        <div className={styles.tree} data-finding={open ? '' : undefined}>
          {/* One root for the whole broker, so the totals are readable without expanding
              anything — and so collapsing it puts the entire tree away in one click. It stands
              over a search's answers too: it is still the broker they came from, it is still
              how a reader gets back to everything, and its counts are still the tree's. */}
          <TreeNode
            // Drawn from what `#` froze while everything is paused, and otherwise without what
            // the holds beneath it are keeping back.
            node={view.root}
            path={BROKER_PATH}
            label={brokerLabel}
            depth={0}
            isBranch
            open={brokerOpen}
            active={false}
            selected={selectedFilter === EVERYTHING}
            // Only with a live link behind it. Without one the row still stands — the tree keeps
            // what it has heard — but it says 'Not connected', and filling a row that is naming
            // an absence would be the console looking pleased about it.
            root={Boolean(broker)}
            actions={brokerActions}
            onToggle={toggleBroker}
            onSelect={pickBroker}
          />

          {/* A search that matched nothing says so under the broker's row rather than in place of
              the tree. In place of it, the row went too — and the row is where the search box and
              the mark that shuts it live, so a reader who mistyped was left looking at a sentence
              with no way back to the tree it was about. */}
          {sought && rows.length === 0 && (
            <p className="empty" data-testid="no-topic-found">
              No topic{' '}
              {where === 'body' ? 'is carrying' : where === 'topic' ? 'is named for' : 'says'} “
              {look}”.
            </p>
          )}

          {rows.map((row) => {
            const drawn = view.row(row.path, row.node);
            // A hold is keeping it off screen: it arrived behind the hold.
            if (drawn === null) return null;

            const { node } = drawn;
            const filter = treeFilter(row.path);

            return (
              <TreeNode
                key={row.path}
                node={node}
                path={row.path}
                // Under a search a row stands for itself rather than for a place in a tree, so
                // it is drawn at one depth and named by its whole path — a bare last segment in
                // a flat list of matches names nothing a reader can act on.
                label={sought ? row.path : undefined}
                depth={sought ? 1 : row.depth + 1}
                isBranch={sought ? false : row.isBranch}
                open={row.open}
                active={lastHitOf(row, node) > activeSince}
                selected={row.path === selectedPath}
                // Nothing at or under it since the link came back on its own: from before the
                // drop. Not a row a hold draws — the pause already says it is standing still. Nor
                // while the console itself is stopped: see `stopped` above.
                staleSince={
                  !stopped && !drawn.held && returnedAt !== null && node.lastSubHitAt < returnedAt
                    ? returnedAt
                    : undefined
                }
                // The selected row carries the pause; so does any row with a hold of its own,
                // wherever the reader has gone since. A hold nobody can see is a hold nobody can
                // undo.
                actions={
                  row.path === selectedPath ? hold : holding.has(filter) ? holdsOn(filter) : undefined
                }
                rule={ruleOf(row.path)}
                onToggle={toggle}
                onSelect={onSelect}
              />
            );
          })}
        </div>
      )}

      {(hidden > 0 || forgotten > 0) && (
        <p className={styles.capped}>
          {hidden > 0 &&
            `${hidden.toLocaleString('en-GB')} more ${hidden === 1 ? 'topic' : 'topics'} ${sought ? 'matched' : 'not shown'}`}
          {hidden > 0 && forgotten > 0 && ' · '}
          {/* Not the same thing as the line before it, and the difference is the whole reason it
              is said: those are on screen's other side, these are gone. A tree that forgets is
              allowed to — a broker whose topic names carry an id would otherwise fill a laptop —
              but a tree that forgets in silence leaves a reader with an emptiness they cannot
              read. See MAX_TREE_TOPICS. */}
          {forgotten > 0 &&
            `${forgotten.toLocaleString('en-GB')} quiet ${forgotten === 1 ? 'topic' : 'topics'} forgotten`}
        </p>
      )}
    </>
  );
}

// A closed branch reports the traffic of its (undrawn) rows; an open one only its own, since
// its children are on screen to speak for themselves. The node is passed rather than read off
// the row: a held row is drawn from the node the hold froze, and its tint has to freeze with it.
const lastHitOf = (row: TopicRow, node: TopicNode) =>
  row.open && row.isBranch ? node.lastHitAt : node.lastSubHitAt;

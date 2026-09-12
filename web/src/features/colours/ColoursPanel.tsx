import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { getColourRules, putColourRules } from '../../api/colourRules';
import { queryKeys } from '../../api/queryKeys';
import { PanelShell } from '../../components/PanelShell';
import type { ColourRule } from '../../lib/topicColour';
import { useGuardedMutate } from '../../lib/useGuardedMutate';
import { logFault, useLogStore } from '../../stores/logStore';
import { useSelectionStore } from '../../stores/selectionStore';
import { useTopicTreeStore } from '../../stores/topicTreeStore';
import { describeError } from '../../lib/problemDetails';
import panel from '../../styles/panel.module.css';
import { Plus, Search } from '../brand/icons';
import { TopicPicker } from '../alerts/TopicPicker';
import { ColourPicker } from './ColourPicker';
import styles from './ColoursPanel.module.css';
import { paintedBy } from './painted';
import { nextColour } from './palette';
import { allSaved, draftFrom, faultIn, MAX_RULES, newDraftRule, type DraftRule } from './ruleDraft';

/**
 * Every colour rule, and what each of them is painting.
 *
 * It was a column: a swatch, a filter box and an × to a line, in the panel beside the tree, read
 * against the branch it would paint. That reading is the reason it stood there, and it is also
 * why it never said anything about itself — a filter with a typo in it and a filter painting
 * forty topics were the same row.
 *
 * It is the workspace now, drawn as the alerts panel draws its rules: a table with a heading, a
 * count of what each rule has actually taken, and one way to make another at the end of the line
 * the section is named on. What it gives up is the tree beside it, and it is given back inside
 * the panel — the same glass the alert editor wears, opening the same broker's tree.
 */

export function ColoursPanel({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  // Absent when nothing is picked, and when what is picked is not a topic — the broker row.
  const selectedTopic = useSelectionStore((state) => state.selected?.topic);
  const { data, isError } = useQuery({ queryKey: queryKeys.colourRules, queryFn: getColourRules });

  // The edits live here, not in the query cache. A half-typed filter is not a rule, and writing
  // one into the cache would recolour the tree behind the panel on every keystroke.
  const [draft, setDraft] = useState<DraftRule[] | null>(null);

  /**
   * The stored rules the draft was made from.
   *
   * It is how a draft nobody has typed into is told from one somebody has, and it exists because
   * the server's answer can change while the panel is open. Comparing the draft against `data`
   * cannot do that job: `data` is the thing that moved.
   */
  const [seed, setSeed] = useState<readonly ColourRule[] | null>(null);

  /**
   * Seeded on arrival, and seeded again for as long as nobody has typed.
   *
   * It used to be seeded once, and once was right for a console on its own: the cache is the
   * server's answer and a refetch after saving must not throw away what is on screen. It is
   * wrong for two, and two is what the QR panel is for. The panel opens on whatever the cache
   * holds and the fetch lands a moment later — so a console whose cache was written before the
   * phone saved a rule showed an empty list, called it 'Not saved yet', and offered a Save that
   * put its own emptiness over the rule. A person who had opened a panel and touched nothing
   * could delete somebody else's work in two clicks.
   *
   * So: while the draft still says exactly what it was seeded with, the newest answer replaces
   * it. Once anything has been typed the draft stands, unsaved edits are announced honestly, and
   * saving is the last-write-wins it has always been — which is a race between two people who
   * both meant it, rather than one between somebody and nobody.
   */
  useEffect(() => {
    if (!data) return;
    // Typed into since it was seeded: what is on screen is somebody's work and stays.
    if (draft !== null && seed !== null && differs(draft, seed)) return;
    // Already showing this answer. The guard that stops the seeding from re-seeding itself.
    if (draft !== null && !differs(draft, data)) return;

    setDraft(draftFrom(data));
    setSeed(data);
  }, [data, draft, seed]);

  /**
   * A row that has not been saved is still being decided on, so it follows the topic picked in
   * the tree — however many times the pick changes, and whatever the row says meanwhile. Saving
   * is what settles it: from then on the row is a rule someone meant, and clicking around the
   * tree leaves it alone.
   *
   * Keyed on the selection alone. Were the draft in here too, clearing a box to retype it would
   * be answered by the topic reappearing, and the box could not be cleared at all.
   */
  useEffect(() => {
    if (!selectedTopic) return;

    setDraft((current) => {
      if (current === null) return current;

      // The newest, since that is the one just added and being worked on.
      const following = current.findLastIndex((rule) => !rule.saved);
      if (following === -1) return current;

      return current.map((rule, index) =>
        index === following ? { ...rule, filter: selectedTopic } : rule,
      );
    });
  }, [selectedTopic]);

  const save = useMutation({
    mutationFn: putColourRules,
    onSuccess: (_result, rules) => {
      useLogStore.getState().push({
        kind: 'ok',
        verb: 'Colours saved',
        topic: rules.length === 1 ? rules[0].filter : `${rules.length} rules`,
      });
      // Settles every row: what the server took is no longer a draft that follows the tree.
      setDraft((current) => (current === null ? current : allSaved(current)));
      // And the draft is now made from what was saved, so a later answer from the server is
      // free to replace it again. Without this the panel would count itself edited for the rest
      // of its life and stop hearing the other console.
      setSeed(rules);
      void queryClient.invalidateQueries({ queryKey: queryKeys.colourRules });
    },
    // The draft is left as it was: what was typed is the only copy of it.
    onError: (error) => logFault('Colours not saved', error),
  });

  const guardedSave = useGuardedMutate(save);

  const rules = draft ?? [];
  const faults = rules.map((rule) => faultIn(rule, rules));
  const savable = draft !== null && faults.every((fault) => fault === null);
  const full = rules.length >= MAX_RULES;
  const unsaved = draft !== null && differs(rules, data ?? []);

  const edit = (id: number, change: Partial<DraftRule>) =>
    setDraft((current) => current!.map((rule) => (rule.id === id ? { ...rule, ...change } : rule)));

  /**
   * Which row's topic picker is open, if any.
   *
   * The panel takes the workspace now, so the tree it used to be read against is behind it. This
   * is the way back to it — the same glass the alert editor wears, opening the same tree — and
   * one at a time, because two open pickers is two lists of the broker's topics on screen with
   * nothing saying which row either of them fills in.
   */
  const [picking, setPicking] = useState<number | null>(null);

  /**
   * What each rule has actually taken, counted off the tree the panel is covering.
   *
   * Off the DRAFT rather than off what the server holds, so the number answers the filter being
   * typed rather than the one that was saved an hour ago. Memoised on the filters alone: a
   * colour is not a thing a topic can be matched by, and the tree changes on every message.
   */
  const root = useTopicTreeStore((state) => state.root);
  /*
   * The rules as the painter would see them — colours and all.
   *
   * The colour looks like something a count of topics could not possibly need, and passing a
   * placeholder for it is exactly what this did at first: every count came back nought, because
   * the lookup the tree paints with throws away any rule whose colour is not a usable triple, and
   * an empty string is not one. That is not a quirk to work around. It is the invariant worth
   * keeping: this column says what the tree is doing, so it has to be asked the same question the
   * tree asks, in the same words.
   *
   * The key is the rows as a string, NUL-separated — a topic filter may hold anything else, and
   * two lists differing only in where one filter ends must not come out as the same key.
   */
  const painted = rules.map(({ filter, colour }) => ({ filter, colour }));
  const key = painted.map((rule) => `${rule.filter}\u0000${rule.colour}`).join('\u0001');
  // `painted` is a fresh array every render and would defeat the memo; `key` is its contents.
  const painting = useMemo(() => paintedBy(root, painted), [root, key]);

  return (
    <PanelShell title="Colours" named onClose={onClose}>
      {/* Not an empty list: a save from a panel that never read the rules would replace them
          with whatever happened to be on screen. So it offers nothing until it has them. */}
      {isError && draft === null && (
        <p className={panel.fault}>
          The colour rules could not be read. The tree and the log carry on uncoloured.
        </p>
      )}

      {draft !== null && rules.length === 0 && (
        <div className={panel.nothingYet}>
          <p>
            No colour rules yet.
          </p>
        </div>
      )}

      {rules.length > 0 && (
        <div className={styles.rules}>
          <div className={`${styles.rulesHead} ${panel.rulesHead}`} aria-hidden="true">
            <span>#</span>
            {/* Two colours, two columns, in the order the reader sees them on a log row: the
                topic on top and the message under it. Heading each is what makes a bare pair of
                swatches readable — side by side and unlabelled they are two colours and no
                question. */}
            <span>Topic</span>
            <span>Message</span>
            <span>Topic filter</span>
            <span>Painting</span>
            <span />
          </div>

          {rules.map((rule, index) => (
            <div key={rule.id} className={styles.ruleRow} data-testid="colour-rule">
              {/* Its place in the list, for pointing at a row in a sentence somebody says out
                  loud. NOT precedence: which rule paints a topic is decided by which filter says
                  more about it, wherever the two happen to sit. The Painting column is where that
                  is answered — a general rule under a specific one reads 'none'. */}
              <span className={panel.ruleNumber}>{index + 1}</span>

              <ColourPicker
                colour={rule.colour}
                filter={rule.filter}
                what="topic"
                // Never null: the topic's picker offers no way to clear one, because a topic drawn
                // in no colour is a topic with no rule. The guard is what says so in the types.
                onChange={(colour) => colour && edit(rule.id, { colour })}
              />

              {/* The message's own colour, and it may be none — which is what it is until
                  somebody says otherwise. A topic told apart by colour usually wants its payload
                  left in the console's ink; a rule watching one device's telemetry among forty
                  wants both, and until now could only have the first. */}
              <ColourPicker
                colour={rule.bodyColour}
                filter={rule.filter}
                what="message"
                clearable
                fallback={rule.colour}
                onChange={(bodyColour) => edit(rule.id, { bodyColour })}
              />

              {/* The box and the way to fill it in, on one line. The glass used to stand at the
                  far end of the row, past the count — two columns away from the only field it
                  writes into, and reading as a third thing you can do to a rule rather than as
                  the field's own control. */}
              <span className={styles.filterCell}>
                <input
                  className={styles.filter}
                  value={rule.filter}
                  spellCheck={false}
                  placeholder="sensors/+/temp"
                  aria-label={`Topic filter for rule ${index + 1}`}
                  aria-invalid={faults[index] !== null}
                  onChange={(event) => edit(rule.id, { filter: event.target.value })}
                />

                <button
                  type="button"
                  className={styles.rowMark}
                  aria-expanded={picking === rule.id}
                  aria-label={
                    picking === rule.id
                      ? `Hide topics on the broker for rule ${index + 1}`
                      : `Show topics on the broker for rule ${index + 1}`
                  }
                  title="Pick a topic off the broker"
                  onClick={() => setPicking((open) => (open === rule.id ? null : rule.id))}
                >
                  <Search />
                </button>
              </span>

              <span
                className={styles.painting}
                /* A rule painting nothing is the point of the column, so it is not drawn in the
                   same grey as a rule painting forty. Not the fault colour either: it is not
                   wrong, it is idle — usually a filter another rule has taken every topic off. */
                data-idle={rule.filter !== '' && (painting.get(rule.filter) ?? 0) === 0 ? '' : undefined}
              >
                {paintingWords(rule.filter, painting)}
              </span>

              <span className={styles.rowActions}>
                <button
                  type="button"
                  className={styles.remove}
                  aria-label={`Remove the rule for ${rule.filter || 'this filter'}`}
                  onClick={() => {
                    setDraft((current) => current!.filter((other) => other.id !== rule.id));
                    setPicking((open) => (open === rule.id ? null : open));
                  }}
                >
                  ×
                </button>
              </span>

              {/* Both of these span the row's columns. They are about the row rather than about
                  one cell of it, and dropped into a grid track they would be a paragraph three
                  words wide under the swatch. */}
              {faults[index] && <p className={styles.rowFault}>{faults[index]}</p>}

              {picking === rule.id && (
                <div className={styles.rowPicker}>
                  <TopicPicker
                    onPick={(filter) => {
                      edit(rule.id, { filter });
                      setPicking(null);
                    }}
                    onClose={() => setPicking(null)}
                  />
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {full && <p className={panel.note}>That is a hundred colour rules, which is all the API keeps.</p>}

      {unsaved && <p className={panel.note}>Not saved yet — closing this panel loses these edits.</p>}

      {/* A save that did not happen, where the reader pressed. It is in the broker's record too,
          which is a panel away — and a Save that comes back enabled with the same list still on
          screen is indistinguishable from one that worked. */}
      {save.isError && (
        <p className={panel.fault} data-testid="save-fault">
          Not saved. {describeError(save.error)}
        </p>
      )}

      {/* One row at the foot, and the two things on it are two different scales: Save answers for
          the whole list and reads first, New rule adds one more to it and sits where a hand
          reaching past the list goes. The heading they used to hang off is gone — a panel that
          says COLOURS across the top of itself does not need a second word saying these are the
          rules, when rules are the only thing in it.

          Save is not drawn over an empty list nobody has touched: a rule across the panel with
          one dead button under it is a floor under nothing. Emptying the list by hand is a
          different thing — that is an edit, and it has to be saveable — so `unsaved` brings it
          back. And so does a draft that was never read: there it is present and refuses, which is
          the panel saying it will not overwrite rules it could not load. New rule is on the row
          either way, because an empty list is exactly where a reader wants it. */}
      <div className={`${panel.actions} ${styles.footer}`}>
        {(draft === null || rules.length > 0 || unsaved) && (
          <button
            type="button"
            className="keeps"
            disabled={!savable || save.isPending}
            onClick={() =>
              guardedSave(rules.map(({ filter, colour, bodyColour }) => ({ filter, colour, bodyColour })))
            }
          >
            Save
          </button>
        )}

        <button
          type="button"
          className={`ghost ${panel.iconButton} ${panel.trailing}`}
          disabled={draft === null || full}
          title={
            selectedTopic
              ? `Add a rule for ${selectedTopic}`
              : 'Add a rule — an unsaved one follows the tree'
          }
          onClick={() =>
            setDraft((current) => [
              ...current!,
              {
                ...newDraftRule(nextColour(current!.map((rule) => rule.colour))),
                // The topic last picked in the tree is the one a new rule is usually for. Only
                // the new row: an edit in progress above it is not the selection's business.
                filter: selectedTopic ?? '',
              },
            ])
          }
        >
          <Plus />
          New rule
        </button>
      </div>
    </PanelShell>
  );
}

/**
 * What the Painting cell says.
 *
 * A count, or the reason there is not one. 'Nothing yet' and 'none' are different answers and the
 * difference is the whole value of the column: nothing yet means the broker has not sent anything
 * this rule covers, and none means it has and another rule took it — a filter shadowed by a more
 * specific one, which is otherwise invisible and is the commonest way a colour rule does nothing.
 */
function paintingWords(filter: string, painted: ReadonlyMap<string, number>): string {
  if (filter === '') return '';

  const count = painted.get(filter) ?? 0;

  return count === 0 ? 'none' : `${count} ${count === 1 ? 'topic' : 'topics'}`;
}

/**
 * Whether the rows on screen still say what the server holds.
 *
 * A repaired colour counts as a difference, and should: a rules file edited by hand into
 * something the panel had to fix arrives already needing a save.
 *
 * The message's colour is compared through `ink`, which reads absent and null as the one thing
 * they both mean — no colour. Without that, a rule the server sends with no second colour at all
 * would differ from the same rule on screen carrying null, and the panel would announce unsaved
 * edits to a panel nobody had touched.
 *
 * A stored value the panel could not use is NOT read as none, though the row shows none: it is a
 * difference, and saying so is what offers to write the repair back — the same answer the topic's
 * colour gives to the same hand-edited file.
 */
function differs(rows: readonly DraftRule[], stored: readonly ColourRule[]): boolean {
  if (rows.length !== stored.length) return true;

  return rows.some(
    (row, index) =>
      row.filter !== stored[index].filter ||
      row.colour !== stored[index].colour.toLowerCase() ||
      row.bodyColour !== ink(stored[index].bodyColour),
  );
}

/** A stored message colour, with absent and null said the same way. */
const ink = (colour: string | null | undefined): string | null =>
  colour == null ? null : colour.toLowerCase();

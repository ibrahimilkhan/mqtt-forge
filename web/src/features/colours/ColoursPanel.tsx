import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { getColourRules, putColourRules } from '../../api/colourRules';
import { getSavedProfiles } from '../../api/connection';
import { queryKeys } from '../../api/queryKeys';
import { useLinkProfile } from '../../api/useConnectionState';
import { PanelShell } from '../../components/PanelShell';
import { rulesFor, type ColourRule } from '../../lib/topicColour';
import { useGuardedMutate } from '../../lib/useGuardedMutate';
import { logFault, useLogStore } from '../../stores/logStore';
import { useSelectionStore } from '../../stores/selectionStore';
import { useTopicTreeStore } from '../../stores/topicTreeStore';
import { describeError } from '../../lib/problemDetails';
import panel from '../../styles/panel.module.css';
import { Plus } from '../brand/icons';
import styles from './ColoursPanel.module.css';
import { paintedBy, paintingCell } from './painted';
import { nextColour } from './palette';
import { RuleRow } from './RuleRow';
import { allSaved, differs, draftFrom, faultIn, MAX_RULES, newDraftRule, type DraftRule } from './ruleDraft';
import { useTopicSet } from './useTopicSet';

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
  // The broker whose rules are painting now, and every saved broker a rule can belong to.
  const profileId = useLinkProfile();
  const { data: profiles } = useQuery({ queryKey: queryKeys.savedProfiles, queryFn: getSavedProfiles });

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
   * typed rather than the one that was saved an hour ago. Memoised on the filters and on the SET
   * of topics, not on the tree itself: the tree is new on every message, and counting forty
   * thousand topics on every frame of traffic is what made this panel stutter. See useTopicSet.
   */
  const topicSet = useTopicSet();
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
   *
   * Only the rules the tree is painting with: the broker's that is up, and the ones for every
   * broker it has not overruled. A rule for another broker paints nothing here, and counting it
   * against this broker's tree would claim topics it will never touch.
   */
  const applying = rulesFor(rules, profileId);
  const painted = applying.map(({ filter, colour }) => ({ filter, colour }));
  const key = painted.map((rule) => `${rule.filter}\u0000${rule.colour}`).join('\u0001');
  // `painted` is a fresh array every render and would defeat the memo; `key` is its contents. The
  // tree is read as it stands when either moves, rather than subscribed to.
  const painting = useMemo(
    () => paintedBy(useTopicTreeStore.getState().root, painted),
    [topicSet, key],
  );
  const applies = new Set(applying.map((rule) => rule.id));

  /** Another broker's rule: kept on the list, drawn faded, and painting nothing while this is up. */
  const elsewhere = (rule: DraftRule) => rule.profileId !== null && rule.profileId !== profileId;

  return (
    <PanelShell title="Colours" named onClose={onClose}>
      {/* At the top right, over the list rather than under it. Under it, New rule stood on a row
          ruled off from the list — and over an empty list that rule ran across the middle of the
          page, cutting a page that is only ever about its rules in two. Here it is where the eye
          starts and the list hangs from it, however long or short the list is. */}
      <div className={styles.toolbar}>
        <button
          type="button"
          className={panel.iconButton}
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
                // For the broker that is up, if it is a saved one: a rule is usually written about
                // what is in front of the reader, and that is this broker's tree.
                ...newDraftRule(nextColour(current!.map((rule) => rule.colour)), profileId),
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

      {/* Not an empty list: a save from a panel that never read the rules would replace them
          with whatever happened to be on screen. So it offers nothing until it has them. */}
      {isError && draft === null && (
        <p className={panel.fault}>
          The colour rules could not be read. The tree and the log carry on uncoloured.
        </p>
      )}

      {draft !== null && rules.length === 0 && (
        <div className={panel.nothingYet}>
          {/* What the panel is for, and the one control that starts it — the sentence the alerts
              panel says over its own empty list. 'No colour rules yet.' on its own told a first
              reader what was missing and nothing about what a rule is. */}
          <p>No colour rules yet. Press <b>New rule</b> and give a topic filter a colour.</p>
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
            <span>Broker</span>
            <span>Painting</span>
            <span />
          </div>

          {rules.map((rule, index) => (
            <RuleRow
              key={rule.id}
              rule={rule}
              index={index}
              fault={faults[index]}
              profiles={profiles}
              elsewhere={elsewhere(rule)}
              painting={paintingCell({
                filter: rule.filter,
                elsewhere: elsewhere(rule),
                // Not applying: a rule for every broker that this broker's own rule on the same
                // filter overrules.
                applies: applies.has(rule.id),
                count: painting.get(rule.filter) ?? 0,
              })}
              picking={picking === rule.id}
              onEdit={(change) => edit(rule.id, change)}
              onRemove={() => {
                setDraft((current) => current!.filter((other) => other.id !== rule.id));
                setPicking((open) => (open === rule.id ? null : open));
              }}
              onTogglePicker={() => setPicking((open) => (open === rule.id ? null : rule.id))}
              onPick={(filter) => {
                edit(rule.id, { filter });
                setPicking(null);
              }}
              onClosePicker={() => setPicking(null)}
            />
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

      {/* Save answers for the whole list, so it stands at the foot of it — with no rule over it:
          the list ends where its last row does, and a line under that was a second ending.

          Save is not drawn over an empty list nobody has touched: one dead button under nothing.
          Emptying the list by hand is a different thing — that is an edit, and it has to be
          saveable — so `unsaved` brings it back. And so does a draft that was never read: there
          it is present and refuses, which is the panel saying it will not overwrite rules it
          could not load. */}
      {(draft === null || rules.length > 0 || unsaved) && (
        <div className={`${panel.actions} ${styles.footer}`}>
          <button
            type="button"
            disabled={!savable || save.isPending}
            onClick={() =>
              guardedSave(
                rules.map(({ filter, colour, bodyColour, profileId: owner }) =>
                  // Left off for every broker, which is what a rule without one has always meant.
                  owner === null ? { filter, colour, bodyColour } : { filter, colour, bodyColour, profileId: owner },
                ),
              )
            }
          >
            Save
          </button>
        </div>
      )}
    </PanelShell>
  );
}

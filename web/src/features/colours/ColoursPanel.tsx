import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { getColourRules, putColourRules } from '../../api/colourRules';
import { getSavedProfiles } from '../../api/connection';
import { queryKeys } from '../../api/queryKeys';
import { PanelShell } from '../../components/PanelShell';
import { rulesFor, type ColourRule } from '../../lib/topicColour';
import { useLinkScope } from '../../lib/useLinkScope';
import { useGuardedMutate } from '../../lib/useGuardedMutate';
import { logFault, useLogStore } from '../../stores/logStore';
import { useSelectionStore } from '../../stores/selectionStore';
import { describeError } from '../../lib/problemDetails';
import panel from '../../styles/panel.module.css';
import { Plus } from '../brand/icons';
import styles from './ColoursPanel.module.css';
import { nextColour } from './palette';
import { RuleRow } from './RuleRow';
import { allSaved, differs, draftFrom, faultIn, MAX_RULES, newDraftRule, type DraftRule } from './ruleDraft';

type View = 'all' | 'broker';

const RULES_PANEL = 'colour-rules';

/**
 * Every colour rule, and which broker each of them is for.
 *
 * It was a column: a swatch, a filter box and an × to a line, in the panel beside the tree, read
 * against the branch it would paint. That reading is the reason it stood there, and it is also
 * why there was nowhere on the line to say which broker a rule was for.
 *
 * It is the workspace now, drawn as the alerts panel draws its rules: a table with a heading, the
 * broker each rule belongs to, and one way to make another at the end of the line the section is
 * named on. How many topics a rule has taken is not on it: the tree says what is painted, and a
 * count beside every rule was a column of numbers nobody was asking for. What it gives up is the tree beside it, and it is given back inside
 * the panel — the same glass the alert editor wears, opening the same broker's tree.
 */

export function ColoursPanel({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  // Absent when nothing is picked, and when what is picked is not a topic — the broker row.
  const selectedTopic = useSelectionStore((state) => state.selected?.topic);
  const { data, isError } = useQuery({ queryKey: queryKeys.colourRules, queryFn: getColourRules });
  // The broker whose rules are painting now — saved or not, known by its address either way —
  // and every saved broker a rule can belong to.
  const scope = useLinkScope();
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

  /*
   * The rules the tree is painting with: the broker's that is up, and the ones for every broker it
   * has not overruled. What this broker's tab lists, and what a row is told it is not when it is
   * another broker's.
   */
  const applying = rulesFor(rules, scope?.keys ?? []);
  const applies = new Set(applying.map((rule) => rule.id));

  /** Another broker's rule: kept on the list, drawn faded, and painting nothing while this is up. */
  const elsewhere = (rule: DraftRule) => rule.profileId !== null && !scope?.keys.includes(rule.profileId);

  /**
   * Which list is on screen: every rule, or only the ones painting the broker that is up.
   *
   * The second is the question a reader with a tree in front of them is usually asking — why is
   * this topic that colour — and with rules for several brokers on one list the answer was mixed
   * in with rows drawn faded because they paint nothing here. It is the rules the tree is drawn
   * with: the broker's own, and the ones for every broker it has not overruled.
   *
   * Saved or not: a broker that was never saved is known by its address. Disabled only before any
   * link has come up, when there is no 'this broker' to narrow to.
   */
  // On this broker's list when there is a broker: it is the one the tree behind the panel is drawn
  // with, so it comes first and is where the panel opens.
  const [view, setView] = useState<View>('broker');
  const shown: View = scope === null ? 'all' : view;
  const brokerName = scope?.name;
  // An unsaved row stays on either list. One whose broker is being changed would otherwise vanish
  // from under the reader at the first pick of the select, before they had decided anything.
  const onBroker = (rule: DraftRule) => applies.has(rule.id) || !rule.saved;
  const visible = shown === 'broker' ? rules.filter(onBroker) : rules;
  const tabs = useRef<Record<View, HTMLButtonElement | null>>({ all: null, broker: null });

  const onTabKey = (event: KeyboardEvent) => {
    // A modified arrow is the browser's — Alt and Left is Back — not the list's.
    if (event.altKey || event.ctrlKey || event.metaKey || scope === null) return;
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;

    event.preventDefault();
    // Two tabs, so every key that moves at all lands on the other one — except Home and End,
    // which say which.
    const to: View =
      event.key === 'Home' ? 'broker' : event.key === 'End' ? 'all' : shown === 'all' ? 'broker' : 'all';
    setView(to);
    tabs.current[to]?.focus();
  };

  return (
    <PanelShell title="Colours" named onClose={onClose}>
      {/* At the top right, over the list rather than under it. Under it, New rule stood on a row
          ruled off from the list — and over an empty list that rule ran across the middle of the
          page, cutting a page that is only ever about its rules in two. Here it is where the eye
          starts and the list hangs from it, however long or short the list is. */}
      <div className={styles.toolbar}>
        <div className={styles.tabs} role="tablist" aria-label="Which rules" onKeyDown={onTabKey}>
          {(['broker', 'all'] as const).map((tab) => (
            <button
              key={tab}
              ref={(element) => {
                tabs.current[tab] = element;
              }}
              id={`colours-tab-${tab}`}
              type="button"
              role="tab"
              aria-selected={shown === tab}
              aria-controls={RULES_PANEL}
              tabIndex={shown === tab ? 0 : -1}
              className={styles.tab}
              disabled={tab === 'broker' && scope === null}
              title={
                tab === 'broker'
                  ? scope === null
                    ? 'Connect a broker to see only the rules painting it.'
                    : `The rules painting ${brokerName ?? 'this broker'}.`
                  : undefined
              }
              onClick={() => setView(tab)}
            >
              {/* The broker by name — its saved one, or its address — rather than 'This broker' and
                  the name after it: the address is the answer to which broker, and the words in
                  front of it only pushed it towards the cut. */}
              {tab === 'all' ? 'All' : <span className={styles.tabName}>{brokerName ?? 'No broker'}</span>}
              <span className={styles.tabCount}>
                {tab === 'all' ? rules.length : scope === null ? '–' : rules.filter(onBroker).length}
              </span>
            </button>
          ))}
        </div>

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
                // For the broker that is up, by its saved id or else its address: a rule is usually
                // written about what is in front of the reader, and that is this broker's tree.
                ...newDraftRule(nextColour(current!.map((rule) => rule.colour)), scope?.own ?? null),
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

      <div role="tabpanel" id={RULES_PANEL} aria-labelledby={`colours-tab-${shown}`}>
        {draft !== null && rules.length === 0 && (
          <div className={panel.nothingYet}>
            {/* What the panel is for, and the one control that starts it — the sentence the alerts
                panel says over its own empty list. 'No colour rules yet.' on its own told a first
                reader what was missing and nothing about what a rule is. */}
            <p>No colour rules yet. Press <b>New rule</b> and give a topic filter a colour.</p>
          </div>
        )}

        {/* Rules there are, none of them on this broker: the list is not empty, and saying so with
            the sentence for an empty one would read as the rules having gone. */}
        {shown === 'broker' && rules.length > 0 && visible.length === 0 && (
          <div className={panel.nothingYet}>
            <p>
              No rule paints this broker. Its topics take the default colours — the rules for other
              brokers are under <b>All</b>.
            </p>
          </div>
        )}

        {visible.length > 0 && (
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
              <span />
            </div>

            {visible.map((rule) => (
              <RuleRow
                key={rule.id}
                rule={rule}
                // Its place in the whole list, not in the one on screen: the number is how the row
                // is named to a screen reader, and a rule that changed name with the tab would be
                // two rules to anyone who heard both.
                index={rules.indexOf(rule)}
                fault={faults[rules.indexOf(rule)]}
                profiles={profiles}
                current={scope}
                elsewhere={elsewhere(rule)}
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
      </div>

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

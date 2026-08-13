import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { getColourRules, putColourRules } from '../../api/colourRules';
import { queryKeys } from '../../api/queryKeys';
import { PanelShell } from '../../components/PanelShell';
import { useGuardedMutate } from '../../lib/useGuardedMutate';
import { logFault, useLogStore } from '../../stores/logStore';
import panel from '../../styles/panel.module.css';
import { ColourPicker } from './ColourPicker';
import styles from './ColoursPanel.module.css';
import { nextColour } from './palette';
import { draftFrom, faultIn, newDraftRule, type DraftRule } from './ruleDraft';

export function ColoursPanel({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const { data } = useQuery({ queryKey: queryKeys.colourRules, queryFn: getColourRules });

  // The edits live here, not in the query cache. A half-typed filter is not a rule, and writing
  // one into the cache would recolour the tree behind the panel on every keystroke.
  const [draft, setDraft] = useState<DraftRule[] | null>(null);

  // Seeded once. A refetch after saving must not throw away what is on screen.
  useEffect(() => {
    if (draft === null && data) setDraft(draftFrom(data));
  }, [data, draft]);

  const save = useMutation({
    mutationFn: putColourRules,
    onSuccess: (_result, rules) => {
      useLogStore.getState().push({
        kind: 'ok',
        verb: 'Colours saved',
        topic: rules.length === 1 ? rules[0].filter : `${rules.length} rules`,
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.colourRules });
    },
    // The draft is left as it was: what was typed is the only copy of it.
    onError: (error) => logFault('Colours not saved', error),
  });

  const guardedSave = useGuardedMutate(save);

  const rules = draft ?? [];
  const faults = rules.map((rule) => faultIn(rule, rules));
  const savable = draft !== null && faults.every((fault) => fault === null);

  const edit = (id: number, change: Partial<DraftRule>) =>
    setDraft((current) => current!.map((rule) => (rule.id === id ? { ...rule, ...change } : rule)));

  return (
    <PanelShell title="Colours" onClose={onClose}>
      <p className={panel.note}>
        A topic wears the colour of the most specific filter that covers it, in the tree and in
        the log.
      </p>

      {draft !== null && rules.length === 0 && (
        <p className="empty">No colour rules yet. Add one and pick a colour for it.</p>
      )}

      <div className={styles.rules}>
        {rules.map((rule, index) => (
          <div key={rule.id} className={styles.rule} data-testid="colour-rule">
            <div className={styles.ruleRow}>
              <ColourPicker
                colour={rule.colour}
                filter={rule.filter}
                onChange={(colour) => edit(rule.id, { colour })}
              />

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
                className={styles.remove}
                aria-label={`Remove the rule for ${rule.filter || 'this filter'}`}
                onClick={() => setDraft((current) => current!.filter((other) => other.id !== rule.id))}
              >
                ×
              </button>
            </div>

            {faults[index] && <p className={panel.fault}>{faults[index]}</p>}
          </div>
        ))}
      </div>

      <div className={panel.actions}>
        <button
          type="button"
          className="ghost"
          disabled={draft === null}
          onClick={() => setDraft((current) => [...current!, newDraftRule(nextColour(current!.map((r) => r.colour)))])}
        >
          Add rule
        </button>

        <button
          type="button"
          disabled={!savable || save.isPending}
          onClick={() => guardedSave(rules.map(({ filter, colour }) => ({ filter, colour })))}
        >
          Save
        </button>
      </div>
    </PanelShell>
  );
}

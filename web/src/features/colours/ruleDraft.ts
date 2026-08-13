import type { ColourRule } from '../../lib/topicColour';

/** A rule while it is being edited. The id exists only to key the row; it is never sent. */
export type DraftRule = { id: number; filter: string; colour: string };

let nextId = 0;

export const draftFrom = (rules: readonly ColourRule[]): DraftRule[] =>
  rules.map((rule) => ({ id: nextId++, filter: rule.filter, colour: rule.colour }));

export const newDraftRule = (colour: string): DraftRule => ({ id: nextId++, filter: '', colour });

/**
 * Why this row cannot be saved, in the words of the person who typed it — or null when it can.
 *
 * The same rules the API enforces, said here so a mistake is answered while it is still on
 * screen rather than by a 400 after the fact.
 */
export function faultIn(rule: DraftRule, all: readonly DraftRule[]): string | null {
  if (rule.filter === '') return 'A topic filter cannot be empty.';

  const segments = rule.filter.split('/');

  for (const [index, segment] of segments.entries()) {
    if (segment === '#' && index !== segments.length - 1) {
      return "'#' can only be the last segment.";
    }
    if (segment !== '#' && segment.includes('#')) {
      return "'#' has to be a whole segment, on its own.";
    }
    if (segment !== '+' && segment.includes('+')) {
      return "'+' has to be a whole segment, on its own.";
    }
  }

  // Compared against the rows above it, so the duplicate is reported on the one just typed
  // rather than on the rule that was already there.
  const earlier = all.slice(0, all.indexOf(rule));
  if (earlier.some((other) => other.filter === rule.filter)) {
    return 'That filter already has a colour.';
  }

  return null;
}

import { isColour, type ColourRule } from '../../lib/topicColour';
import { nextColour } from './palette';

/**
 * A rule while it is being edited. The id exists only to key the row; it is never sent.
 *
 * `saved` is what separates a rule someone settled on from one still being decided: an unsaved
 * row goes on following the topic picked in the tree, a saved one is left where it is.
 */
export type DraftRule = { id: number; filter: string; colour: string; saved: boolean };

/** What the API accepts. Held here too so the answer arrives before the round trip, as a sentence. */
export const MAX_RULES = 100;

let nextId = 0;

/**
 * The stored rules, as rows that can be edited.
 *
 * A colour that is not a hex triple is replaced rather than carried: the file can be edited by
 * hand past the API's validation, and what it then holds would go into an inline style and into
 * a colour input, neither of which can do anything with it. The filter is the part worth
 * keeping, so the row survives wearing a colour it can actually show — and saying so by wearing
 * an obviously different one.
 */
export function draftFrom(rules: readonly ColourRule[]): DraftRule[] {
  const usable: DraftRule[] = [];

  for (const rule of rules) {
    const colour = isColour(rule.colour)
      ? rule.colour.toLowerCase()
      : nextColour(usable.map((row) => row.colour));

    usable.push({ id: nextId++, filter: rule.filter, colour, saved: true });
  }

  return usable;
}

export const newDraftRule = (colour: string): DraftRule => ({
  id: nextId++,
  filter: '',
  colour,
  saved: false,
});

/** After a save the server took: every row on screen is now a rule someone settled on. */
export const allSaved = (rules: readonly DraftRule[]): DraftRule[] =>
  rules.map((rule) => ({ ...rule, saved: true }));

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

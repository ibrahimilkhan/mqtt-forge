import { isColour, type ColourRule } from '../../lib/topicColour';
import { nextColour } from './palette';

/**
 * A rule while it is being edited. The id exists only to key the row; it is never sent.
 *
 * `saved` is what separates a rule someone settled on from one still being decided: an unsaved
 * row goes on following the topic picked in the tree, a saved one is left where it is.
 */
export type DraftRule = {
  id: number;
  filter: string;
  colour: string;
  /** The message's own colour, or null for the console's ink — which is what most rules want. */
  bodyColour: string | null;
  /** The saved broker it belongs to, or null for every broker. */
  profileId: string | null;
  saved: boolean;
};

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

    // The second colour is not replaced when it is unusable, it is dropped. A topic has to be
    // drawn in something, so a rule with a broken first colour is repaired into a visible one;
    // a message has somewhere to fall back to, and 'the console's ink' is a real answer rather
    // than a stand-in. Repairing it would invent a colour nobody chose.
    const bodyColour = isColour(rule.bodyColour) ? rule.bodyColour.toLowerCase() : null;

    usable.push({
      id: nextId++,
      filter: rule.filter,
      colour,
      bodyColour,
      profileId: rule.profileId || null,
      saved: true,
    });
  }

  return usable;
}

export const newDraftRule = (colour: string, profileId: string | null = null): DraftRule => ({
  id: nextId++,
  filter: '',
  colour,
  // A new rule paints the topic only. Two colours on arrival would be the panel deciding that
  // every rule wants its payloads repainted too, which is the rarer of the two wishes.
  bodyColour: null,
  profileId,
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
  // For the same broker: one rule for every broker and one for a broker on the same filter are the
  // general colour and its exception, and two brokers' rules are never up at once.
  if (earlier.some((other) => other.filter === rule.filter && other.profileId === rule.profileId)) {
    return 'That filter already has a colour.';
  }

  return null;
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
export function differs(rows: readonly DraftRule[], stored: readonly ColourRule[]): boolean {
  if (rows.length !== stored.length) return true;

  return rows.some(
    (row, index) =>
      row.filter !== stored[index].filter ||
      row.colour !== stored[index].colour.toLowerCase() ||
      row.bodyColour !== ink(stored[index].bodyColour) ||
      row.profileId !== (stored[index].profileId || null),
  );
}

/** A stored message colour, with absent and null said the same way. */
const ink = (colour: string | null | undefined): string | null =>
  colour == null ? null : colour.toLowerCase();

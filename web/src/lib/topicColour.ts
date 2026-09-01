import { matchesFilter } from './topicMatch';

/**
 * One user-chosen colour and the MQTT filter whose topics wear it — and, when the reader asked
 * for one, a second colour for the message underneath.
 *
 * `bodyColour` is optional because absent and present are different requests. A rule that paints
 * a topic says nothing about the payload beneath it, and the console goes on drawing that in its
 * own ink; a rule that carries the second colour is one somebody deliberately gave two.
 */
export type ColourRule = { filter: string; colour: string; bodyColour?: string | null };

/**
 * A `#rrggbb` triple and nothing else.
 *
 * The value ends up in an inline style attribute, so it is checked here as well as at the API —
 * a rules file can be hand-edited, and data arriving over the network is still untrusted input.
 */
export function isColour(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value);
}

/**
 * Whether a string is a well-formed MQTT topic filter. An empty segment is legal — 'a//b' has
 * three levels and an empty middle one — so only the wildcards are policed.
 */
export function isFilter(value: unknown): value is string {
  if (typeof value !== 'string' || value === '') return false;

  const segments = value.split('/');

  return segments.every((segment, index) => {
    if (segment === '#') return index === segments.length - 1;
    if (segment === '+') return true;
    return !segment.includes('#') && !segment.includes('+');
  });
}

/**
 * How much of a topic a filter actually pins down, segment by segment. Higher is more specific:
 * a filter that ends here has said everything about the topic's length; a named segment says
 * what that level holds; '+' says only that a level exists; '#' says nothing at all.
 */
function specificity(segments: readonly string[], index: number): number {
  const segment = segments[index];

  if (segment === undefined) return 3;
  if (segment === '#') return 0;
  if (segment === '+') return 1;
  return 2;
}

/**
 * Most specific first, read left to right: the first level where two filters disagree decides
 * between them, the way a routing table prefers the longest concrete prefix.
 *
 * The comparison always resolves for two filters that are not identical. Two filters without '#'
 * that match the same topic have the same number of segments, so a difference has to appear at
 * some level; and '#' only ever sits last, where it loses to whatever the other filter has there
 * — including to having nothing left.
 */
function compareSpecificity(a: readonly string[], b: readonly string[]): number {
  const levels = Math.max(a.length, b.length);

  for (let i = 0; i < levels; i++) {
    const difference = specificity(b, i) - specificity(a, i);
    if (difference !== 0) return difference;
  }

  return 0;
}

/**
 * The rules in the order they should be consulted, with anything malformed dropped.
 *
 * Sorting is a property of the rules alone, not of the topic being looked up, so it happens once
 * per rule list rather than once per row on screen.
 */
export function sortRules(rules: readonly ColourRule[]): ColourRule[] {
  return rules
    .filter((rule) => isFilter(rule?.filter) && isColour(rule?.colour))
    .map((rule) => ({
      filter: rule.filter,
      colour: rule.colour.toLowerCase(),
      // Dropped rather than kept when it is not a usable triple, and the rule survives without
      // it: the second colour is an addition to a rule, so a nonsense one costs the payload its
      // colour and leaves the topic still painted. Absent stays absent.
      ...(isColour(rule.bodyColour) ? { bodyColour: rule.bodyColour.toLowerCase() } : {}),
    }))
    .sort((a, b) => compareSpecificity(a.filter.split('/'), b.filter.split('/')));
}

/**
 * The rule covering a topic, or null when none does.
 *
 * The rule rather than just its colour, because the row wants to be able to say which filter
 * painted it — with several rules overlapping, that is the question a colour raises.
 *
 * The rules are snapshotted and sorted once, and each answer is remembered: the tree asks for the
 * same topics on every render, and a busy broker puts a thousand rows on screen. Remembering the
 * rule object also keeps its identity stable, so a memoised row sees an unchanged prop. A changed
 * rule list means a new lookup, which is what throws the remembered answers away.
 */
export function createRuleLookup(rules: readonly ColourRule[]): (topic: string) => ColourRule | null {
  const sorted = sortRules(rules);
  const known = new Map<string, ColourRule | null>();

  return (topic: string) => {
    const remembered = known.get(topic);
    if (remembered !== undefined) return remembered;

    const match = sorted.find((rule) => matchesFilter(rule.filter, topic)) ?? null;

    known.set(topic, match);
    return match;
  };
}

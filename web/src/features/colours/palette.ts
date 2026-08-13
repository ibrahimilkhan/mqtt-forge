/**
 * The colours offered before the picker.
 *
 * Chosen to be told apart from each other at the size of a 7px dot, and to sit away from the
 * ink and muted greys the rows are already drawn in. Free choice is one click further on — this
 * is the shortlist, not the limit.
 */
export const SUGGESTED = [
  '#ab3520', // brick
  '#b45309', // amber
  '#8a6d00', // ochre
  '#0d7a63', // teal
  '#1e40af', // ink blue
  '#6d28d9', // violet
  '#a21caf', // magenta
  '#3f5060', // slate
] as const;

/** The first suggestion nothing is using yet, so a new rule arrives with a colour of its own. */
export function nextColour(taken: readonly string[]): string {
  const used = new Set(taken.map((colour) => colour.toLowerCase()));

  return SUGGESTED.find((colour) => !used.has(colour)) ?? SUGGESTED[taken.length % SUGGESTED.length];
}

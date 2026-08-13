/**
 * The colours offered before the picker, and what to call them.
 *
 * Chosen to be told apart from each other at the size of a 7px dot, and to sit away from the
 * ink and muted greys the rows are already drawn in. Free choice is one click further on — this
 * is the shortlist, not the limit.
 *
 * Named because the name is what a screen reader can use. '#0d7a63' read out is a spelling test.
 */
export const PALETTE = [
  { name: 'Brick', value: '#ab3520' },
  { name: 'Amber', value: '#b45309' },
  { name: 'Ochre', value: '#8a6d00' },
  { name: 'Teal', value: '#0d7a63' },
  { name: 'Blue', value: '#1e40af' },
  { name: 'Violet', value: '#6d28d9' },
  { name: 'Magenta', value: '#a21caf' },
  { name: 'Slate', value: '#3f5060' },
] as const;

export const SUGGESTED = PALETTE.map((colour) => colour.value);

/** The first suggestion nothing is using yet, so a new rule arrives with a colour of its own. */
export function nextColour(taken: readonly string[]): string {
  const used = new Set(taken.map((colour) => colour.toLowerCase()));

  return SUGGESTED.find((colour) => !used.has(colour)) ?? SUGGESTED[taken.length % SUGGESTED.length];
}

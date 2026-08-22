/**
 * The colours offered before the picker, and what to call them.
 *
 * Pastel rather than poster paint: these sit on topic names in the log and the tree, hundreds of
 * rows of them at once, and a wall of fully saturated hues turns a list into a warning sign. So
 * the saturation is held down around a third, which is what makes them read as soft, and the
 * lightness is held where each one still clears 4.5:1 against the white a row is drawn on —
 * softened, not faded. A colour nobody can read is not a colour rule, it is a decoration.
 *
 * Seven hues spread around the wheel and a neutral at the end, so two of them are told apart at
 * the size of a 7px dot rather than only side by side in the popover. Free choice is one click
 * further on — this is the shortlist, not the limit.
 *
 * Named because the name is what a screen reader can use. '#2e6d7a' read out is a spelling test.
 */
export const PALETTE = [
  { name: 'Rose', value: '#b7514e' },
  { name: 'Clay', value: '#996538' },
  { name: 'Sage', value: '#3b7257' },
  { name: 'Teal', value: '#2e6d7a' },
  { name: 'Cornflower', value: '#456eb5' },
  { name: 'Lilac', value: '#8161b3' },
  { name: 'Orchid', value: '#9f5085' },
  { name: 'Storm', value: '#5c6f84' },
] as const;

export const SUGGESTED = PALETTE.map((colour) => colour.value);

/** The first suggestion nothing is using yet, so a new rule arrives with a colour of its own. */
export function nextColour(taken: readonly string[]): string {
  const used = new Set(taken.map((colour) => colour.toLowerCase()));

  return SUGGESTED.find((colour) => !used.has(colour)) ?? SUGGESTED[taken.length % SUGGESTED.length];
}

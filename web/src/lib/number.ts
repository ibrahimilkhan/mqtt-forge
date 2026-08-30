/**
 * A payload that is a number and nothing else.
 *
 * Number() is not the test: it takes '0x10' as sixteen, an empty body as zero and 'Infinity' as
 * a value no chart can place. A topic sending readings sends them written out, so the pattern
 * says so — sign, digits, a decimal point, an exponent, and nothing around them.
 *
 * Shared, because the two places that ask — the chart under the log and the tree's own
 * sparklines — have to agree about what counts as a reading, or the same topic is a measurement
 * in one part of the console and not in the other.
 */
const READING = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

export function asReading(text: string | null | undefined): number | null {
  if (!text) return null;

  const body = text.trim();
  if (!READING.test(body)) return null;

  // The pattern allows an exponent it cannot bound, so '1e400' passes it and Number() answers
  // Infinity — the one value the comment above says this exists to keep out. The chart filters
  // non-finite readings a second time on its JSON-field path (`numberAt` in series.ts) and not on
  // its plain-body path, and the tree's sparklines do not filter at all: an unbounded exponent
  // reached a plot and took the whole scale with it, since every mean and fence computed from an
  // Infinity is a NaN. One gate here closes both ways in.
  const value = Number(body);

  return Number.isFinite(value) ? value : null;
}

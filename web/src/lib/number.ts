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

  return READING.test(body) ? Number(body) : null;
}

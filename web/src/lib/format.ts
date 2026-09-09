/**
 * Numbers as a note writes them.
 *
 * A summary is read at a glance beside the reading it summarises, so it carries as many figures
 * as tell the reader something and no more: past a hundred the decimals are noise beside the
 * number carrying them, and under one they are the number.
 */
export function short(value: number): string {
  const size = Math.abs(value);

  /*
   * Past this a double is written with an exponent and every figure it holds, and being a whole
   * number is no help: `String(1.6666666666666666e307)` is twenty-two characters of mantissa in
   * a gutter cut for four, which is what an axis label read after a JSON body carried 1e308. The
   * exponent is the number here — the mantissa is three figures like everything else below.
   */
  if (size >= 1e21) return trimExponent(value.toExponential(2));

  if (Number.isInteger(value)) return String(value);

  if (size >= 100) return value.toFixed(0);
  if (size >= 1) return trim(value.toFixed(2));

  return trim(value.toPrecision(3));
}

/**
 * The two ends of a scale, written so that they can be told apart.
 *
 * `short` gives three figures, which is the right answer for a label and the wrong one for a run
 * that moves in the fourth: a topic reading 21.500001 to 21.500031 drew a plainly rising line
 * between an axis marked 21.5 at the top and 21.5 at the bottom. The plot said one thing and the
 * numbers beside it said another, and the reader is left to decide which of the two is broken.
 *
 * So the figures are raised until the two strings differ. Twelve is the cap — past that a double
 * is writing its own rounding error rather than the reading — and a pair that still matches there
 * is a run whose two ends really are the same number, which the caller draws as one label.
 */
export function ends(low: number, high: number): [string, string] {
  const short_ = [short(low), short(high)] as [string, string];
  if (short_[0] !== short_[1] || low === high) return short_;

  // Untrimmed, and both at the same figure: trimming one end and not the other gives '21.5' and
  // '21.50003', which is a pair of numbers rather than the two ends of one scale.
  for (let figures = 4; figures <= 12; figures++) {
    const written: [string, string] = [low.toPrecision(figures), high.toPrecision(figures)];
    if (written[0] !== written[1]) return written;
  }

  return short_;
}

/** How long a wait was, in the largest unit that leaves it readable. */
export function duration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${short(ms / 1000)} s`;

  return `${short(ms / 60_000)} min`;
}

const trim = (text: string) => (text.includes('.') ? text.replace(/\.?0+$/, '') : text);

// The same tidying, for a number whose last character is its exponent rather than a digit:
// 1.00e+21 is 1e+21, and trim's end-anchored pattern cannot see past the 21.
const trimExponent = (text: string) => text.replace(/\.?0+e/, 'e');

/**
 * Numbers as a note writes them.
 *
 * A summary is read at a glance beside the reading it summarises, so it carries as many figures
 * as tell the reader something and no more: past a hundred the decimals are noise beside the
 * number carrying them, and under one they are the number.
 */
export function short(value: number): string {
  if (Number.isInteger(value)) return String(value);

  const size = Math.abs(value);
  if (size >= 100) return value.toFixed(0);
  if (size >= 1) return trim(value.toFixed(2));

  return trim(value.toPrecision(3));
}

/** How long a wait was, in the largest unit that leaves it readable. */
export function duration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${short(ms / 1000)} s`;

  return `${short(ms / 60_000)} min`;
}

const trim = (text: string) => (text.includes('.') ? text.replace(/\.?0+$/, '') : text);

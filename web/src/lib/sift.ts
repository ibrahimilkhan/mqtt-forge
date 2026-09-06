/**
 * Finding a word in what the console is holding.
 *
 * Plain case-insensitive substring, in one place, because three panes now offer a search box and
 * a reader who learns what the one in the log does has learnt what the other two do. Deliberately
 * not a regular expression and not a wildcard: `sensors/#` is a topic filter, `+` is a topic
 * filter, and a search box that read either of those as syntax would be answering a different
 * question from the one the reader typed. What a reader wants here is 'the rows with this text
 * in them'.
 */

/** Where a search looks. The reader picks; every pane that searches two things offers all three. */
export type Where = 'topic' | 'body' | 'both';

export const WHERE_OPTIONS: ReadonlyArray<{ value: Where; label: string }> = [
  { value: 'both', label: 'Both' },
  { value: 'topic', label: 'Topic' },
  { value: 'body', label: 'Message' },
];

/** Whether one piece of text carries the words looked for. An empty search matches everything. */
export function carries(text: string | undefined | null, look: string): boolean {
  if (look === '') return true;
  if (!text) return false;

  return text.toLowerCase().includes(look.toLowerCase());
}

/**
 * Whether a topic and a body, together, answer a search aimed where the reader aimed it.
 *
 * The empty search is the case worth stating: it matches, whatever it is pointed at, so a pane
 * with an empty box shows everything rather than nothing.
 */
export function found(
  { topic, body }: { topic?: string | null; body?: string | null },
  look: string,
  where: Where,
): boolean {
  if (look === '') return true;
  if (where === 'topic') return carries(topic, look);
  if (where === 'body') return carries(body, look);

  return carries(topic, look) || carries(body, look);
}

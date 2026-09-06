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

/**
 * Everything the letters of a word have in common, and nothing else.
 *
 * `toLowerCase` is the locale-invariant one, which is the right half of the answer: a Turkish
 * machine must not decide that 'I' and 'i' are different letters for a reader searching English
 * text. The half it does not give is that the two alphabets meet. 'FABRİKA'.toLowerCase() is
 * 'fabri\u0307ka' — an i carrying a dot of its own — and it does not contain the 'fabrika' the
 * reader typed; 'ısparta' does not contain 'isparta' either. To the person looking, all four are
 * the same word, and a search box that finds three of them is broken in the way that is hardest
 * to notice: it answers.
 *
 * So the letters are decomposed, their marks dropped, and the dotless ı said with an i. That is
 * one rule rather than a Turkish special case, and it folds every Latin diacritic the same way —
 * 'sicaklik' finds 'sıcaklık', 'ogretmen' finds 'öğretmen', 'uber' finds 'über'. Which is what a
 * search box does everywhere it is not a filter, and this one is deliberately not a filter.
 *
 * ASCII, which nearly every topic is, takes the short way out: it has no marks to drop and no ı
 * to say differently, so lowercasing it is the whole of the fold. That matters because this runs
 * over every row of a tree that may hold fifty thousand of them, on every keystroke.
 */
const ASCII_ONLY = /^[\x00-\x7f]*$/;

export function fold(text: string): string {
  if (ASCII_ONLY.test(text)) return text.toLowerCase();

  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\u0131/g, 'i');
}

/** Whether one piece of text carries the words looked for. An empty search matches everything. */
export function carries(text: string | undefined | null, look: string): boolean {
  if (look === '') return true;
  if (!text) return false;

  return fold(text).includes(fold(look));
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

/**
 * Splits what was typed into the filter box into topic filters. Newlines and commas both
 * separate, so a list pasted from anywhere works without reformatting it first.
 *
 * Duplicates are dropped: subscribing twice to the same filter is a no-op at the broker but
 * makes the batch bigger and the chip list wrong.
 */
export function parseFilters(text: string): string[] {
  const seen = new Set<string>();

  for (const part of text.split(/[\n,]/)) {
    const filter = part.trim();
    if (filter) seen.add(filter);
  }

  return [...seen];
}

/**
 * Adds one filter to what the box holds, as a line of its own.
 *
 * Adding rather than replacing because the box takes a list and sends it as one batch: a reader
 * picking four topics off the tree means four filters, not four clicks overwriting each other.
 * Read back through parseFilters rather than by matching text, so a filter already in there
 * under a comma is still recognised as already in there.
 */
export function appendFilter(text: string, filter: string): string {
  const wanted = filter.trim();
  if (!wanted || parseFilters(text).includes(wanted)) return text;

  const held = text.trimEnd();

  return held ? `${held}\n${wanted}` : wanted;
}

/**
 * Takes one filter out of what the box holds, wherever it is written.
 *
 * The other half of `appendFilter`, and it exists for the broker panel's two boxes: 'Subscribe #'
 * and 'Subscribe $SYS' are ticked when the list holds their filter and put it there when pressed,
 * so unticking has to be able to take it out again — including out of a line that carried it
 * beside others under a comma.
 *
 * Read through parseFilters rather than by cutting the text, so the answer does not depend on how
 * the reader happened to punctuate their list. What comes back is one filter per line, which is
 * how the box writes a list it has changed.
 */
export function removeFilter(text: string, filter: string): string {
  const unwanted = filter.trim();

  return parseFilters(text)
    .filter((held) => held !== unwanted)
    .join('\n');
}

// Measured against test.mosquitto.org with 600 filters: one packet of 200 costs about the same
// round trip as one of 10, so this is where the win flattens out. Kept in step with the API's
// own per-batch limit — a bigger chunk would simply be refused.
export const MAX_PER_BATCH = 200;

export function chunkFilters<T>(filters: readonly T[], size = MAX_PER_BATCH): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < filters.length; i += size) chunks.push(filters.slice(i, i + size));
  return chunks;
}

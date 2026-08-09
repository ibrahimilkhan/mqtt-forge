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

// Measured against test.mosquitto.org with 600 filters: one packet of 200 costs about the same
// round trip as one of 10, so this is where the win flattens out. Kept in step with the API's
// own per-batch limit — a bigger chunk would simply be refused.
export const MAX_PER_BATCH = 200;

export function chunkFilters<T>(filters: readonly T[], size = MAX_PER_BATCH): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < filters.length; i += size) chunks.push(filters.slice(i, i + size));
  return chunks;
}

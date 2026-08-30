/**
 * The numeric fields of a JSON body, taken one level at a time.
 *
 * `numericFields` answers with whole dotted paths, best covered first, and for the payloads this
 * console was written against — a temperature and a humidity — a row of those is exactly right.
 * It stops being right the moment a device reports its whole configuration in one message: forty
 * chips reading `broker.session.expiryInterval` and `radios.0.errors.crc` are not a row of
 * controls, they are the chart region full of somebody else's field names, with the chart itself
 * pushed off the bottom of it.
 *
 * So the same list is walked rather than shown. One level of segments at a time, a step in, a
 * step back out — the shape the message already has, which is also the shape the reader is
 * holding in their head while they look for one number in it.
 *
 * The ranking survives it: the segments come out in the order their fields did, so the busiest
 * field's branch still leads.
 */

export type Branch = {
  /** The segment itself, which is what the chip says. */
  segment: string;
  /** The whole path, on a segment that is a field. Null on one that has fields under it. */
  field: string | null;
  /** The prefix its fields live below, on a segment that is a group. Null on a field. */
  under: string | null;
  /** How many of the fields are below it — one, for a field. */
  count: number;
};

/**
 * The distinct next segments below a prefix, in the order the fields were ranked.
 *
 * The prefix carries its own trailing dot, so the top level is the empty string and every level
 * below it is a string a field either starts with or does not. That is the whole of the matching:
 * no splitting, no rejoining, and no way for a segment holding a dot to be taken for two.
 */
export function branchesUnder(fields: readonly string[], prefix: string): Branch[] {
  const out: Branch[] = [];
  const seen = new Map<string, Branch>();

  for (const field of fields) {
    if (!field.startsWith(prefix)) continue;

    const rest = field.slice(prefix.length);
    if (rest === '') continue;

    const dot = rest.indexOf('.');
    const segment = dot === -1 ? rest : rest.slice(0, dot);

    const held = seen.get(segment);
    if (held) {
      held.count += 1;
      continue;
    }

    const branch: Branch =
      dot === -1
        ? { segment, field, under: null, count: 1 }
        : { segment, field: null, under: `${prefix}${segment}.`, count: 1 };

    seen.set(segment, branch);
    out.push(branch);
  }

  return out;
}

/** One level out. The top level is the empty prefix, and there is nothing above it. */
export function above(prefix: string): string {
  const named = prefix.slice(0, -1);
  const dot = named.lastIndexOf('.');

  return dot === -1 ? '' : named.slice(0, dot + 1);
}

/** A prefix as it is said out loud — without the trailing dot that makes it a prefix. */
export const named = (prefix: string): string => prefix.slice(0, -1);

/**
 * How many characters of a name a chip will hold.
 *
 * The row is drawn in mono type, so a count of characters *is* a width — 16 of them is about
 * eleven ems, which is a long segment and nowhere near a chart region full of one. The names a
 * message carries are the author's, not ours: `expiryIntervalSeconds`, `lastWillRetainFlag`, and
 * one of those in a chip is a chip as wide as the plot under it.
 */
export const MOST_CHARS = 16;

/**
 * As much of a name as fits, and two dots for the rest.
 *
 * Two dots rather than an ellipsis: the row is mono, and a `…` in a mono face is one cell doing
 * the work of three, which at micro size is a smudge. `..` is two cells that read as two dots.
 * Nothing here changes what the chip *is* — the whole name stays in its accessible name and in
 * its title, so both a screen reader and a pointer still get all of it.
 */
export function clip(name: string, most: number = MOST_CHARS): string {
  return name.length <= most ? name : `${name.slice(0, most - 2)}..`;
}

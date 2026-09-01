import { matchesFilter } from '../../lib/topicMatch';
import type { TopicNode } from '../../lib/topicTree';

/**
 * A sample document, and the paths a rule could be pointed at inside it.
 *
 * The `Field` box asks for something nobody can guess: a path into a JSON body, in a syntax with
 * two accepted spellings and a depth limit. Typed from memory it is wrong about a third of the
 * time, and a path that is wrong does not fail — it means 'the topic did not say', which the
 * engine treats as a skip. So the rule saves, the rule never fires, and the only trace is a
 * counter in the panel's Engine section.
 *
 * The way out of that is not a better error message; it is not making the reader type it. Show
 * them a body and let them press the value they mean.
 *
 * The walking here answers exactly what `PayloadValue.TryWalk` on the server answers, and the
 * comments there say why each rule is the way it is. What matters on this side is the converse:
 * a path this file offers must be a path that server can follow. Where it cannot — a key with a
 * dot in its name, a document deeper than six — nothing is offered at all, because a field the
 * console handed over that then reads nothing is worse than a field it never offered.
 */

/** What JSON.parse hands back. The same shape the message window's tree is drawn from. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/**
 * How deep a path may go — `PayloadValue.MaxDepth`, and the chart's own MAX_DEPTH before that.
 *
 * Counted in steps, not in nesting: `$.a.b.c` is three. A seventh step is refused by the server,
 * so a seventh step is not drawn here.
 */
export const MAX_DEPTH = 6;

/** Which conditions a value suits, said in a word the picker can print beside it. */
export type FieldKind = 'number' | 'text' | 'flag' | 'null';

export type PayloadField = {
  /** Written the way the spec writes it: `$.radios[0].crc`. What goes into the Field box. */
  path: string;
  kind: FieldKind;
  /** The value as it stands, shortened to something that fits on a row. */
  preview: string;
  /** How many steps down it is, so the list can be indented rather than read as flat. */
  depth: number;
};

/** As many rows as the picker will draw. A telemetry frame is twenty fields; this is not one. */
export const MOST_FIELDS = 400;

/** The body parsed, or null when it is not a document at all. Mirrors the server's own gate. */
export function parseBody(payload: string): Json | null {
  const body = payload.trim();
  // Not an optimisation: a bare `23.5` is a reading, not a document, and a rule about it wants no
  // field at all. Saying 'this message has no fields' is the right answer for it.
  if (!body.startsWith('{') && !body.startsWith('[')) return null;

  try {
    return JSON.parse(body) as Json;
  } catch {
    return null;
  }
}

/**
 * A key the server's walker could never find again.
 *
 * The path syntax splits on `.` and `[`, so a key carrying either of those is a key no path can
 * name — and `]` would close a bracket that was never opened. An empty key is refused outright:
 * `a..b` is a typo there, not a lookup of a field named ''.
 *
 * These are rare and they are real (a device publishing `{"cpu.temp": 61}` is a device somebody
 * owns), so the picker counts them and says so rather than quietly showing a shorter list.
 */
export const reachableKey = (key: string) => key !== '' && !/[.[\]]/.test(key);

/**
 * Every value in the document a rule could be pointed at, in the order they are written.
 *
 * Leaves only. A path that stops on an object hands the server that subtree's raw JSON, which is
 * a real thing to write a pattern against — but it is also nine tenths of the rows in a nested
 * document, and a list where every second entry is `{…}` is a list nobody finds the reading in.
 * Someone who wants the subtree can still type its path; this is the part that is hard to type.
 */
export function fieldsIn(body: Json): { fields: PayloadField[]; skipped: number } {
  const fields: PayloadField[] = [];
  let skipped = 0;

  walk(body, '$', 0);

  return { fields, skipped };

  function walk(node: Json, path: string, depth: number) {
    if (fields.length >= MOST_FIELDS) return;

    if (node === null || typeof node !== 'object') {
      // The root itself is never offered: an empty Field box already means 'the whole body', and
      // a path of `$` would be a second way to say it that reads like a third thing.
      if (depth > 0) fields.push({ path, kind: kindOf(node), preview: previewOf(node), depth });
      return;
    }

    // A step past the ceiling is a step the server refuses, so the branch simply ends here.
    if (depth >= MAX_DEPTH) return;

    if (Array.isArray(node)) {
      node.forEach((child, index) => walk(child, `${path}[${index}]`, depth + 1));
      return;
    }

    for (const [key, child] of Object.entries(node)) {
      if (!reachableKey(key)) {
        // Counted once for the key, not once per leaf under it: what the reader is being told is
        // 'there is a name in here no path can reach', and the size of what hangs off it is not
        // the point being made.
        skipped++;
        continue;
      }

      walk(child, `${path}.${key}`, depth + 1);
    }
  }
}

const kindOf = (value: Json): FieldKind =>
  value === null
    ? 'null'
    : typeof value === 'number'
      ? 'number'
      : typeof value === 'boolean'
        ? 'flag'
        : 'text';

/** As much of a value as fits beside its path. */
export function previewOf(value: Json): string {
  // A string shows its own characters rather than its JSON: the engine compares the unquoted
  // value, so quotation marks here would be two characters the reader's pattern must not include.
  const text = typeof value === 'string' ? value : JSON.stringify(value);

  return text.length > 48 ? `${text.slice(0, 47)}…` : text;
}

export type PayloadSample = { topic: string; payload: string };

/**
 * The newest bodies the broker has sent on topics this rule covers.
 *
 * The reader has almost always already seen the message they are writing a rule about — it is on
 * the tree two panels away. Asking them to paste it in would be asking them to fetch something
 * the console is already holding.
 *
 * Only bodies that parse as documents, because only those have fields; a topic sending bare
 * readings correctly offers nothing. Newest first, so a filter covering fifty topics leads with
 * the one that just spoke.
 */
export function samplesFor(root: TopicNode, filter: string, limit = 12): PayloadSample[] {
  const found: Array<PayloadSample & { at: number }> = [];
  const stack: Array<{ node: TopicNode; path: string; isRoot: boolean }> = [
    { node: root, path: '', isRoot: true },
  ];

  while (stack.length > 0) {
    const { node, path, isRoot } = stack.pop()!;

    if (
      !isRoot &&
      node.latestPayload !== null &&
      matchesFilter(filter, path) &&
      parseBody(node.latestPayload) !== null
    ) {
      found.push({ topic: path, payload: node.latestPayload, at: node.lastHitAt });
    }

    for (const [name, child] of node.children) {
      stack.push({ node: child, path: isRoot ? name : `${path}/${name}`, isRoot: false });
    }
  }

  return found
    .sort((one, other) => other.at - one.at || one.topic.localeCompare(other.topic))
    .slice(0, limit)
    .map(({ topic, payload }) => ({ topic, payload }));
}

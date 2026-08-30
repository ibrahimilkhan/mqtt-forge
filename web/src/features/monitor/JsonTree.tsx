import styles from './JsonTree.module.css';

/**
 * A JSON body drawn as the document it is, with every branch of it foldable.
 *
 * Not a tree in the sense of a widget with its own notation — it is the pretty print the window
 * showed before, line for line, with a chevron in front of the lines that open something. Braces,
 * quotes and commas stay where JSON.stringify put them. That is deliberate: this console shows
 * what arrived rather than a rendering of what arrived, and a reader who folds a branch away
 * should be able to unfold it and find exactly the text they would have copied.
 *
 * A folded branch says how many things are inside it, because 'radios' with nothing after it is
 * a question rather than an answer.
 */

/** What JSON.parse hands back, which is the only thing this ever draws. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const isBranch = (value: Json): value is Json[] | { [key: string]: Json } =>
  typeof value === 'object' && value !== null;

/**
 * Where a node sits, written so that no two of them can ever collide.
 *
 * A key is any string at all, so a path joined by a separator is a path with a collision waiting
 * in it: {"a b": {"c": 1}} and {"a": {"b c": 1}} come to the same thing under a space, and folding
 * one of them would fold the other. The key's own length in front of it settles that for good.
 */
const under = (path: string, key: string) => `${path}/${key.length}:${key}`;

/**
 * As many rows as this will draw before it refuses to.
 *
 * There is no cap on what a broker may publish, and a document of a hundred thousand nodes is a
 * hundred thousand elements laid out in one commit the moment somebody double-clicks the row it
 * arrived on. The number is far past anything a person reads and well short of anything that
 * locks the window: above it the window falls back to the pretty print, which is what it drew
 * before this existed, and the fold controls are simply not there to be pressed.
 */
export const MOST_ROWS = 20_000;

/** How many rows this would draw fully open. Counted before anything is built. */
export function rowCount(value: Json): number {
  if (!isBranch(value)) return 1;

  const children = Array.isArray(value) ? value : Object.values(value);
  // A branch with something in it costs an opening line and a closing one; an empty one is
  // written `{}` on a single line and costs one.
  return children.reduce<number>((total, child) => total + rowCount(child), children.length ? 2 : 1);
}

/**
 * Every branch in the document, by path.
 *
 * What 'collapse all' needs, and it cannot be got from the rows: the rows only describe the
 * document as it is currently folded, and a branch inside a folded one has no row at all.
 */
export function branches(value: Json, at = '', found: string[] = []): string[] {
  if (!isBranch(value)) return found;

  const children: Array<[string, Json]> = Array.isArray(value)
    ? value.map((child, index) => [String(index), child])
    : Object.entries(value);
  if (children.length === 0) return found;

  found.push(at);
  for (const [key, child] of children) branches(child, under(at, key), found);

  return found;
}

type Row = {
  /** Unique within the document, and the handle a fold is remembered by. */
  path: string;
  depth: number;
  /** Present on a row that opens or stands for a branch — the rest have an empty gutter. */
  branch?: { open: boolean; name: string };
  text: string;
};

/**
 * The document flattened into the lines it is drawn as, honouring what is folded.
 *
 * Flat rather than nested components because the fold state lives above all of it: a nested tree
 * would hand the same Set down every level and re-render the whole of it on any fold anyway, and
 * this way the commas and the closing braces — which are about a node's place among its siblings
 * rather than about the node — are worked out in one pass by the thing that knows.
 */
export function rowsOf(value: Json, shut: ReadonlySet<string>): Row[] {
  const out: Row[] = [];

  walk(value, '', 'the message', '', 0, true);

  return out;

  function walk(node: Json, label: string, name: string, path: string, depth: number, last: boolean) {
    const tail = last ? '' : ',';

    if (!isBranch(node)) {
      out.push({ path, depth, text: `${label}${JSON.stringify(node)}${tail}` });
      return;
    }

    const array = Array.isArray(node);
    const [open, close] = array ? ['[', ']'] : ['{', '}'];
    const children: Array<[string, Json]> = array
      ? node.map((child, index) => [String(index), child])
      : Object.entries(node);

    if (children.length === 0) {
      out.push({ path, depth, text: `${label}${open}${close}${tail}` });
      return;
    }

    if (shut.has(path)) {
      out.push({
        path,
        depth,
        branch: { open: false, name },
        text: `${label}${open} … ${children.length} ${close}${tail}`,
      });
      return;
    }

    out.push({ path, depth, branch: { open: true, name }, text: `${label}${open}` });

    children.forEach(([key, child], index) =>
      walk(
        child,
        array ? '' : `${JSON.stringify(key)}: `,
        array ? `item ${index + 1}` : key,
        under(path, key),
        depth + 1,
        index === children.length - 1,
      ),
    );

    // Its own row, and its own key: the closing brace belongs to the branch rather than to the
    // last thing inside it, and React needs the two to be told apart.
    out.push({ path: `${path}}`, depth, text: `${close}${tail}` });
  }
}

export function JsonTree({
  value,
  shut,
  onFold,
}: {
  value: Json;
  /** The branches that are folded away, by path. Empty is the whole document open. */
  shut: ReadonlySet<string>;
  onFold: (path: string) => void;
}) {
  return (
    <div className={styles.tree}>
      {rowsOf(value, shut).map((row) => (
        <div key={row.path} className={styles.row} style={{ paddingLeft: `${row.depth * 1.2}em` }}>
          {row.branch ? (
            <button
              type="button"
              className={styles.fold}
              aria-expanded={row.branch.open}
              // Named for what it will do rather than for what it stands beside: a control called
              // 'radios' tells a listener nothing about which way it is about to go. The same
              // wording the region strips in the workspace use, for the same reason.
              aria-label={`${row.branch.open ? 'Fold' : 'Open'} ${row.branch.name}`}
              onClick={() => onFold(row.path)}
            />
          ) : (
            <span className={styles.gutter} aria-hidden="true" />
          )}
          <span className={styles.text}>{row.text}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * The names and values a message carries, written a line at a time.
 *
 * A pair of boxes per property, with a button to add another, is the shape a form usually takes
 * here — and it is four controls to send one pair, in a pane that already holds a topic, a
 * payload, a QoS and a retain flag. A line each is what the subscription list already does with
 * filters, and it is the shape people paste from: `source: console` is how these are written in
 * every broker's own log.
 *
 * The separator is the first colon on the line, so a value may hold as many more as it likes —
 * a URL, a timestamp, an id with a scheme in front of it.
 */
export type UserProperty = { name: string; value: string };

export function parseUserProperties(text: string): UserProperty[] {
  const found: UserProperty[] = [];

  for (const line of text.split('\n')) {
    const said = line.trim();
    if (said === '') continue;

    const at = said.indexOf(':');
    // A line with no colon is a name with an empty value, which is legal and occasionally what
    // somebody means. It is not an error to be refused in a box they are still typing into.
    const name = (at < 0 ? said : said.slice(0, at)).trim();
    const value = at < 0 ? '' : said.slice(at + 1).trim();
    if (name === '') continue;

    found.push({ name, value });
  }

  return found;
}

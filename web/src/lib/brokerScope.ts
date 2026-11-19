import type { BrokerLink, MqttTransport, SavedProfile } from '../types/api';

/**
 * Which broker a colour rule belongs to, worked out from the link rather than only from how it
 * was dialled.
 *
 * A rule used to belong to a saved broker or to none, and the link said which saved broker it was
 * made from — so a broker reached from the history, or typed in, had no rules of its own and no
 * way to be given any. And the same broker dialled from its saved entry and from the history were
 * two different brokers to the rules, though every topic on them was the same.
 *
 * So a broker is also known by its address. A rule for an unsaved broker holds the address itself
 * — `mqtts://broker.example:8883` — where a saved one's holds the id; and a link answers to both:
 * its own id if it was dialled from a saved entry, the id of every saved entry at the same
 * address, and the address.
 */
export type BrokerScope = {
  /** What a new rule written for this broker is given: the saved id if there is one, else the address. */
  own: string;
  /** Every owner a rule may name and still be this broker's. */
  keys: readonly string[];
  /** What the reader calls it: the saved name, or the address. */
  name: string;
};

type Endpoint = { host: string; port: number; useTls: boolean; transport: MqttTransport };

/**
 * The address a broker is known by when it was never saved.
 *
 * Written out in full, scheme and all, because it is shown to the reader as the broker's name
 * wherever a rule names one. The host is lower-cased since DNS is not case-sensitive and the same
 * broker typed twice must not be two brokers; an IPv6 literal goes inside brackets so the port
 * can still be read off the end.
 */
export function addressKey({ host, port, useTls, transport }: Endpoint): string {
  const scheme = transport === 'webSocket' ? (useTls ? 'wss' : 'ws') : useTls ? 'mqtts' : 'mqtt';
  const name = host.trim().toLowerCase();
  const bracketed = name.includes(':') && !name.startsWith('[') ? `[${name}]` : name;

  return `${scheme}://${bracketed}:${port}`;
}

/** Whether a rule's owner is an address rather than a saved broker's id — which never holds `://`. */
export const isAddressKey = (owner: string) => owner.includes('://');

export function scopeOf(link: BrokerLink, profiles: readonly SavedProfile[] | undefined): BrokerScope {
  const address = addressKey(link);
  // Every saved entry for this address: two names for one broker are still one broker's rules.
  const same = (profiles ?? []).filter((profile) => addressKey(profile.connection) === address);
  const named = profiles?.find((profile) => profile.id === link.profileId) ?? same[0];
  const own = link.profileId ?? named?.id ?? address;

  return {
    own,
    keys: [...new Set([own, ...same.map((profile) => profile.id), address])],
    name: named?.name ?? address,
  };
}

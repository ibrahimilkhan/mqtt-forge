import { beforeEach, describe, expect, it } from 'vitest';
import { byteLength } from '../lib/payload';
import { matchesFilter } from '../lib/topicMatch';
import type { DecodedMessage } from '../realtime/decodeIncoming';
import { runFor, TOPIC_DEPTH, useLogStore, type LogEntry } from './logStore';

const message = (topic: string, payload: string): DecodedMessage => ({
  topic,
  payload,
  mode: 'text',
  size: byteLength(payload),
  qos: 0,
  retain: false,
  receivedAt: '2026-07-26T10:00:00Z',
});

/**
 * What the pane used to do: walk everything held and keep the arrivals that match.
 *
 * Everything held is itself read through the index, under a bare '#', which is not circular —
 * that path gathers every run and merges them, and the paths under test gather one run or a
 * few. The property is that narrowing the filter narrows the answer and changes nothing else.
 */
const held = (): LogEntry[] => runFor(useLogStore.getState().byTopic, '#');
const byScanning = (entries: LogEntry[], filter: string): LogEntry[] =>
  entries.filter((e) => e.kind === 'recv' && !!e.topic && matchesFilter(filter, e.topic));

beforeEach(() => useLogStore.getState().clear());

/**
 * The index answers the question the flat scan used to, and has to answer it identically —
 * same entries, same order, same objects. These are the tests that let the scan go.
 */
describe('the topic index answers exactly what a scan would', () => {
  const TOPICS = [
    'sensors/hall/temp',
    'sensors/hall/humidity',
    'sensors/attic/temp',
    'plant/line1/cell2/sensor7/temp',
    'plant/line1/cell3/sensor8/temp',
    '/hfp/v2/journey/tram/0040',
    '/hfp/v2/journey/bus/0018',
    'a',
    'a/b',
    'a/b/c',
    // Names that only begin with another topic's letters. '.' and '-' sort before '/', so these
    // land between a branch and its children in any order over the topics.
    'plant.spare',
    'plant-standby/line1/temp',
    'plants',
    'plantation/line1/temp',
    'sensors',
    'sensorsx/temp',
  ];

  const FILTERS = [
    '#',
    'sensors/#',
    'sensors/hall/temp',
    'sensors/hall/temp/#',
    'sensors/+/temp',
    'sensors/+/temp/#',
    '+/+/+',
    'plant/line1/#',
    'plant/+/cell2/+/temp',
    '/hfp/#',
    '/hfp/v2/journey/+/0040',
    'a/#',
    'a/b/#',
    'nothing/here/#',
    'a/b/c/d',
    // A leaf's own filter, which is what clicking a row in the tree asks for.
    'plant/line1/cell2/sensor7/temp/#',
    'plant/#',
    'plants/#',
    'sensors',
    '/hfp/v2/journey/tram/0040/#',
  ];

  const flood = () => {
    for (let round = 0; round < 6; round++) {
      useLogStore
        .getState()
        .appendReceived(TOPICS.map((topic) => message(topic, `${topic}#${round}`)));
    }
    // Command entries share the log and must never appear as traffic.
    useLogStore.getState().push({ kind: 'ok', verb: 'Subscribed', topic: 'sensors/#' });
    useLogStore.getState().push({ kind: 'fault', verb: 'Subscribe failed', topic: 'plant/#' });
  };

  it.each(FILTERS)('matches the scan for %s', (filter) => {
    flood();

    expect(runFor(useLogStore.getState().byTopic, filter)).toEqual(byScanning(held(), filter));
  });

  it('hands back the very same objects, not copies', () => {
    flood();
    const scanned = byScanning(held(), 'sensors/#');
    const indexed = runFor(useLogStore.getState().byTopic, 'sensors/#');

    indexed.forEach((entry, i) => expect(entry).toBe(scanned[i]));
  });

  it('is newest first, across topics as well as within one', () => {
    flood();
    const ids = runFor(useLogStore.getState().byTopic, '#').map((e) => e.id);

    expect(ids).toEqual([...ids].sort((a, b) => b - a));
  });

  it('finds nothing for a filter no topic matches', () => {
    flood();

    expect(runFor(useLogStore.getState().byTopic, 'nobody/#')).toEqual([]);
  });

  it('finds nothing in an empty log', () => {
    expect(runFor(useLogStore.getState().byTopic, '#')).toEqual([]);
  });

  // The index is a second view of one log, so anything that empties or prunes the log has to
  // empty or prune it too — a stale index would serve entries the pane can no longer see.
  it('is emptied with the log', () => {
    flood();
    useLogStore.getState().clear();

    expect(runFor(useLogStore.getState().byTopic, '#')).toEqual([]);
  });

  // Runs that have been cut back to their depth are the ordinary state of a console that has
  // been left running, and the answer has to stay the same shape once they have been.
  it('still matches the scan after the runs have been cut back to their depth', () => {
    // Three topics, twice the depth each, so every run really is cut back.
    const crowd = Array.from({ length: TOPIC_DEPTH * 6 }, (_, i) => message(`crowd/${i % 3}`, String(i)));
    useLogStore.getState().appendReceived(crowd);

    expect(runFor(useLogStore.getState().byTopic, 'crowd/1')).toEqual(byScanning(held(), 'crowd/1'));
    expect(runFor(useLogStore.getState().byTopic, 'crowd/+')).toEqual(byScanning(held(), 'crowd/+'));
    expect(runFor(useLogStore.getState().byTopic, 'crowd/1').length).toBe(TOPIC_DEPTH);
  });
});

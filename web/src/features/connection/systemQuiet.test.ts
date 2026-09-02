import { QueryClient } from '@tanstack/react-query';
import { beforeEach, describe, expect, it } from 'vitest';
import { queryKeys } from '../../api/queryKeys';
import { useLogStore } from '../../stores/logStore';
import { useTopicTreeStore } from '../../stores/topicTreeStore';
import { watchForSystem } from './useConnectionActions';

/**
 * The line the log gets when $SYS was granted and nothing came of it.
 *
 * Measured, not assumed: HiveMQ CE grants '$SYS/#' and has no tree to publish under it, EMQX
 * refuses it outright, Mosquitto publishes fifty-odd topics within a second. Only the first of the
 * three is silent, and this is the one line that says so.
 */
describe('a $SYS subscription that produces nothing', () => {
  const AFTER = 30;
  let client: QueryClient;

  const noted = () =>
    useLogStore.getState().commands.filter((entry) => entry.verb === 'No $SYS statistics');

  const settled = () => new Promise((resolve) => setTimeout(resolve, AFTER * 3));

  const message = (topic: string) => ({
    topic,
    payload: '1',
    mode: 'text' as const,
    size: 1,
    qos: 0,
    retain: false,
    receivedAt: '2026-09-03T00:00:00.000Z',
  });

  beforeEach(() => {
    client = new QueryClient();
    client.setQueryData(queryKeys.connection, { state: 'Connected', failure: null });
    useLogStore.getState().clear();
    useTopicTreeStore.getState().reset();
  });

  it('is said in the log, naming the filter and the wait', async () => {
    watchForSystem(client, AFTER);
    await settled();

    expect(noted()).toHaveLength(1);
    expect(noted()[0]).toMatchObject({ kind: 'fault', topic: '$SYS/#' });
    expect(noted()[0].body).toMatch(/does not publish/);
  });

  it('is not said when something under $SYS arrived', async () => {
    watchForSystem(client, AFTER);
    useTopicTreeStore.getState().apply([message('$SYS/broker/uptime')]);
    await settled();

    expect(noted()).toHaveLength(0);
  });

  // A topic arriving is not the same as a $SYS topic arriving: a busy broker with no $SYS tree is
  // still a broker with no $SYS tree.
  it('is said even when other topics are arriving', async () => {
    watchForSystem(client, AFTER);
    useTopicTreeStore.getState().apply([message('plant/boiler/temp')]);
    await settled();

    expect(noted()).toHaveLength(1);
  });

  it('is not said about a link that is no longer up', async () => {
    watchForSystem(client, AFTER);
    client.setQueryData(queryKeys.connection, { state: 'Disconnected', failure: null });
    await settled();

    expect(noted()).toHaveLength(0);
  });

  // A new connection starts the tree again, and a note about the one before it would land in a
  // log that has just been cleared for the one after.
  it('is not said about a connection that has since been replaced', async () => {
    watchForSystem(client, AFTER);
    useTopicTreeStore.getState().reset();
    await settled();

    expect(noted()).toHaveLength(0);
  });
});

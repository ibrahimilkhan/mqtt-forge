import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_EVENTS, useBrokerEventsStore } from './brokerEventsStore';
import { useLogStore } from './logStore';

describe('the broker events', () => {
  beforeEach(() => {
    useBrokerEventsStore.getState().clear();
    useLogStore.getState().clear();
  });

  it('are kept newest first', () => {
    useBrokerEventsStore.getState().push({ kind: 'ok', what: 'first' });
    useBrokerEventsStore.getState().push({ kind: 'fault', what: 'second' });

    expect(useBrokerEventsStore.getState().events.map((event) => event.what)).toEqual([
      'second',
      'first',
    ]);
  });

  it('stop at the cap, dropping the oldest', () => {
    for (let i = 0; i < MAX_EVENTS + 5; i++) {
      useBrokerEventsStore.getState().push({ kind: 'ok', what: `event ${i}` });
    }

    const { events } = useBrokerEventsStore.getState();
    expect(events).toHaveLength(MAX_EVENTS);
    expect(events[0].what).toBe(`event ${MAX_EVENTS + 4}`);
    expect(events[events.length - 1].what).toBe('event 5');
  });

  // The log's command lines are cleared with every connection; the events are where they last.
  it('mirror every command the log records, with its filter and its sentence', () => {
    useLogStore.getState().push({
      kind: 'fault',
      verb: 'Subscribe failed',
      topic: '$SYS/#',
      body: 'Refused.',
    });
    useLogStore.getState().push({
      kind: 'ok',
      verb: 'Connected',
      body: 'mqtt://broker.local:1883',
    });

    expect(useBrokerEventsStore.getState().events).toMatchObject([
      { kind: 'ok', what: 'Connected', detail: 'mqtt://broker.local:1883' },
      { kind: 'fault', what: 'Subscribe failed · $SYS/#', detail: 'Refused.' },
    ]);
  });

  // The ladder's tries: one line that counts up, so the drop they are about stays on screen.
  it('a keyed line replaces the one it supersedes while that one is newest', () => {
    useBrokerEventsStore.getState().push({ kind: 'fault', what: 'Link dropped' });
    useBrokerEventsStore.getState().push({ kind: 'fault', key: 'tries', what: 'Try 1 failed' });
    useBrokerEventsStore.getState().push({ kind: 'fault', key: 'tries', what: '2 tries failed' });
    useBrokerEventsStore.getState().push({ kind: 'fault', key: 'tries', what: '3 tries failed' });

    expect(useBrokerEventsStore.getState().events.map((e) => e.what)).toEqual([
      '3 tries failed',
      'Link dropped',
    ]);
  });

  // ...and once anything else has happened, the old line is part of the story and stays.
  it('a keyed line that is no longer newest is left where it is', () => {
    useBrokerEventsStore.getState().push({ kind: 'fault', key: 'tries', what: '4 tries failed' });
    useBrokerEventsStore.getState().push({ kind: 'ok', what: 'Link back' });
    useBrokerEventsStore.getState().push({ kind: 'fault', key: 'tries', what: 'Try 1 failed' });

    expect(useBrokerEventsStore.getState().events.map((e) => e.what)).toEqual([
      'Try 1 failed',
      'Link back',
      '4 tries failed',
    ]);
  });

  it('are not written by traffic', () => {
    useLogStore.getState().push({ kind: 'recv', topic: 'plant/boiler/temp', body: '91' });

    expect(useBrokerEventsStore.getState().events).toHaveLength(0);
  });

  it('survive the log starting again', () => {
    useLogStore.getState().push({ kind: 'ok', verb: 'Connected' });
    useLogStore.getState().clear();

    expect(useLogStore.getState().commands).toHaveLength(0);
    expect(useBrokerEventsStore.getState().events).toHaveLength(1);
  });
});

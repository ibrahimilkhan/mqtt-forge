import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import { server } from '../test/server';
import type { AlertDto, AlertsDto } from '../types/api';
import { emptyAlerts, mutedUntil, useAlertStore } from './alertStore';

const alert = (id: string, over: Partial<AlertDto> = {}): AlertDto => ({
  id,
  ruleId: '6f1d',
  ruleName: 'Boiler temperature',
  topic: 'plant/1/temp',
  severity: 'critical',
  firedAt: '2026-09-01T10:00:00Z',
  lastSeenAt: '2026-09-01T10:00:00Z',
  resolvedAt: null,
  resolvedBy: null,
  mutedUntil: null,
  count: 1,
  reason: '94.2 > 90',
  value: 94.2,
  sample: '{"temp":94.2}',
  actions: ['screen'],
  ...over,
});

const snapshot = (over: Partial<AlertsDto> = {}): AlertsDto => ({
  active: [],
  history: [],
  muted: [],
  rules: [],
  warming: [],
  capped: [],
  dropped: 0,
  webhooksDropped: 0,
  suppressed: 0,
  blindSeconds: 0,
  ...over,
});

/** What GET /api/alerts will answer with next, once. */
const serves = (answer: AlertsDto) =>
  server.use(http.get('/api/alerts', () => HttpResponse.json(answer)));

const state = () => useAlertStore.getState();
const activeIds = () => state().active.map((held) => held.id);

beforeEach(() => useAlertStore.setState(emptyAlerts()));

describe('what the store makes of a hub event', () => {
  it('puts a raised alarm on the active list', () => {
    state().raised([alert('a1'), alert('a2')]);

    expect(activeIds()).toEqual(['a1', 'a2']);
  });

  // The engine re-announces every standing alarm after its own restart, and the queue replays
  // what a snapshot may already have held. Two rows for one alarm would be two rows to mute.
  it('keeps one row for an alarm announced twice, carrying the newer count', () => {
    state().raised([alert('a1', { count: 1 })]);
    state().raised([alert('a1', { count: 9 })]);

    expect(activeIds()).toEqual(['a1']);
    expect(state().active[0].count).toBe(9);
  });

  it('takes a resolved alarm off the active list and puts it at the head of the history', () => {
    state().raised([alert('a1'), alert('a2')]);

    state().resolved([alert('a1', { resolvedAt: '2026-09-01T10:05:00Z', resolvedBy: 'clear' })]);

    expect(activeIds()).toEqual(['a2']);
    // The resolved copy, because it is the one that says why it stopped.
    expect(state().history[0]).toMatchObject({ id: 'a1', resolvedBy: 'clear' });
  });

  it('moves the dropped total forward and never back', () => {
    state().droppedTotal(7);
    state().droppedTotal(3);

    expect(state().dropped).toBe(7);
  });
});

describe('what a snapshot does', () => {
  it('replaces the lists rather than merging into them', async () => {
    state().raised([alert('a1')]);
    serves(snapshot({ active: [alert('b1')], dropped: 2, blindSeconds: 30 }));

    await state().load();

    expect(activeIds()).toEqual(['b1']);
    expect(state()).toMatchObject({ dropped: 2, blindSeconds: 30, syncing: false });
  });

  // The phantom alarm. An alertsResolved sent while the hub was down never arrives, so the row
  // stands with nothing left to take it away — until a list that does not contain it does.
  it('drops an alarm the engine no longer holds, which is how a missed resolve is put right', async () => {
    state().raised([alert('a1'), alert('a2')]);
    serves(snapshot({ active: [alert('a1')] }));

    await state().load();

    expect(activeIds()).toEqual(['a1']);
  });

  it('puts the dropped total where the server says, even downwards', async () => {
    state().droppedTotal(7);
    serves(snapshot({ dropped: 0 }));

    await state().load();

    expect(state().dropped).toBe(0);
  });

  it('brings the numbers the panel explains a silent engine with', async () => {
    serves(
      snapshot({
        warming: [{ ruleId: '6f1d', topic: 'plant/1/temp', have: 7, need: 20, note: 'warming up, 7/20' }],
        capped: [{ ruleId: '6f1d', untracked: 40 }],
        rules: [
          {
            ruleId: '6f1d',
            topics: 3,
            evaluated: 900,
            skipped: 12,
            lastFiredAt: null,
            faulted: true,
            faultReason: 'bad regex',
          },
        ],
        suppressed: 5,
        webhooksDropped: 2,
      }),
    );

    await state().load();

    expect(state().warming[0].note).toBe('warming up, 7/20');
    expect(state().capped[0]).toEqual({ ruleId: '6f1d', untracked: 40 });
    expect(state().rules[0]).toMatchObject({ faulted: true, faultReason: 'bad regex' });
    expect(state()).toMatchObject({ suppressed: 5, webhooksDropped: 2 });
  });

  it('holds an event that arrives while the snapshot is in flight, and applies it after', async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.get('/api/alerts', async () => {
        await held;
        return HttpResponse.json(snapshot({ active: [alert('a1')] }));
      }),
    );

    const loading = state().load();
    expect(state().syncing).toBe(true);

    // The alarm cleared while the snapshot that still holds it was in flight. Applied now, the
    // snapshot would put it straight back and it would never leave.
    state().resolved([alert('a1', { resolvedBy: 'clear' })]);
    expect(state().pending).toHaveLength(1);

    release();
    await loading;

    expect(activeIds()).toEqual([]);
    expect(state().history.map((held) => held.id)).toEqual(['a1']);
    expect(state().pending).toHaveLength(0);
  });

  // The events happened whatever the GET did, so a failed snapshot must not swallow them too.
  it('still applies what was waiting when the snapshot itself fails', async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.get('/api/alerts', async () => {
        await held;
        return new HttpResponse(null, { status: 503 });
      }),
    );

    const loading = state().load();
    state().raised([alert('a1')]);

    release();
    await loading;

    expect(activeIds()).toEqual(['a1']);
    expect(state().syncing).toBe(false);
  });

  it('lets the newer of two snapshots win, and hands it the queue', async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let call = 0;
    server.use(
      http.get('/api/alerts', async () => {
        call += 1;
        if (call === 1) {
          await held;
          return HttpResponse.json(snapshot({ active: [alert('old')] }));
        }
        return HttpResponse.json(snapshot({ active: [alert('new')] }));
      }),
    );

    const first = state().load();
    const second = state().load();

    state().raised([alert('queued')]);

    release();
    await Promise.all([first, second]);

    // The stale answer wrote nothing, and the event it was holding landed on the newer one.
    expect(activeIds()).toEqual(['new', 'queued']);
  });
});

describe('a mute', () => {
  it('is keyed on the pair, so it outlives the alarm it was set on', () => {
    state().raised([alert('a1')]);
    state().mute('6f1d', 'plant/1/temp', '2026-09-01T10:30:00Z');

    state().resolved([alert('a1')]);
    state().raised([alert('a2')]);

    expect(state().muted).toEqual([
      { ruleId: '6f1d', topic: 'plant/1/temp', until: '2026-09-01T10:30:00Z' },
    ]);
    expect(mutedUntil(state(), '6f1d', 'plant/1/temp', Date.parse('2026-09-01T10:15:00Z'))).toBe(
      '2026-09-01T10:30:00Z',
    );
  });

  it('is replaced rather than doubled when the same pair is muted again', () => {
    state().mute('6f1d', 'plant/1/temp', '2026-09-01T10:30:00Z');
    state().mute('6f1d', 'plant/1/temp', '2026-09-01T11:00:00Z');

    expect(state().muted).toHaveLength(1);
    expect(state().muted[0].until).toBe('2026-09-01T11:00:00Z');
  });

  it('is lifted by a null, which is what zero minutes means', () => {
    state().mute('6f1d', 'plant/1/temp', '2026-09-01T10:30:00Z');
    state().mute('6f1d', 'plant/1/temp', null);

    expect(state().muted).toEqual([]);
    expect(mutedUntil(state(), '6f1d', 'plant/1/temp')).toBeUndefined();
  });

  // A page left open overnight would otherwise go on saying a pair is silent hours after it began
  // speaking again, because the snapshot that would have dropped the pair is not due yet.
  it('has run out once its moment has passed', () => {
    state().mute('6f1d', 'plant/1/temp', '2026-09-01T10:30:00Z');

    expect(
      mutedUntil(state(), '6f1d', 'plant/1/temp', Date.parse('2026-09-01T10:31:00Z')),
    ).toBeUndefined();
  });

  it('says nothing about a pair nobody silenced', () => {
    expect(mutedUntil(state(), '6f1d', 'plant/2/temp')).toBeUndefined();
  });
});

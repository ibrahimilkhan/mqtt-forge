import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../lib/problemDetails';
import { server } from '../test/server';
import type { AlertCondition, AlertRuleDto, ConditionType } from '../types/api';
import {
  clearAlertHistory,
  getAlertRules,
  getAlerts,
  isRulesUnreadable,
  muteAlert,
  putAlertRules,
} from './alerts';

/** The spec's own rule, as the console would send it back after a save. */
const rule = (over: Partial<AlertRuleDto> = {}): AlertRuleDto => ({
  id: '6f1d',
  name: 'Boiler temperature',
  enabled: true,
  filter: 'plant/+/temp',
  field: '$.temp',
  condition: { type: 'threshold', op: 'gt', value: 90 },
  clear: { type: 'threshold', op: 'lt', value: 85 },
  for: 30,
  cooldown: 60,
  severity: 'critical',
  actions: [{ type: 'screen' }],
  ...over,
});

const EMPTY_ALERTS = {
  active: [],
  history: [],
  muted: [],
  rules: [],
  dropped: 0,
  webhooksDropped: 0,
  suppressed: 0,
  capped: [],
  blindSeconds: 0,
  warming: [],
};

describe('the alert rules endpoint', () => {
  it('reads the rule set and the two facts about this host that the editor needs', async () => {
    server.use(
      http.get('/api/alert-rules', () =>
        HttpResponse.json({
          rules: [rule()],
          allowWebhooks: false,
          topicPrefix: 'mqttforge/alerts/',
          unreadable: false,
          skippedIds: [],
        }),
      ),
    );

    const answer = await getAlertRules();

    expect(answer.rules).toHaveLength(1);
    expect(answer.rules[0].condition).toEqual({ type: 'threshold', op: 'gt', value: 90 });
    expect(answer).toMatchObject({ allowWebhooks: false, topicPrefix: 'mqttforge/alerts/' });
  });

  // The two together, because the panel draws a red line about exactly this and a 200 is what
  // lets it: a file that lost two rules is still a file worth showing the rest of.
  it('carries a partly readable file as a 200 naming what was lost', async () => {
    server.use(
      http.get('/api/alert-rules', () =>
        HttpResponse.json({
          rules: [rule()],
          allowWebhooks: true,
          topicPrefix: 'mqttforge/alerts/',
          unreadable: true,
          skippedIds: ['9c2a', 'b104'],
        }),
      ),
    );

    await expect(getAlertRules()).resolves.toMatchObject({
      unreadable: true,
      skippedIds: ['9c2a', 'b104'],
    });
  });

  it("surfaces an unreadable file as the server's own sentence, not a status code", async () => {
    server.use(
      http.get('/api/alert-rules', () =>
        HttpResponse.json(
          {
            title: 'The alert rules file could not be read',
            detail:
              'The alert rules file could not be read. No rules are running. Repair the file, or ' +
              'save a rule set asking for what is there to be discarded.',
            reason: 'rulesUnreadable',
          },
          { status: 409 },
        ),
      ),
    );

    const error = await getAlertRules().catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409, reason: 'rulesUnreadable' });
    expect((error as ApiError).message).toContain('No rules are running');
    expect(isRulesUnreadable(error)).toBe(true);
  });

  // This API answers 409 for 'not connected' and for a connect that was called off as well, and
  // only one of the three offers the reader a second button.
  it('tells that 409 from the other ones this API sends', async () => {
    expect(isRulesUnreadable(new ApiError(409, 'Not connected', 'Not connected'))).toBe(false);
    expect(isRulesUnreadable(new Error('offline'))).toBe(false);
  });

  it('saves the whole set under one key, and says out loud that nothing may be discarded', async () => {
    let url: string | undefined;
    let body: unknown;
    server.use(
      http.put('/api/alert-rules', async ({ request }) => {
        url = request.url;
        body = await request.json();
        return HttpResponse.json({ rules: [rule()], warnings: [] });
      }),
    );

    const saved = await putAlertRules([rule({ id: null })]);

    expect(new URL(url!).searchParams.get('discardUnreadable')).toBe('false');
    expect(body).toEqual({ rules: [rule({ id: null })] });
    // The id the server handed out comes back, or the next save would create a second rule.
    expect(saved.rules[0].id).toBe('6f1d');
  });

  it("carries discardUnreadable when the panel's second button is pressed", async () => {
    let url: string | undefined;
    server.use(
      http.put('/api/alert-rules', ({ request }) => {
        url = request.url;
        return HttpResponse.json({ rules: [], warnings: [{ ruleId: '6f1d', reason: 'webhooksDisabled' }] });
      }),
    );

    const saved = await putAlertRules([], true);

    expect(new URL(url!).searchParams.get('discardUnreadable')).toBe('true');
    // Saved and warned, not refused: the operator who turned webhooks off and the person writing
    // the rule are often not the same person.
    expect(saved.warnings).toEqual([{ ruleId: '6f1d', reason: 'webhooksDisabled' }]);
  });
});

describe('the alerts endpoint', () => {
  it('reads everything the panel draws in one request', async () => {
    server.use(
      http.get('/api/alerts', () =>
        HttpResponse.json({ ...EMPTY_ALERTS, dropped: 4, blindSeconds: 120 }),
      ),
    );

    await expect(getAlerts()).resolves.toMatchObject({ dropped: 4, blindSeconds: 120 });
  });

  it('mutes the pair rather than the alarm, and says for how long', async () => {
    let body: unknown;
    let contentType: string | null = null;
    server.use(
      http.post('/api/alerts/mute', async ({ request }) => {
        contentType = request.headers.get('content-type');
        body = await request.json();
        return new HttpResponse(null, { status: 204 });
      }),
    );

    await muteAlert('6f1d', 'plant/1/temp', 30);

    expect(contentType).toContain('application/json');
    expect(body).toEqual({ ruleId: '6f1d', topic: 'plant/1/temp', minutes: 30 });
  });

  it('surfaces a mute on an alarm the engine no longer holds', async () => {
    server.use(
      http.post('/api/alerts/mute', () =>
        HttpResponse.json(
          {
            title: 'No such alert',
            detail: "No alert on this engine belongs to rule '6f1d' and topic 'plant/1/temp'.",
            reason: 'alertUnknown',
          },
          { status: 404 },
        ),
      ),
    );

    const error = await muteAlert('6f1d', 'plant/1/temp', 30).catch((thrown: unknown) => thrown);

    expect(error).toMatchObject({ status: 404, reason: 'alertUnknown' });
  });

  it('clears the history on the 204 that carries no body', async () => {
    server.use(http.delete('/api/alerts/history', () => new HttpResponse(null, { status: 204 })));

    await expect(clearAlertHistory()).resolves.toBeUndefined();
  });
});

/**
 * One of every condition the engine can read.
 *
 * A Record keyed on ConditionType is the whole point: it cannot be written with a case missing,
 * so the day a twelfth condition is added to the engine and mirrored into types/api.ts, this
 * fails to compile — and so does every switch the editor makes over the same union.
 */
const SHAPES: Record<ConditionType, AlertCondition> = {
  threshold: { type: 'threshold', op: 'gt', value: 90 },
  band: { type: 'band', low: 4, high: 20, inside: true },
  pattern: { type: 'pattern', regex: '^ERR-', negate: false },
  oneOf: { type: 'oneOf', values: ['on', 'off'], negate: true },
  all: { type: 'all', of: [{ type: 'threshold', op: 'lt', value: 1 }] },
  any: { type: 'any', of: [] },
  silence: { type: 'silence', after: 300 },
  outlier: { type: 'outlier', method: 'tukey', k: 1.5, window: 200 },
  distributionShift: { type: 'distributionShift', window: 200 },
  shapeChange: { type: 'shapeChange', window: 200 },
  pulse: { type: 'pulse', metric: 'duty', op: 'gt', value: 0.8, window: 200 },
};

describe('the condition union', () => {
  it('mirrors the eleven the engine can read, and no more', () => {
    expect(Object.keys(SHAPES)).toHaveLength(11);
  });

  // The literals are AlertJsonShapeTests' own, member order included, so a property renamed or
  // reordered on the server turns this red rather than turning a rule into one nobody can read.
  it('writes the bytes the rule file and the PUT body are pinned to', () => {
    expect(JSON.stringify(SHAPES.threshold)).toBe('{"type":"threshold","op":"gt","value":90}');
    expect(JSON.stringify(SHAPES.band)).toBe('{"type":"band","low":4,"high":20,"inside":true}');
    expect(JSON.stringify(SHAPES.oneOf)).toBe('{"type":"oneOf","values":["on","off"],"negate":true}');
    expect(JSON.stringify(SHAPES.silence)).toBe('{"type":"silence","after":300}');
    expect(JSON.stringify(SHAPES.outlier)).toBe(
      '{"type":"outlier","method":"tukey","k":1.5,"window":200}',
    );
  });

  // A switch over the discriminator is exhaustive, which is what the editor's form table needs:
  // every case returns, and TypeScript is what says none is missing.
  it('lets a switch over the discriminator name every case', () => {
    const window = (condition: AlertCondition): number | undefined => {
      switch (condition.type) {
        case 'outlier':
        case 'distributionShift':
        case 'shapeChange':
        case 'pulse':
          return condition.window;
        case 'threshold':
        case 'band':
        case 'pattern':
        case 'oneOf':
        case 'all':
        case 'any':
        case 'silence':
          return undefined;
      }
    };

    expect(window(SHAPES.outlier)).toBe(200);
    expect(window(SHAPES.threshold)).toBeUndefined();
  });
});

import { ApiError } from '../lib/problemDetails';
import type {
  AlertRuleDto,
  AlertRulesResponseDto,
  AlertRulesSavedDto,
  AlertsDto,
} from '../types/api';
import { json, request } from './client';

/**
 * The rule set, and the two things about this host a rule editor has to know.
 *
 * Answers 409 with the reason below when the file as a whole could not be read. A file that
 * loaded except for one rule this build does not understand comes back as 200 carrying
 * `unreadable` and `skippedIds`, because the panel has a red line to draw about exactly that and
 * it cannot draw it from a status code.
 */
export const getAlertRules = () => request<AlertRulesResponseDto>('/api/alert-rules');

/**
 * Replaces the whole rule set, and answers with what was actually written.
 *
 * The saved rules come back because two things about them are decided on the way in: a rule that
 * arrived with no id was given one, and a webhook header sent by name alone was filled in from the
 * file. Whoever saved has to see both, or their next save undoes them.
 *
 * `discardUnreadable` is sent on every call rather than only when it is true. The server defaults
 * it to false, so the two are the same request — but this is the parameter that decides whether a
 * save silently deletes rules the console was never shown, and a request that says so out loud is
 * the one worth reading in a network tab.
 */
export const putAlertRules = (rules: AlertRuleDto[], discardUnreadable = false) =>
  request<AlertRulesSavedDto>(`/api/alert-rules?discardUnreadable=${discardUnreadable}`, {
    method: 'PUT',
    ...json({ rules }),
  });

/** Everything the alerts panel draws, as one read. Four polls would show four moments. */
export const getAlerts = () => request<AlertsDto>('/api/alerts');

/**
 * Silences one (rule, topic) pair for a while. Zero minutes lifts a silence that is running.
 *
 * The pair and not an alert id: a mute outlives the alarm it was set on — one that clears and
 * rings again an hour later is a different alert with a different id — and a topic carries '/',
 * so it could not go in a path anyway.
 */
export const muteAlert = (ruleId: string, topic: string, minutes: number) =>
  request<void>('/api/alerts/mute', { method: 'POST', ...json({ ruleId, topic, minutes }) });

/** Empties the session's alert history. The active alarms are not history. */
export const clearAlertHistory = () =>
  request<void>('/api/alerts/history', { method: 'DELETE' });

/**
 * Whether this failure is the one the panel can offer a second button for.
 *
 * A 409 on its own is not enough to branch on: this API also answers 409 for 'not connected' and
 * for a connect attempt that was called off. The reason word is what tells them apart, and it is
 * read here rather than in the panel so that the word appears once in the console.
 */
export const isRulesUnreadable = (error: unknown) =>
  error instanceof ApiError && error.reason === 'rulesUnreadable';

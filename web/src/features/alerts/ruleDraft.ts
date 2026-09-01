import { useSelectionStore } from '../../stores/selectionStore';
import type {
  AlertActionDto,
  AlertCondition,
  AlertRuleDto,
  AlertSeverity,
  OutlierMethod,
  PulseMetric,
  ThresholdOp,
} from '../../types/api';
import { useWindows } from '../monitor/useWindows';

/**
 * A rule while it is being written.
 *
 * Every number is text. A rule carries four numbers that are allowed to be absent — `for`,
 * `cooldown`, a statistical `window` and an outlier's `k` — and absent is a different request from
 * zero in all four: the wire writes 'not given' as nought and the engine then supplies its own
 * default. A draft holding `number | null` would have to decide, on every keystroke, whether a box
 * a reader has just emptied means null or means they are half way through typing '20'. Text says
 * exactly what is in the box, and `ruleOf` does the one conversion at the end.
 *
 * `field` and a publish topic are the same story told with a string: '' is the absence, and the
 * DTO's null.
 */
export type DraftRule = {
  /** The server's id. Null until the first save of a rule this console invented. */
  id: string | null;
  name: string;
  enabled: boolean;
  filter: string;
  /** '' is the body itself, which is the DTO's null. */
  field: string;
  condition: DraftCondition;
  /** null is 'clear when the condition stops being true', which is the rule's own default. */
  clear: DraftCondition | null;
  /** Seconds, as typed. '' is absent. */
  for: string;
  cooldown: string;
  severity: AlertSeverity;
  screen: boolean;
  sound: boolean;
  webhook: DraftWebhook | null;
  publish: DraftPublish | null;
  /**
   * Channels this form does not draw, carried through a save untouched.
   *
   * A rule may hold two webhooks, and a rule file edited by hand may hold a channel this build has
   * never heard of. The editor draws one of each kind it knows; everything past that is kept here
   * and put back exactly as it came. An editor that silently dropped one would turn a rule that
   * tells two teams into a rule that tells one, and nothing on screen would have said so.
   */
  extra: AlertActionDto[];
};

export type DraftWebhook = { url: string; headers: DraftHeader[] };

/**
 * One header row. `kept` marks a name that arrived from the server with its value withheld — the
 * editor was never told what it is, so an empty box means 'the one you already have'.
 */
export type DraftHeader = { name: string; value: string; kept: boolean };

export type DraftPublish = { topic: string; qos: number; retain: boolean };

/**
 * A condition while it is being written, with one case the wire does not have.
 *
 * `opaque` is a condition this form cannot draw: a composite inside a composite, or a type from a
 * newer build. It carries the original and gives it back unchanged on save. The alternative was to
 * draw it as something simpler, which is a form quietly rewriting a rule the reader only opened to
 * look at.
 */
export type DraftCondition =
  | { type: 'threshold'; op: ThresholdOp; value: string }
  | { type: 'band'; low: string; high: string; inside: boolean }
  | { type: 'pattern'; regex: string; negate: boolean }
  /** One value to a line: a textarea is the only control that takes an unknown number of them. */
  | { type: 'oneOf'; values: string; negate: boolean }
  | { type: 'all'; of: DraftCondition[] }
  | { type: 'any'; of: DraftCondition[] }
  | { type: 'silence'; after: string }
  | { type: 'outlier'; method: OutlierMethod; k: string; window: string }
  | { type: 'distributionShift'; window: string }
  | { type: 'shapeChange'; window: string }
  | { type: 'pulse'; metric: PulseMetric; op: ThresholdOp; value: string; window: string }
  | { type: 'opaque'; source: AlertCondition };

/** The types a reader may choose. `opaque` is not one: it is what a rule arrives as. */
export const CONDITION_TYPES = [
  'threshold',
  'band',
  'pattern',
  'oneOf',
  'silence',
  'outlier',
  'distributionShift',
  'shapeChange',
  'pulse',
  'all',
  'any',
] as const;

export type ConditionType = (typeof CONDITION_TYPES)[number];

/**
 * What a child of an `all` or an `any` may be.
 *
 * One level, on purpose. The union is recursive and the server will take any depth, but a tree
 * editor inside a floating window is a different feature from this one — and a rule file that does
 * hold a deeper tree loses nothing, because the whole condition comes back as `opaque` and goes
 * out again untouched.
 */
export const SIMPLE_TYPES = CONDITION_TYPES.filter(
  (type) => type !== 'all' && type !== 'any',
) as ReadonlyArray<Exclude<ConditionType, 'all' | 'any'>>;

/** The words the picker shows. The wire's own names are camelCase and two of them are jargon. */
export const CONDITION_LABELS: Record<ConditionType, string> = {
  threshold: 'Past a number',
  band: 'Outside or inside a range',
  pattern: 'Matches a pattern',
  oneOf: 'One of a list',
  silence: 'Nothing has arrived',
  outlier: 'Unlike the readings before it',
  distributionShift: 'The distribution has changed',
  shapeChange: 'The kind of signal has changed',
  pulse: 'A number about the rhythm',
  all: 'All of these',
  any: 'Any of these',
};

/**
 * What `k` means, and therefore what it starts at.
 *
 * Tukey's is a multiplier on the box and the textbook value is 1.5; sigma's counts deviations and
 * every control chart in the world is drawn at 3. The two are not the same number wearing two
 * names — tukey 3 is about 4.7σ — which is why switching the method resets this rather than
 * carrying it across.
 */
export const defaultK = (method: OutlierMethod): string => (method === 'tukey' ? '1.5' : '3');

/** A condition of this type, as a reader would want to find it: empty, but not invalid. */
export function blankCondition(type: ConditionType): DraftCondition {
  switch (type) {
    case 'threshold':
      return { type, op: 'gt', value: '' };
    case 'band':
      // Outside, because that is the 4-20mA question and the reason this condition exists.
      return { type, low: '', high: '', inside: false };
    case 'pattern':
      return { type, regex: '', negate: false };
    case 'oneOf':
      return { type, values: '', negate: false };
    case 'silence':
      // A silence of nought is not a silence rule; it is a rule that fires on every tick. A minute
      // is the shortest interval anybody watching a plant actually means.
      return { type, after: '60' };
    case 'outlier':
      return { type, method: 'tukey', k: defaultK('tukey'), window: '' };
    case 'distributionShift':
    case 'shapeChange':
      return { type, window: '' };
    case 'pulse':
      return { type, metric: 'count', op: 'gt', value: '', window: '' };
    case 'all':
    case 'any':
      return { type, of: [] };
  }
}

/**
 * Nought on the wire is an empty box: it is how JSON says a member was not given. Absent is too.
 *
 * Takes `number | undefined` rather than `number` because that is what the DTO holds: every
 * statistical window is optional, and a member the server left out arrives here as undefined, not
 * as nought. Passing a required number in is still legal, so the four call sites read alike.
 */
const absent = (value: number | undefined): string =>
  value === undefined || value === 0 ? '' : String(value);

/**
 * The same, for k, which is the one number with somewhere better to fall back to.
 *
 * A method with no k is a method at its own default, and showing that default is more use than
 * showing an empty box the reader then has to guess the meaning of. Written as a function taking
 * `number | undefined` so it reads the absence the same way whether the DTO makes k optional or not.
 */
const kOr = (value: number | undefined, method: OutlierMethod): string =>
  value === undefined || value === 0 ? defaultK(method) : String(value);

/** An empty box is nought on the wire, for the same reason. */
const numberOf = (text: string): number => (text.trim() === '' ? 0 : Number(text));

const seconds = (text: string): number | null => (text.trim() === '' ? null : Number(text));

/** What the wire holds, as boxes. `nested` is what refuses a composite inside a composite. */
function conditionDraft(condition: AlertCondition, nested = false): DraftCondition {
  switch (condition.type) {
    case 'threshold':
      return { type: 'threshold', op: condition.op, value: String(condition.value) };
    case 'band':
      return {
        type: 'band',
        low: String(condition.low),
        high: String(condition.high),
        inside: condition.inside,
      };
    case 'pattern':
      return { type: 'pattern', regex: condition.regex, negate: condition.negate };
    case 'oneOf':
      return { type: 'oneOf', values: condition.values.join('\n'), negate: condition.negate };
    case 'silence':
      return { type: 'silence', after: String(condition.after) };
    case 'outlier':
      return {
        type: 'outlier',
        method: condition.method,
        k: kOr(condition.k, condition.method),
        window: absent(condition.window),
      };
    case 'distributionShift':
      return { type: 'distributionShift', window: absent(condition.window) };
    case 'shapeChange':
      return { type: 'shapeChange', window: absent(condition.window) };
    case 'pulse':
      return {
        type: 'pulse',
        metric: condition.metric,
        op: condition.op,
        value: String(condition.value),
        window: absent(condition.window),
      };
    case 'all':
    case 'any':
      return nested
        ? { type: 'opaque', source: condition }
        : { type: condition.type, of: condition.of.map((child) => conditionDraft(child, true)) };
    default:
      // A type this build has never heard of, from a rule file a newer one wrote.
      return { type: 'opaque', source: condition };
  }
}

/** The boxes, as the wire holds them. */
export function conditionOf(draft: DraftCondition): AlertCondition {
  switch (draft.type) {
    case 'opaque':
      return draft.source;
    case 'threshold':
      return { type: 'threshold', op: draft.op, value: numberOf(draft.value) };
    case 'band':
      return {
        type: 'band',
        low: numberOf(draft.low),
        high: numberOf(draft.high),
        inside: draft.inside,
      };
    case 'pattern':
      return { type: 'pattern', regex: draft.regex, negate: draft.negate };
    case 'oneOf':
      return { type: 'oneOf', values: listOf(draft.values), negate: draft.negate };
    case 'silence':
      return { type: 'silence', after: numberOf(draft.after) };
    case 'outlier':
      return {
        type: 'outlier',
        method: draft.method,
        k: numberOf(draft.k),
        window: numberOf(draft.window),
      };
    case 'distributionShift':
      return { type: 'distributionShift', window: numberOf(draft.window) };
    case 'shapeChange':
      return { type: 'shapeChange', window: numberOf(draft.window) };
    case 'pulse':
      return {
        type: 'pulse',
        metric: draft.metric,
        op: draft.op,
        value: numberOf(draft.value),
        window: numberOf(draft.window),
      };
    case 'all':
      return { type: 'all', of: draft.of.map(conditionOf) };
    case 'any':
      return { type: 'any', of: draft.of.map(conditionOf) };
  }
}

/** A line each, with the blank ones dropped: a trailing newline is not a value to match. */
const listOf = (text: string): string[] =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');

/**
 * A condition as the file writes it.
 *
 * Shown rather than described where the form cannot draw one. A reader who opened a rule they did
 * not write is owed the chance to see what it says, and the JSON is what it says.
 */
export const conditionText = (draft: DraftCondition): string =>
  JSON.stringify(conditionOf(draft), null, 1);

const KNOWN = new Set(['screen', 'sound', 'webhook', 'publish']);

/**
 * A rule as boxes — or, with no rule, a new one.
 *
 * `prefill` is the topic picked in the tree, and it is read ONCE, by the caller, at the moment the
 * draft is made. Never live: the colour panel's row sits beside the tree and follows it, and that
 * is right for a row six inches from what it is following; this is a window, and a form that
 * rewrote itself because somebody clicked about the tree behind it would be a form nobody could
 * fill in. An existing rule is never prefilled at all — it has a filter, and it is the one thing
 * the rule is about.
 */
export function draftOf(rule: AlertRuleDto | undefined, prefill: string | undefined): DraftRule {
  if (!rule) {
    return {
      // No server id yet, and null rather than absent because that is what the wire calls a rule
      // it has not stored: the save answers with the id it handed out.
      id: null,
      name: '',
      enabled: true,
      filter: prefill ?? '',
      field: '',
      condition: blankCondition('threshold'),
      clear: null,
      for: '',
      cooldown: '',
      // Warn, not info: a rule somebody sat down to write is one they want to hear about, and
      // critical is a claim they should have to make on purpose.
      severity: 'warn',
      screen: true,
      sound: false,
      webhook: null,
      publish: null,
      extra: [],
    };
  }

  const webhook = rule.actions.find((action) => action.type === 'webhook');
  const publish = rule.actions.find((action) => action.type === 'publish');
  const seen = new Set<string>();

  return {
    id: rule.id,
    name: rule.name,
    enabled: rule.enabled,
    filter: rule.filter,
    field: rule.field ?? '',
    condition: conditionDraft(rule.condition),
    clear: rule.clear ? conditionDraft(rule.clear) : null,
    // `?? ''` rather than a comparison: null is the absence, and String('') is the empty box.
    for: String(rule.for ?? ''),
    cooldown: String(rule.cooldown ?? ''),
    severity: rule.severity,
    screen: rule.actions.some((action) => action.type === 'screen'),
    sound: rule.actions.some((action) => action.type === 'sound'),
    webhook: webhook
      ? {
          url: webhook.url ?? '',
          // Names with no values, which is all the server will ever hand out. The empty box is the
          // request to keep what is on disk, and the editor says so on screen.
          headers: (webhook.headerNames ?? []).map((name) => ({ name, value: '', kept: true })),
        }
      : null,
    publish: publish
      ? { topic: publish.topic ?? '', qos: publish.qos ?? 0, retain: publish.retain ?? false }
      : null,
    extra: rule.actions.filter((action) => {
      if (!KNOWN.has(action.type)) return true;
      if (seen.has(action.type)) return true;
      seen.add(action.type);

      return false;
    }),
  };
}

/** The boxes as a rule the API will take. */
export function ruleOf(draft: DraftRule): AlertRuleDto {
  const actions: AlertActionDto[] = [];

  if (draft.screen) actions.push({ type: 'screen' });
  if (draft.sound) actions.push({ type: 'sound' });

  if (draft.webhook) {
    actions.push({
      type: 'webhook',
      url: draft.webhook.url.trim(),
      // Always a map, never absent, because this form HAS opened the headers: an absent map is the
      // panel's toggle saying 'I am not editing these', and the editor is not entitled to say that.
      // A name with an empty value is the sentence that keeps the value on disk.
      headers: Object.fromEntries(
        draft.webhook.headers
          .filter((header) => header.name.trim() !== '')
          .map((header) => [header.name.trim(), header.value]),
      ),
    });
  }

  if (draft.publish) {
    actions.push({
      type: 'publish',
      // '' is the default topic, "{prefix}{ruleId}/{topic}", which is the easy answer and the safe
      // one — it is inside the prefix and carries the placeholder by construction.
      topic: draft.publish.topic.trim() === '' ? null : draft.publish.topic.trim(),
      qos: draft.publish.qos,
      retain: draft.publish.retain,
    });
  }

  return {
    // Written out rather than spread in conditionally: the id is part of the shape either way, and
    // null is how this list says 'a rule the server has not seen yet'.
    id: draft.id,
    name: draft.name.trim(),
    enabled: draft.enabled,
    filter: draft.filter.trim(),
    field: draft.field.trim() === '' ? null : draft.field.trim(),
    condition: conditionOf(draft.condition),
    clear: draft.clear ? conditionOf(draft.clear) : null,
    for: seconds(draft.for),
    cooldown: seconds(draft.cooldown),
    severity: draft.severity,
    actions: [...actions, ...draft.extra],
  };
}

/**
 * The drafts, outside React and outside the query cache.
 *
 * Outside React because a draft outlives the window that shows it: Escape shuts the window in
 * front of the reader — which is the console's one rule about Escape and should stay one rule —
 * and a form whose contents died with it would make that keystroke a trap. Outside the query cache
 * because a half-typed filter is not a rule, and writing one into the cache would put it in front
 * of the panel, the badge and every other reader of the list on every keystroke.
 */
const drafts = new Map<string, DraftRule>();

let count = 0;

/**
 * What keys a draft.
 *
 * A saved rule keys on its server id, so Edit pressed twice on one row finds the window it opened
 * a moment ago. A rule that does not exist yet has nothing to key on and gets a number: two new
 * drafts are two rules, and they have to be distinguishable — which is the whole reason `Pane`
 * carries a draft id rather than a rule id. `rule.id` is `string | null`, and the truth test reads
 * the null the same way it reads a rule that was never passed.
 */
export const draftIdOf = (rule?: AlertRuleDto): string =>
  rule?.id ? `rule:${rule.id}` : `draft:${(count += 1)}`;

export const readDraft = (draftId: string): DraftRule | undefined => drafts.get(draftId);

/** Writes the draft through and hands it back, so an editor's setState can be one expression. */
export function keepDraft(draftId: string, draft: DraftRule): DraftRule {
  drafts.set(draftId, draft);

  return draft;
}

/** After a save the server took, or a draft abandoned: the next open reads the rule again. */
export const forgetDraft = (draftId: string): void => {
  drafts.delete(draftId);
};

/**
 * Open the editor on a rule, or on a new one.
 *
 * The prefill happens here and only here, on the one path that makes a draft — which is what makes
 * 'once, at open' a fact about the code rather than a discipline the editor has to keep.
 */
export function openRuleEditor(rule?: AlertRuleDto): void {
  const draftId = draftIdOf(rule);

  if (!drafts.has(draftId)) {
    drafts.set(draftId, draftOf(rule, useSelectionStore.getState().selected?.topic));
  }

  const draft = drafts.get(draftId)!;
  const label = draft.id ? draft.name.trim() || 'This alert rule' : 'New alert rule';

  useWindows.getState().open({ kind: 'rule', draftId }, label);
}

/**
 * Where a rule is being saved to, which is two things only the server knows.
 *
 * The prefix decides which publish topics are legal, and it is the one thing here that turns into
 * a refusal. The webhook switch turns into a note instead: a server with webhooks off still saves
 * the rule and still keeps the address, and refusing it in the editor would be the console lying
 * about what the server does. Both come down with the rule list.
 */
export type SaveTarget = { topicPrefix: string; allowWebhooks: boolean };

/** Why a field cannot be saved, in the words of the person who typed it. */
export type RuleFaults = {
  name?: string;
  filter?: string;
  for?: string;
  cooldown?: string;
  condition?: string;
  clear?: string;
  webhook?: string;
  publish?: string;
};

export const savable = (faults: RuleFaults): boolean => Object.keys(faults).length === 0;

/** The engine's own limits, said here so the answer arrives before the round trip. */
const MIN_WINDOW = 20;
const MAX_WINDOW = 2000;
const MAX_PATTERN = 250;
const MAX_HEADERS = 10;
const MAX_HEADER_NAME = 64;

/**
 * Everything wrong with this draft, or an empty object.
 *
 * A mirror of `AlertRulesDtoValidator`, and only a mirror: it refuses what the server refuses and
 * nothing more. Where the server has said a thing well — 'a tukey outlier's k is a multiplier on
 * the box, from 0.5 to 5' — the sentence is carried across rather than reworded, so a reader who
 * meets both hears one voice.
 *
 * Two refusals cannot be complete here and both are named where they sit: a regular expression is
 * checked against the browser's engine rather than .NET's, and the prefix is whatever the last GET
 * said it was.
 */
export function faultsIn(draft: DraftRule, where: SaveTarget): RuleFaults {
  const faults: RuleFaults = {};

  if (draft.name.trim() === '') faults.name = 'A rule needs a name.';
  else if (draft.name.trim().length > 80) faults.name = 'A name may be at most 80 characters.';

  const filter = filterFault(draft.filter.trim(), where.topicPrefix);
  if (filter) faults.filter = filter;

  const forFault = wholeSeconds(draft.for);
  if (forFault) faults.for = forFault;
  else if (draft.for.trim() !== '' && alreadyADuration(draft.condition)) {
    faults.for =
      "'For' cannot be given with a silence, a distribution shift or a shape change: a silence " +
      'is already a duration, and the other two are moments rather than states that can hold.';
  }

  const cooldown = wholeSeconds(draft.cooldown);
  if (cooldown) faults.cooldown = cooldown;

  const condition = conditionFault(draft.condition);
  if (condition) faults.condition = condition;

  const clear = draft.clear ? conditionFault(draft.clear) : null;
  if (clear) faults.clear = clear;

  if (draft.webhook) {
    const webhook = webhookFault(draft.webhook);
    if (webhook) faults.webhook = webhook;
  }

  if (draft.publish) {
    const publish = publishFault(draft.publish, draft.filter.trim(), where.topicPrefix);
    if (publish) faults.publish = publish;
  }

  return faults;
}

/**
 * Why this filter is not one a rule can watch.
 *
 * The wildcard rules are the colour panel's, and they are written again rather than shared: that
 * function folds a duplicate-filter check into the same sentence, and a filter is allowed to be
 * repeated here — two rules watching one tree for two different things is the ordinary case.
 */
function filterFault(filter: string, prefix: string): string | null {
  if (filter === '') return 'A topic filter cannot be empty.';

  const segments = filter.split('/');

  for (const [index, segment] of segments.entries()) {
    if (segment === '#' && index !== segments.length - 1) return "'#' can only be the last segment.";
    if (segment !== '#' && segment.includes('#')) return "'#' has to be a whole segment, on its own.";
    if (segment !== '+' && segment.includes('+')) return "'+' has to be a whole segment, on its own.";
  }

  // A rule watching the engine's own tree is not a loop — the engine drops what arrives from under
  // its prefix — it is a subscription that costs bandwidth, matches messages and can never fire.
  // Refusing it is the only way the person who wrote it ever finds out.
  if (covers(segments, prefix)) {
    return (
      `A rule cannot watch '${prefix}': that is where this server publishes its own alerts, ` +
      'and the engine ignores everything under it.'
    );
  }

  return null;
}

/** Whether a filter reaches into the tree under the prefix. Structural, as the server's is. */
function covers(parts: string[], prefix: string): boolean {
  const levels = prefix.replace(/\/+$/, '').split('/');

  for (const [index, level] of levels.entries()) {
    if (index >= parts.length) return false;
    if (parts[index] === '#') return true;
    if (parts[index] !== '+' && parts[index] !== level) return false;
  }

  return parts.length > levels.length;
}

const wholeSeconds = (text: string): string | null => {
  if (text.trim() === '') return null;

  const value = Number(text);

  return Number.isInteger(value) && value >= 0 ? null : 'A number of seconds, or empty.';
};

/** Whether anything in this tree is already an interval or a moment, which 'for' cannot wait out. */
function alreadyADuration(condition: DraftCondition): boolean {
  switch (condition.type) {
    case 'silence':
    case 'distributionShift':
    case 'shapeChange':
      return true;
    case 'all':
    case 'any':
      return condition.of.some(alreadyADuration);
    case 'opaque':
      // Unread on purpose. The server will judge what it holds; guessing here could only refuse
      // something it would have taken.
      return false;
    default:
      return false;
  }
}

/** Why this condition cannot be saved, or null. One sentence, as the server gives one. */
function conditionFault(condition: DraftCondition): string | null {
  switch (condition.type) {
    case 'threshold':
      return finite(condition.value, 'A threshold needs a number to compare against.');

    case 'band':
      return (
        finite(condition.low, 'A band needs a low edge.') ??
        finite(condition.high, 'A band needs a high edge.')
      );

    case 'pattern':
      if (condition.regex === '') return 'A pattern condition needs an expression.';
      if (condition.regex.length > MAX_PATTERN) {
        return `A pattern may be at most ${MAX_PATTERN} characters.`;
      }
      try {
        // The browser's engine, which is not the server's: a pattern refused here is certainly bad,
        // and one accepted here may still come back a 400 from a .NET engine that reads it
        // differently. Worth doing anyway — an unclosed bracket is the mistake people actually make.
        new RegExp(condition.regex);
      } catch {
        return `'${condition.regex}' is not a valid regular expression.`;
      }

      return null;

    case 'oneOf':
      return listOf(condition.values).length === 0 ? 'A list needs at least one value.' : null;

    case 'silence':
      return Number(condition.after) >= 1 && Number.isInteger(Number(condition.after))
        ? null
        : 'A silence condition has to wait at least a second.';

    case 'outlier':
      return windowFault(condition.window) ?? kFault(condition.method, condition.k);

    case 'distributionShift':
    case 'shapeChange':
      return windowFault(condition.window);

    case 'pulse': {
      // Worked out once and held: these two are the same question asked of two boxes, and asking
      // each of them twice was how the first draft of this read.
      const bad =
        windowFault(condition.window) ??
        finite(condition.value, 'A pulse needs a number to compare against.');
      if (bad) return bad;

      const value = Number(condition.value);

      if (condition.metric === 'duty' && (value < 0 || value > 1)) {
        return 'A duty is the share of the readings spent past the line, from 0 to 1.';
      }
      if (condition.metric !== 'duty' && value < 0) {
        return 'A pulse count, period or width is never negative.';
      }

      return null;
    }

    case 'all':
    case 'any':
      if (condition.of.length === 0) return 'This needs at least one condition under it.';

      return condition.of.map(conditionFault).find((fault) => fault !== null) ?? null;

    case 'opaque':
      // Kept, not judged. It came off the file exactly as it stands and goes back the same way.
      return null;
  }
}

const finite = (text: string, missing: string): string | null =>
  text.trim() === '' || !Number.isFinite(Number(text)) ? missing : null;

/** Empty is the server's own default and is always allowed; a number has to be one it will use. */
const windowFault = (text: string): string | null => {
  if (text.trim() === '') return null;

  const window = Number(text);

  return Number.isInteger(window) && window >= MIN_WINDOW && window <= MAX_WINDOW
    ? null
    : `A statistical window is between ${MIN_WINDOW} and ${MAX_WINDOW} readings, or empty for ` +
        "this server's default: below that range there is not enough of a run to say anything.";
};

/** k's range is the method's, because k is the method's number. */
const kFault = (method: OutlierMethod, text: string): string | null => {
  if (text.trim() === '') return null;

  const k = Number(text);

  if (method === 'tukey') {
    return Number.isFinite(k) && k >= 0.5 && k <= 5
      ? null
      : "A tukey outlier's k is a multiplier on the box, from 0.5 to 5.";
  }

  return Number.isFinite(k) && k >= 1 && k <= 10
    ? null
    : "A sigma outlier's k is a number of deviations, from 1 to 10.";
};

function webhookFault(webhook: DraftWebhook): string | null {
  let url: URL;

  try {
    url = new URL(webhook.url.trim());
  } catch {
    return 'A webhook url has to be an absolute http:// or https:// address.';
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return 'A webhook url has to be an absolute http:// or https:// address.';
  }

  // Credentials in the URL are sent on by every redirect and written into every log on the way.
  // The header rows below are where this design put secrets on purpose.
  if (url.username !== '' || url.password !== '') {
    return 'A webhook url must not carry a username or password. Use a header.';
  }

  const named = webhook.headers.filter((header) => header.name.trim() !== '');
  if (named.length > MAX_HEADERS) return `A webhook may carry at most ${MAX_HEADERS} headers.`;

  for (const header of named) {
    if (header.name.trim().length > MAX_HEADER_NAME) {
      return `A header name has to be 1 to ${MAX_HEADER_NAME} characters.`;
    }
    // A CR or an LF in a header is a request-splitting attempt or a copy-paste accident, and there
    // is no telling which, so neither goes out over a socket this server opened.
    if (/[\u0000-\u001f\u007f]/.test(header.name) || /[\u0000-\u001f\u007f]/.test(header.value)) {
      return 'A header cannot hold a control character.';
    }
  }

  return null;
}

function publishFault(publish: DraftPublish, filter: string, prefix: string): string | null {
  const topic = publish.topic.trim();

  // Empty is the default topic, which is inside the prefix and carries the placeholder by
  // construction — the easy answer and the safe one, with nothing left to check.
  if (topic === '') return null;

  if (topic.includes('+') || topic.includes('#')) {
    return 'A publish topic cannot carry a wildcard: a publication is to one topic.';
  }

  // Expanded rather than tested as a template, because the rule is about the topic that is
  // actually published: '{topic}/alarm' passes any test of the literal and publishes into the plant.
  if (!topic.replace('{topic}', '\u0000').startsWith(prefix)) {
    return (
      `A publish topic has to stay under '${prefix}'. Anything else writes the engine's own ` +
      'alerts back into the plant.'
    );
  }

  // One rule over 'plant/+/temp' watches twenty boilers. A retained publish to one fixed topic
  // means the twentieth alarm overwrites the nineteenth, and the empty retained message that
  // clears one of them erases the record of all of them.
  if (
    publish.retain &&
    (filter.includes('+') || filter.includes('#')) &&
    !topic.includes('{topic}')
  ) {
    return (
      "A retained publish from a wildcard filter has to carry '{topic}' in its topic, or " +
      "every topic the rule watches overwrites the last one's retained alarm."
    );
  }

  return null;
}

/**
 * The rule set to PUT, with this one rule in it.
 *
 * `stored` is what the query cache holds at the moment of the click, and that timing is the whole
 * point: three writers edit this list — the panel's switch, its delete button, and any number of
 * editor windows — and a body compiled from anything older would undo whichever of them clicked
 * first. The rules this one did not touch travel back exactly as they came, which is also what
 * keeps their secrets: an action with header names and no headers is the wire's way of saying
 * 'I am not editing these'.
 *
 * A rule with a null id is one the server has never seen, so it is added rather than matched: an
 * id is the only identity a rule has, and matching a new one on its name would let two rules
 * written a minute apart become one.
 */
export function saveRule(stored: readonly AlertRuleDto[], rule: AlertRuleDto): AlertRuleDto[] {
  const at = rule.id ? stored.findIndex((one) => one.id === rule.id) : -1;

  // In place, not moved to the end: the panel lists rules in the order the file holds them, and a
  // rule that jumped to the bottom every time somebody renamed it would make the list unreadable.
  return at === -1 ? [...stored, rule] : stored.map((one, index) => (index === at ? rule : one));
}

/** The rule set to PUT, with this rule gone. An id the list does not hold changes nothing. */
export const removeRule = (stored: readonly AlertRuleDto[], id: string): AlertRuleDto[] =>
  stored.filter((one) => one.id !== id);

# Alerts: a grouped rule library and a pattern builder

Date: 2026-11-19
Status: agreed, planned in docs/superpowers/plans/2026-11-19-alerts-library-groups-pattern-builder.md

## Why

The Alerts panel's rule library (`web/src/features/alerts/RuleLibrary.tsx`, data in
`templates.ts`) shows one card per condition kind — eleven cards. One example per kind teaches
what a kind is, but not what it can do: a reader sees `threshold < 13` and never learns that the
same kind reads a JSON field, waits out a `For`, or asks `≠`. The library should show every
meaningful setting of every kind, each as a small real-world story, grouped under its kind.

The pattern condition is the hardest one to write. Its editor is a bare regular-expression box
and a "Fire when it does NOT match" tick. Two problems were named:

1. **Writing a regex is hard.** Most pattern rules are "contains X", "starts with X", "is exactly
   X" or "is one of these words", and none of them should need regex syntax.
2. **There is no way to know it is right.** The only check today is the server's validator on
   save and, later, a rule that silently never fires.

Case-insensitivity and earlier regex errors were offered and not chosen as goals; the second comes
for free with the tester below.

## Scope

Web only. The wire shape (`PatternCondition { regex, negate }`), `alert-rules.json`, the server
validator and the engine do not change.

## Part 1 — grouped library

### Data

`templates.ts` changes from a flat `RuleTemplate[]` to groups:

```ts
export type RuleExample = {
  /** The scenario's name on the card, e.g. 'Upper limit'. Unique across the library. */
  title: string;
  /** One or two sentences: the scenario as something that happens in a building. */
  story: string;
  /** A fresh draft every time. */
  draft: () => DraftRule;
};

export type TemplateGroup = {
  type: ConditionType;
  /** The kind in one line, shown under the group heading. */
  says: string;
  examples: readonly RuleExample[];
};

export const TEMPLATE_GROUPS: readonly TemplateGroup[];
```

Groups are in `CONDITION_TYPES` order. The `made(...)` helper stays. Every example's draft must
pass `ruleOf` and the existing validation — a unit test walks all of them.

### Examples

UI text stays English, as the rest of the app. Topics follow the existing `sensors/…`,
`devices/…`, `home/…` vocabulary.

| Group | Example (title — rule) |
|---|---|
| threshold | Upper limit — `sensors/rack/temp` > 35 |
| | Lower limit — `sensors/garage/temp` < 13 |
| | Equals — `devices/pump/state` = 0 (pump stopped) |
| | Not equal — `devices/hvac/mode` ≠ 1 |
| | Battery from a JSON field — `devices/+/status`, field `battery`, < 20 |
| | Only if it lasts — `servers/+/cpu` > 90, For 120 s |
| band | Leaves its range — `sensors/line/current` outside 4–20 (4-20 mA break) |
| | Enters a range — `sensors/cellar/humidity` inside 70–100 (mould zone) |
| | Clears with a margin — `sensors/boiler/pressure` outside 1–2.5, clear when inside 1.2–2.3 |
| pattern | Contains — `devices/+/log` contains `ERROR` |
| | Starts with — `devices/+/log` starts with `ERR-` |
| | Ends with — `gateway/+/event` ends with `timeout` |
| | Is exactly — `devices/+/status` is exactly `OFFLINE` |
| | Does not match — `devices/+/firmware` does not start with `2.` (old firmware) |
| | Regular expression on a field — `devices/+/event`, field `msg`, regex `timeout\|refused` |
| oneOf | Deny-list — `devices/lamp/+/state` is `fault` or `offline` |
| | Allow-list — `devices/door/+/state` is NOT `open` / `closed` (anything unexpected) |
| | Status from a JSON field — `devices/+/status`, field `status`, is `error` or `fault` |
| silence | Battery died — `sensors/loft/temp`, 900 s, info |
| | Heartbeat — `plc/main/heartbeat`, 30 s, critical |
| | Every device on its own — `devices/+/heartbeat`, 120 s |
| outlier | Sigma fence — `home/energy/meter`, sigma 3 |
| | Tukey fence (skewed data) — `sensors/flow/rate`, tukey 1.5 |
| | Short memory — `sensors/vibration/rms`, sigma 3, window 50 |
| distributionShift | Level moved — `sensors/kitchen/humidity`, window 200 |
| | Slow drift — `sensors/tank/level`, window 1000 (calibration drift) |
| shapeChange | Quantity became a switch — `devices/fan/speed`, window 200 |
| | Sensor stuck — `sensors/door/contact`, window 200 (a switch went flat) |
| pulse | Pulse count — `alerts/door/front`, count > 5 |
| | Pulse share — `devices/pump/run`, duty > 0.3 (duty is the share of the rarer state, never above 0.5) |
| | Pulse interval — `devices/beacon/led`, period > 2000 ms |
| | Pulse duration — `devices/valve/open`, width > 5000 ms |
| all | Cold and abnormal — `sensors/garage/temp`: < 13 AND sigma-3 outlier |
| | Out of range and chattering — `sensors/line/current`: outside 4–20 AND pulse count > 10 |
| any | Cold or silent — `sensors/garage/temp`: < 5 OR silent 600 s |
| | Error text or fault state — `devices/+/status`: contains `ERROR` OR one of `fault` |

All conditions in a rule read the same topic and the same field; the composite examples are chosen
so that this holds. Severities default as `draftOf` does unless a row says otherwise.

### Layout

- Top bar unchanged (Rule library heading, ← Back, Blank rule).
- Under it, a row of chips, one per group (`CONDITION_LABELS[type]`). A chip scrolls its group's
  heading into view and moves focus to it. The chips are a `nav` labelled "Kinds of rule".
- Each group is a `section` with an `h4` heading (the label), the `says` line under it, then the
  existing card grid (`ul`) holding that group's cards.
- Cards keep their fixed size. A card shows: `title` (`h5`), the topic, `firesOn(rule)`, the info
  mark, and Use. The info mark swaps the topic and summary for the story, as today. Only one story
  is open in the whole library at a time; the key becomes `type:title`.
- Use's accessible name becomes `Use the <title> example (<label>)`.
- Narrow widths: chips wrap; the grid already reflows.

## Part 2 — pattern builder

### The pattern editor

The `pattern` case of `ConditionFields` becomes:

```
How it matches   [Contains ▾]        Fire when   [it matches ▾]
Text             [ERROR            ]
                 regex: ERROR                      (muted, read-only)
— Try it ——————————————————————————————
```

- **How it matches** options: Contains, Starts with, Ends with, Is exactly, Any of these words,
  Regular expression.
- **Fire when**: "it matches" / "it does not match" — the existing `negate`, as a select so the
  sentence reads in one line.
- **Text** for the first four: one plain-text input. For "Any of these words": a textarea, one
  word to a line (as `oneOf`). For "Regular expression": the current input, monospace, unchanged
  behaviour.
- Under the input, in builder modes, the regex that will be saved, read-only, so the reader learns
  the syntax by seeing it and can switch to Regular expression to refine it.

The draft keeps `regex` as the only stored truth; the builder's mode and text live in the editor
as derived state, recomputed when the condition changes from outside (a template, a reload).

### `patternBuilder.ts`

Pure functions, no React:

```ts
export type PatternMode = 'contains' | 'startsWith' | 'endsWith' | 'exactly' | 'anyWord' | 'regex';

/** The regex a builder mode writes. */
export function regexOf(mode: Exclude<PatternMode, 'regex'>, text: string): string;

/** The builder mode and text that would write this regex, or regex mode when none would. */
export function readPattern(regex: string): { mode: PatternMode; text: string };
```

Writing, with `esc` escaping `\ ^ $ . | ? * + ( ) [ ] { }`:

| Mode | Text | Regex |
|---|---|---|
| contains | `a.b` | `a\.b` |
| startsWith | `ERR-` | `^ERR-` |
| endsWith | `timeout` | `timeout$` |
| exactly | `OFFLINE` | `^OFFLINE$` |
| anyWord | `fault` / `offline` | `^(?:fault\|offline)$` |

`anyWord` trims each line and drops blank lines. Is-exactly and any-word anchor both ends,
because "one of these words" on a status topic means the whole value, and `contains` already
covers the loose reading.

Reading is the exact inverse: a regex is read back into a mode only when unescaping it and writing
it again gives the identical string (`regexOf(readPattern(r).mode, readPattern(r).text) === r`).
Everything else — including a hand-written regex that happens to look close — opens in Regular
expression mode, so opening a rule never changes it. An empty regex opens as Contains with empty
text.

Switching mode carries the text across where it means the same thing: between the four
single-text modes the text is kept; into Regular expression the current regex is kept; out of
Regular expression `readPattern` is applied, and if it gives `regex` the text box starts empty
rather than holding regex syntax that would then be escaped.

### `PatternTry.tsx` — the tester

Shown under the pattern fields in the rule editor (top-level condition and inside `all` / `any`).

- **Recent messages.** `runFor(byTopic, rule.filter)` from the log store, newest first, distinct
  by text, at most 8. The text tested is what the rule would test: the body, or the rule's field
  read the way `PayloadValue.TryExtract` reads it — a JSON string gives its contents, any other
  JSON value gives its JSON text, a missing field or a non-JSON body gives "field missing".
  The walk reuses `series.ts`'s `parse`/`walk` (exported, or moved to a small shared module) with
  the same depth ceiling.
- Each row: the topic (when the filter has wildcards), the tested text truncated to one line, and
  a verdict — **fires**, **no**, or **skipped (field missing)** — with `negate` applied, so the
  verdict is the rule's answer and not the regex's.
- **Your own text.** One input under the list; its verdict is shown beside it. Not saved.
- **Empty state.** No filter, or no messages yet: "No messages on this topic yet — type one
  below." The own-text input still works.
- **Errors.** The regex is compiled with `new RegExp(regex)`. If that throws, the tester shows
  "Not a valid expression: <the browser's message>" in place of the verdicts. The editor's own
  validator (`faultsIn`) already refuses an expression the browser cannot compile, so a .NET-only
  construct such as a leading `(?i)` cannot be saved from this form either; the tester and the
  validator agree.
- Live: recomputed on every keystroke; the message list is re-read whenever the rule's topic filter
  changes, and otherwise only when the mount happens or a "Refresh" button is pressed, so the rows
  follow the filter but arriving traffic does not move them under the reader.

### Where existing behaviour is untouched

- `ruleOf` / `draftOf` and the DTO: unchanged. `regex` still goes out exactly as before.
- `firesOn` / `ruleSummary` wording for pattern rules: unchanged (it reads the regex).
- `opaque` conditions: unchanged.

## Testing

- `patternBuilder.test.ts`: each mode writes the regex in the table; escaping of every special
  character; `readPattern` round-trips every builder output; hand-written near-misses
  (`^ERR-[0-9]+`, `foo|bar` unanchored, `^a$b`) read back as regex mode; empty regex → contains.
- `templates.test.ts` (new): every group's type matches each example's condition type (the
  composite groups by their top-level type); titles unique within a group; every draft converts
  with `ruleOf` and passes the editor's validation; groups are in `CONDITION_TYPES` order and
  cover all of them.
- `RuleLibrary.test.tsx`: updated for groups — a heading per kind, chips jump to their group, one
  story open at a time across groups, Use hands over a fresh draft of the right example.
- `ConditionFields.test.tsx`: picking a mode and typing writes the expected regex; opening a rule
  with a hand-written regex shows Regular expression mode with the regex untouched; switching
  modes keeps text as described.
- `PatternTry.test.tsx`: verdicts over seeded log entries for body and field rules, negate
  flipping the verdict, field-missing skip, invalid regex message, empty state.
- Existing a11y sweeps (`a11ySweeps.test.tsx`) must stay green with the new nav and headings.

## Out of scope

- Case-insensitive matching and any other regex options.
- Changing the wire shape or the server.
- Templates for actions (webhook, publish) — the library is about conditions.
- Nested composites in the editor.

import { duration } from '../../lib/format';
import type { AlertCondition, AlertRuleDto, ThresholdOp } from '../../types/api';

/** The comparison as its sign. A word here would be as long as the rest of the line. */
const SIGN: Record<ThresholdOp, string> = {
  gt: '>',
  gte: '≥',
  lt: '<',
  lte: '≤',
  eq: '=',
  neq: '≠',
};

/**
 * What sets a rule off, in one line.
 *
 * For the column in the rules table, which exists because the panel used to say nothing about
 * this at all: a rule was a name and a topic filter, and telling two of them apart meant opening
 * both. It is the shortest true sentence and not the whole condition — the editor holds the whole
 * condition, and a cell that tried to would be a cell nobody reads.
 *
 * Every branch says something. There is no fallback line, because a condition this does not know
 * is a condition the console cannot draw either, and 'unknown' in a table is worse than the type's
 * own name would have been.
 */
export function firesOn(rule: AlertRuleDto): string {
  // The whole payload read as the number, which is what an absent field means to the engine.
  const field = rule.field ?? 'value';

  return say(rule.condition, field);
}

function say(condition: AlertCondition, field: string): string {
  switch (condition.type) {
    case 'threshold':
      return `${field} ${SIGN[condition.op]} ${condition.value}`;

    case 'band':
      // An en dash between the two ends, which is what a range is written with.
      return `${field} ${condition.inside ? 'inside' : 'outside'} ${condition.low}–${condition.high}`;

    case 'pattern':
      return `${condition.negate ? 'does not match' : 'matches'} ${condition.regex}`;

    case 'oneOf':
      // Counted rather than recited: a list of twenty values is not a table cell, and the count
      // is the part a reader is comparing between two rules anyway.
      return `${condition.negate ? 'none' : 'one'} of ${count(condition.values.length, 'value')}`;

    case 'all':
    case 'any':
      return `${condition.type} of ${count(condition.of.length, 'condition')}`;

    case 'silence':
      // The engine counts seconds; `duration` is what every other elapsed figure in the console
      // is written with, so ten minutes reads the same here as it does on the health line.
      return `silent for ${duration(condition.after * 1000)}`;

    case 'outlier':
      // k is the method's own knob and it is only worth the width when it was given.
      return `outlier · ${condition.method}${condition.k ? ` ${condition.k}` : ''}`;

    case 'distributionShift':
      return 'distribution shifts';

    case 'shapeChange':
      return 'shape changes';

    case 'pulse':
      return `${condition.metric} ${SIGN[condition.op]} ${condition.value}`;
  }
}

/** 'one value', '3 values' — the plural earned rather than assumed. */
const count = (many: number, noun: string) => `${many} ${noun}${many === 1 ? '' : 's'}`;

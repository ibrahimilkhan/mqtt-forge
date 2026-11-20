import type { AlertSeverity } from '../../types/api';

/**
 * Which of three levels is the loudest, said as a number so it can be sorted on: loudest first.
 *
 * One table for the whole console. The panel, the rail badge, the wall and the sound each need
 * to know which level wins, and there must not be two answers to 'which of these is the worst' —
 * there were, once, one counting up and one counting down, which is a disagreement waiting for
 * the first edit that touched only one of them.
 */
export const RANK: Record<AlertSeverity, number> = { critical: 0, warn: 1, info: 2 };

/** The loudest of these levels, or nothing when there are none. */
export function loudest(levels: Iterable<AlertSeverity>): AlertSeverity | null {
  let found: AlertSeverity | null = null;

  for (const level of levels) {
    if (found === null || RANK[level] < RANK[found]) found = level;
  }

  return found;
}

import { describe, expect, it } from 'vitest';
import { matchesFilter, treeFilter } from './topicMatch';

describe('matchesFilter', () => {
  it('matches a topic against itself', () => {
    expect(matchesFilter('sensors/room/temp', 'sensors/room/temp')).toBe(true);
  });

  it('rejects a topic that differs in a segment', () => {
    expect(matchesFilter('sensors/room/temp', 'sensors/hall/temp')).toBe(false);
  });

  it('lets + stand in for exactly one segment', () => {
    expect(matchesFilter('sensors/+/temp', 'sensors/room/temp')).toBe(true);
  });

  it('does not let + span two segments', () => {
    expect(matchesFilter('sensors/+', 'sensors/room/temp')).toBe(false);
  });

  it('lets # cover everything beneath it', () => {
    expect(matchesFilter('sensors/#', 'sensors/room/temp')).toBe(true);
  });

  it('lets # cover the level it hangs off, as MQTT does', () => {
    expect(matchesFilter('sensors/#', 'sensors')).toBe(true);
  });

  it('matches every topic against a bare #', () => {
    expect(matchesFilter('#', 'sensors/room/temp')).toBe(true);
  });

  // The specification's rule, and the console keeps it because the broker does: nobody's
  // statistics arrive under '#', which is why Subscribe $SYS is a filter of its own. Without it
  // the two subscriptions the console holds were handed to each other's rules — a colour rule
  // reading '+/broker/#' painted the broker's own tree, and an alert rule with that filter stood
  // an alarm on every load average under it.
  it('keeps a filter that opens with a wildcard off the broker\'s own tree', () => {
    expect(matchesFilter('#', '$SYS/broker/uptime')).toBe(false);
    expect(matchesFilter('+/broker/uptime', '$SYS/broker/uptime')).toBe(false);
  });

  it('reaches that tree for a filter that names it', () => {
    expect(matchesFilter('$SYS/#', '$SYS/broker/uptime')).toBe(true);
    expect(matchesFilter('$SYS/+/uptime', '$SYS/broker/uptime')).toBe(true);
  });

  // The rule is about the first level only: a '$' deeper in a topic is an ordinary segment.
  it('leaves a $ below the first level alone', () => {
    expect(matchesFilter('#', 'plant/$odd/temp')).toBe(true);
    expect(matchesFilter('plant/+/temp', 'plant/$odd/temp')).toBe(true);
  });

  it('rejects a topic shorter than the filter', () => {
    expect(matchesFilter('sensors/room/temp', 'sensors/room')).toBe(false);
  });

  it('rejects a topic on a different branch than #', () => {
    expect(matchesFilter('sensors/#', 'actuators/valve')).toBe(false);
  });

  it('treats an empty filter as matching nothing', () => {
    expect(matchesFilter('', 'sensors')).toBe(false);
  });
});

describe('treeFilter', () => {
  it('turns a tree path into a filter covering the path and its descendants', () => {
    expect(treeFilter('sensors/room')).toBe('sensors/room/#');
  });

  it('keeps a leaf path matching only itself, since it has no descendants', () => {
    expect(matchesFilter(treeFilter('sensors/room/temp'), 'sensors/room/temp')).toBe(true);
    expect(matchesFilter(treeFilter('sensors/room/temp'), 'sensors/room/humidity')).toBe(false);
  });
});

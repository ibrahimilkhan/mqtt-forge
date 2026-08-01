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

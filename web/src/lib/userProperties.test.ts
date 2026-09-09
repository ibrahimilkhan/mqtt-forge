import { describe, expect, it } from 'vitest';
import { parseUserProperties } from './userProperties';

describe('parseUserProperties', () => {
  it('reads a name and a value off each line', () => {
    expect(parseUserProperties('source: console\ntrace: 91a4')).toEqual([
      { name: 'source', value: 'console' },
      { name: 'trace', value: '91a4' },
    ]);
  });

  it('splits on the first colon, so a value may hold more', () => {
    expect(parseUserProperties('reply: mqtt://broker:1883/x')).toEqual([
      { name: 'reply', value: 'mqtt://broker:1883/x' },
    ]);
  });

  it('takes a line with no colon as a name with nothing after it', () => {
    expect(parseUserProperties('urgent')).toEqual([{ name: 'urgent', value: '' }]);
  });

  it('steps over the blank lines a box collects', () => {
    expect(parseUserProperties('\n\nsource: console\n\n')).toEqual([
      { name: 'source', value: 'console' },
    ]);
  });

  // Half a line, in a box somebody is still typing into.
  it('drops a line that has a value and no name yet', () => {
    expect(parseUserProperties(': console')).toEqual([]);
  });

  it('has nothing to say about an empty box', () => {
    expect(parseUserProperties('')).toEqual([]);
  });
});

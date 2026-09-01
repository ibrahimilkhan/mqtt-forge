import { describe, expect, it } from 'vitest';
import { applyMessage, emptyTree } from '../../lib/topicTree';
import {
  fieldsIn,
  MAX_DEPTH,
  parseBody,
  previewOf,
  reachableKey,
  samplesFor,
  type Json,
} from './payloadFields';

const at = (paths: ReturnType<typeof fieldsIn>) => paths.fields.map((one) => one.path);

describe('parseBody', () => {
  it('reads an object and an array', () => {
    expect(parseBody('{"a":1}')).toEqual({ a: 1 });
    expect(parseBody(' [1,2] ')).toEqual([1, 2]);
  });

  it('refuses a bare reading, which is not a document', () => {
    expect(parseBody('23.5')).toBeNull();
    expect(parseBody('"a string"')).toBeNull();
    expect(parseBody('')).toBeNull();
  });

  it('refuses a body that opens like a document and is not one', () => {
    expect(parseBody('{"a":')).toBeNull();
  });
});

describe('fieldsIn', () => {
  it('names every leaf the way the spec writes a path', () => {
    const body: Json = { temp: 21.5, radios: [{ crc: 3 }, { crc: 4 }], ok: true, spare: null };

    expect(at(fieldsIn(body))).toEqual([
      '$.temp',
      '$.radios[0].crc',
      '$.radios[1].crc',
      '$.ok',
      '$.spare',
    ]);
  });

  it('says what kind each value is, so the picker can hint at a condition', () => {
    const { fields } = fieldsIn({ n: 1, s: 'x', b: false, z: null });

    expect(fields.map((one) => one.kind)).toEqual(['number', 'text', 'flag', 'null']);
  });

  it('previews a string without the quotation marks the engine never compares', () => {
    const { fields } = fieldsIn({ state: 'RUNNING' });

    expect(fields[0].preview).toBe('RUNNING');
  });

  it('offers nothing for the document itself — an empty Field box already means that', () => {
    expect(at(fieldsIn(21.5))).toEqual([]);
  });

  it('stops where the server stops, so no path is offered that it would refuse', () => {
    // Seven levels of nesting; the leaf sits one step past the ceiling.
    let body: Json = 'deep';
    for (let level = 0; level <= MAX_DEPTH; level++) body = { down: body } as Json;

    const found = at(fieldsIn(body));

    expect(found).toEqual([]);

    // One level shallower is exactly at the ceiling, and is offered.
    let shallower: Json = 'deep';
    for (let level = 0; level < MAX_DEPTH; level++) shallower = { down: shallower } as Json;

    expect(at(fieldsIn(shallower))).toEqual(['$.down.down.down.down.down.down']);
  });

  it('leaves out a key no path could name, and counts it', () => {
    const { fields, skipped } = fieldsIn({ 'cpu.temp': 61, '': 1, 'a[0]': 2, plain: 3 });

    expect(fields.map((one) => one.path)).toEqual(['$.plain']);
    expect(skipped).toBe(3);
  });

  it('counts an unreachable branch once, not once per leaf under it', () => {
    const { skipped } = fieldsIn({ 'a.b': { one: 1, two: 2, three: 3 } });

    expect(skipped).toBe(1);
  });

  it('indents by how many steps down a value is', () => {
    const { fields } = fieldsIn({ top: 1, nest: { deeper: 2 } });

    expect(fields.map((one) => ({ path: one.path, depth: one.depth }))).toEqual([
      { path: '$.top', depth: 1 },
      { path: '$.nest.deeper', depth: 2 },
    ]);
  });
});

describe('reachableKey', () => {
  it('refuses the characters the path syntax spends on structure', () => {
    expect(reachableKey('temp')).toBe(true);
    expect(reachableKey('cpu.temp')).toBe(false);
    expect(reachableKey('a[0]')).toBe(false);
    expect(reachableKey('a]')).toBe(false);
    expect(reachableKey('')).toBe(false);
  });
});

describe('previewOf', () => {
  it('shortens a value that would not fit beside its path', () => {
    const long = previewOf('x'.repeat(80));

    expect(long).toHaveLength(48);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('samplesFor', () => {
  const tree = () => {
    let root = emptyTree();
    root = applyMessage(root, 'plant/a/temp', '{"temp":1}', 100);
    root = applyMessage(root, 'plant/b/temp', '{"temp":2}', 300);
    root = applyMessage(root, 'plant/c/temp', '23.5', 400);
    root = applyMessage(root, 'other/thing', '{"temp":3}', 500);
    return root;
  };

  it('offers only topics the filter covers', () => {
    expect(samplesFor(tree(), 'plant/+/temp').map((one) => one.topic)).toEqual([
      'plant/b/temp',
      'plant/a/temp',
    ]);
  });

  it('leaves out a topic whose body is not a document — it has no fields to pick', () => {
    expect(samplesFor(tree(), '#').map((one) => one.topic)).not.toContain('plant/c/temp');
  });

  it('leads with the topic that spoke most recently', () => {
    expect(samplesFor(tree(), '#')[0].topic).toBe('other/thing');
  });

  it('stops at the limit it is given', () => {
    expect(samplesFor(tree(), '#', 1)).toHaveLength(1);
  });
});

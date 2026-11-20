import { describe, expect, it } from 'vitest';
import type { LogEntry } from '../../stores/logStore';
import { compilePattern, recentTexts, textAt, verdictOf } from './patternTry';

describe('the text a rule tests', () => {
  it('is the body itself when the rule names no field', () => {
    expect(textAt('ERR-502 disk', '')).toBe('ERR-502 disk');
    expect(textAt('{"a":1}', '')).toBe('{"a":1}');
  });

  it('is a string field without its quotes, and any other value as JSON', () => {
    const body = '{"msg":"timeout","n":3,"ok":true,"none":null,"inner":{"x":[1,2]}}';

    expect(textAt(body, 'msg')).toBe('timeout');
    expect(textAt(body, 'n')).toBe('3');
    expect(textAt(body, 'ok')).toBe('true');
    expect(textAt(body, 'none')).toBe('null');
    expect(textAt(body, 'inner')).toBe('{"x":[1,2]}');
  });

  it('walks paths as the server does: dots, brackets, a leading $, and indexes on arrays', () => {
    const body = '{"a":{"b":[{"c":"deep"}]},"list":["zero","one"]}';

    expect(textAt(body, 'a.b[0].c')).toBe('deep');
    expect(textAt(body, '$.a.b[0].c')).toBe('deep');
    expect(textAt(body, 'list.1')).toBe('one');
    expect(textAt(body, 'list[1]')).toBe('one');
  });

  it('is missing when the field is not there, or there is no document to look in', () => {
    expect(textAt('{"a":1}', 'b')).toBeNull();
    expect(textAt('{"list":[1]}', 'list[5]')).toBeNull();
    expect(textAt('23.5', 'value')).toBeNull();
    expect(textAt('{broken', 'a')).toBeNull();
    expect(textAt('{"a":1}', 'a..b')).toBeNull();
  });

  it('stops at the depth the server stops at', () => {
    const body = '{"a":{"a":{"a":{"a":{"a":{"a":{"a":"seven"}}}}}}}';

    expect(textAt(body, 'a.a.a.a.a.a')).not.toBeNull();
    expect(textAt(body, 'a.a.a.a.a.a.a')).toBeNull();
  });
});

describe('the verdict', () => {
  const error = /ERROR/;

  it("is the rule's answer, with negate applied", () => {
    expect(verdictOf(error, false, 'an ERROR here')).toBe('fires');
    expect(verdictOf(error, false, 'all fine')).toBe('quiet');
    expect(verdictOf(error, true, 'all fine')).toBe('fires');
    expect(verdictOf(error, true, 'an ERROR here')).toBe('quiet');
  });

  it("is a skip, never a match or a miss, when the field is missing", () => {
    expect(verdictOf(error, false, null)).toBe('skipped');
    expect(verdictOf(error, true, null)).toBe('skipped');
  });

  it('compiles an expression, or says why the browser cannot', () => {
    expect(compilePattern('^ERR').ok).toBe(true);

    const bad = compilePattern('([');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.message).not.toBe('');
  });
});

describe('the recent texts', () => {
  let id = 0;
  const entry = (topic: string, body: string, mode?: 'hex'): LogEntry => ({
    id: (id += 1),
    kind: 'recv',
    at: new Date(),
    topic,
    body,
    mode,
  });

  it('keeps each distinct text once, newest first, up to the limit', () => {
    const entries = [
      entry('d/1/log', 'c'),
      entry('d/1/log', 'b'),
      entry('d/1/log', 'c'),
      entry('d/2/log', 'c'),
      entry('d/1/log', 'a'),
    ];

    expect(recentTexts(entries, '', 3)).toEqual([
      { topic: 'd/1/log', text: 'c' },
      { topic: 'd/1/log', text: 'b' },
      { topic: 'd/2/log', text: 'c' },
    ]);
  });

  it('reads the field out of each, and leaves out binary bodies', () => {
    const entries = [entry('t', '{"msg":"x"}'), entry('t', '{"other":1}'), entry('t', '00 ff', 'hex')];

    expect(recentTexts(entries, 'msg')).toEqual([
      { topic: 't', text: 'x' },
      { topic: 't', text: null },
    ]);
  });
});

import { describe, expect, it } from 'vitest';
import { modeOf, readPattern, regexOf, switchMode, textFor, type WordMode } from './patternBuilder';

describe('writing a regex from words', () => {
  it.each([
    ['contains', 'ERROR', 'ERROR'],
    ['startsWith', 'ERR-', '^ERR-'],
    ['endsWith', 'timeout', 'timeout$'],
    ['exactly', 'OFFLINE', '^OFFLINE$'],
    ['anyWord', 'fault\noffline', '^(?:fault|offline)$'],
  ] as const)('%s %j writes %j', (mode, text, regex) => {
    expect(regexOf(mode, text)).toBe(regex);
  });

  it('escapes every character a regex would read as syntax', () => {
    expect(regexOf('contains', '\\^$.|?*+()[]{}')).toBe('\\\\\\^\\$\\.\\|\\?\\*\\+\\(\\)\\[\\]\\{\\}');
    expect(regexOf('startsWith', '2.')).toBe('^2\\.');
  });

  it('writes nothing for no text, whatever the mode', () => {
    for (const mode of ['contains', 'startsWith', 'endsWith', 'exactly', 'anyWord'] as const) {
      expect(regexOf(mode, '')).toBe('');
    }
    expect(regexOf('anyWord', '\n  \n')).toBe('');
  });

  it('trims the words of a list and drops the blank lines', () => {
    expect(regexOf('anyWord', ' fault \n\n offline\n')).toBe('^(?:fault|offline)$');
  });
});

describe('reading a regex back into words', () => {
  const modes: WordMode[] = ['contains', 'startsWith', 'endsWith', 'exactly', 'anyWord'];
  const texts = ['ERROR', 'a.b', '2.', 'x|y', 'fault\noffline', '$5 (net)'];

  it('reads back every regex the builder can write, as the mode and text that wrote it', () => {
    for (const mode of modes) {
      for (const text of texts) {
        const regex = regexOf(mode, text);
        if (mode !== 'anyWord' && text.includes('\n')) continue;

        const read = readPattern(regex);
        expect(regexOf(read.mode as WordMode, read.text)).toBe(regex);
      }
    }
    expect(readPattern('^OFFLINE$')).toEqual({ mode: 'exactly', text: 'OFFLINE' });
    expect(readPattern('^(?:fault|offline)$')).toEqual({ mode: 'anyWord', text: 'fault\noffline' });
    expect(readPattern('^2\\.')).toEqual({ mode: 'startsWith', text: '2.' });
  });

  it.each(['^ERR-[0-9]+', 'foo|bar', '^a$b', 'a\\d', 'x$y', '\\'])(
    'leaves %j, which no mode writes, as a regular expression',
    (regex) => {
      expect(readPattern(regex)).toEqual({ mode: 'regex', text: regex });
    },
  );

  it('reads an empty regex as contains with no text', () => {
    expect(readPattern('')).toEqual({ mode: 'contains', text: '' });
  });

  it('says which text writes a regex in a given mode, or that none does', () => {
    expect(textFor('contains', 'ERROR')).toBe('ERROR');
    expect(textFor('startsWith', 'ERROR')).toBeNull();
    expect(textFor('endsWith', 'a\\$')).toBeNull();
    expect(textFor('endsWith', 'a\\$$')).toBe('a$');
  });
});

describe('which mode is drawn', () => {
  it('keeps the chosen mode while it still writes the regex, and an empty one always', () => {
    expect(modeOf('startsWith', '')).toBe('startsWith');
    expect(modeOf('regex', '^OFF$')).toBe('regex');
    expect(modeOf('contains', 'OFF')).toBe('contains');
  });

  it('follows the regex when it was changed from outside, as a template or a reload does', () => {
    expect(modeOf('contains', '^OFF$')).toBe('exactly');
    expect(modeOf('startsWith', '[0-9]+')).toBe('regex');
  });
});

describe('changing the mode', () => {
  it('carries the text across the single-text modes', () => {
    expect(switchMode('ERROR', 'contains', 'startsWith')).toBe('^ERROR');
    expect(switchMode('^ERROR', 'startsWith', 'exactly')).toBe('^ERROR$');
  });

  it('takes one word into a list, and the first word of a list out of it', () => {
    expect(switchMode('^OFF$', 'exactly', 'anyWord')).toBe('^(?:OFF)$');
    expect(switchMode('^(?:fault|offline)$', 'anyWord', 'contains')).toBe('fault');
  });

  it('keeps the regex going into regular expression mode', () => {
    expect(switchMode('^ERR-', 'startsWith', 'regex')).toBe('^ERR-');
  });

  it('reads the words out of a regex leaving regular expression mode, or starts empty', () => {
    expect(switchMode('^ERR-', 'regex', 'endsWith')).toBe('ERR-$');
    expect(switchMode('^ERR-[0-9]+', 'regex', 'contains')).toBe('');
  });
});

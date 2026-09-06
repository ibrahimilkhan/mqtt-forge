import { describe, expect, it } from 'vitest';
import { carries, fold, found } from './sift';

describe('carries', () => {
  it('matches a plain substring whatever the casing', () => {
    expect(carries('plant/boiler/temp', 'BOILER')).toBe(true);
    expect(carries('plant/boiler/temp', 'burner')).toBe(false);
  });

  it('takes an empty search as matching everything, and no text as matching nothing', () => {
    expect(carries('anything', '')).toBe(true);
    expect(carries(null, 'x')).toBe(false);
    expect(carries(undefined, 'x')).toBe(false);
  });

  /**
   * The case this file was written for. A Turkish broker's topics are written in both alphabets —
   * a device says FABRİKA and the file beside it says fabrika — and a reader who types one of
   * them is looking for both. Invariant lowercasing answers three of these four and looks like it
   * answered all four.
   */
  describe('the Turkish letters', () => {
    it('finds the dotted capital İ from an ordinary i, and back', () => {
      expect(carries('FABRİKA/hat1/sicaklik', 'fabrika')).toBe(true);
      expect(carries('fabrika/hat2/sicaklik', 'FABRİKA')).toBe(true);
    });

    it('finds the dotless ı from an ordinary i, and back', () => {
      expect(carries('ısparta/depo/nem', 'isparta')).toBe(true);
      expect(carries('ISPARTA/depo/nem', 'İSPARTA')).toBe(true);
      expect(carries('ısparta/depo/nem', 'İSPARTA')).toBe(true);
    });

    it('finds a word written with marks from one typed without them', () => {
      expect(carries('ev/salon/sıcaklık', 'sicaklik')).toBe(true);
      expect(carries('okul/öğretmen', 'ogretmen')).toBe(true);
      expect(carries('depo/şube/çıkış', 'sube')).toBe(true);
    });

    it('still refuses a word that is not there', () => {
      expect(carries('ev/salon/sıcaklık', 'basinc')).toBe(false);
    });
  });

  it('folds other Latin diacritics the same way, since the rule is one rule', () => {
    expect(carries('café/münchen', 'cafe')).toBe(true);
    expect(carries('café/münchen', 'munchen')).toBe(true);
  });
});

describe('fold', () => {
  it('leaves ASCII alone but for its case', () => {
    expect(fold('Plant/Boiler')).toBe('plant/boiler');
    expect(fold('')).toBe('');
  });

  it('brings both spellings of the Turkish i to the same letter', () => {
    expect(fold('İ')).toBe(fold('i'));
    expect(fold('I')).toBe(fold('ı'));
    expect(fold('FABRİKA')).toBe(fold('fabrika'));
  });

  it('keeps a topic the same length in levels, whatever it carries', () => {
    expect(fold('a/ı/İ/b').split('/')).toHaveLength(4);
  });
});

describe('found', () => {
  it('looks where the reader aimed it', () => {
    const row = { topic: 'ev/salon/sıcaklık', body: '21.5' };

    expect(found(row, 'sicaklik', 'topic')).toBe(true);
    expect(found(row, 'sicaklik', 'body')).toBe(false);
    expect(found(row, 'sicaklik', 'both')).toBe(true);
    expect(found(row, '21', 'body')).toBe(true);
  });
});

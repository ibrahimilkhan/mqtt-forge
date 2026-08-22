import { describe, expect, it } from 'vitest';
import { appendFilter, chunkFilters, MAX_PER_BATCH, parseFilters } from './parseFilters';

describe('parseFilters', () => {
  it('reads a single filter as one', () => {
    expect(parseFilters('sensors/#')).toEqual(['sensors/#']);
  });

  it('splits on newlines, the shape a pasted list arrives in', () => {
    expect(parseFilters('sensors/#\nlab/+/temp')).toEqual(['sensors/#', 'lab/+/temp']);
  });

  it('splits on commas too', () => {
    expect(parseFilters('a/#, b/#')).toEqual(['a/#', 'b/#']);
  });

  it('drops blank lines and stray whitespace', () => {
    expect(parseFilters('  a/#  \n\n\n , , b/# ')).toEqual(['a/#', 'b/#']);
  });

  // Subscribing twice is a no-op at the broker, but it inflates the batch and the chip list.
  it('keeps each filter once', () => {
    expect(parseFilters('a/#\nb/#\na/#')).toEqual(['a/#', 'b/#']);
  });

  it('finds nothing in an empty box', () => {
    expect(parseFilters('   \n  ')).toEqual([]);
  });
});

describe('chunkFilters', () => {
  it('leaves a list that already fits in one packet alone', () => {
    expect(chunkFilters(['a', 'b'], 10)).toEqual([['a', 'b']]);
  });

  it('splits a longer list into packets of the given size', () => {
    expect(chunkFilters(['a', 'b', 'c', 'd', 'e'], 2)).toEqual([['a', 'b'], ['c', 'd'], ['e']]);
  });

  it('defaults to the size the broker was measured to take happily', () => {
    const filters = Array.from({ length: MAX_PER_BATCH + 1 }, (_, i) => `f${i}`);

    const chunks = chunkFilters(filters);

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(MAX_PER_BATCH);
  });

  it('makes no packets out of nothing', () => {
    expect(chunkFilters([])).toEqual([]);
  });
});

// Clicking a chip or a topic writes into the same box the reader types in, so what it writes has
// to survive whatever is already there — including nothing, and including the same filter twice.
describe('appendFilter', () => {
  it('puts a filter into an empty box on its own', () => {
    expect(appendFilter('', 'sensors/#')).toBe('sensors/#');
  });

  it('adds to what is already there on a line of its own', () => {
    expect(appendFilter('sensors/#', 'plant/+/temp')).toBe('sensors/#\nplant/+/temp');
  });

  // The box takes a list, and a reader clicking four topics means four filters, not four
  // clicks fighting over one line.
  it('keeps adding as the reader keeps clicking', () => {
    const built = ['a/#', 'b/#', 'c/#'].reduce(appendFilter, '');

    expect(built).toBe('a/#\nb/#\nc/#');
  });

  it('does not add a filter the box already holds', () => {
    expect(appendFilter('sensors/#\nplant/#', 'sensors/#')).toBe('sensors/#\nplant/#');
  });

  // The same filter typed with a comma is still the same filter.
  it('reads what is there the way the box itself does', () => {
    expect(appendFilter('sensors/#, plant/#', 'plant/#')).toBe('sensors/#, plant/#');
  });

  it('does not leave a blank line behind a box that ends in one', () => {
    expect(appendFilter('sensors/#\n', 'plant/#')).toBe('sensors/#\nplant/#');
  });

  it('ignores a click carrying nothing', () => {
    expect(appendFilter('sensors/#', '  ')).toBe('sensors/#');
  });
});

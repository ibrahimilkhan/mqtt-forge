import { DISPLAY_UNITS, type DisplayUnit } from './units';

/** Metres per unit a reader may type after a number in a length field. */
const LENGTH_UNITS: Record<string, number> = { mm: 0.001, cm: 0.01, m: 1, in: 0.0254, '"': 0.0254 };

const TOKENS = /\d*\.?\d+(?:e[+-]?\d+)?\s*(?:mm|cm|in|m|")?|[-+*/()]|\S/gi;
const NUMBER = /^(\d*\.?\d+(?:e[+-]?\d+)?)\s*(mm|cm|in|m|")?$/i;
const RELATIVE = /^(\+=|-=|\*=|\/=|\+)/;

/**
 * Works out what a reader typed into a number field: arithmetic, a change relative to the value
 * already there ('+50', '-=20', '*=2'), and in length fields a unit after any number ('10cm+2mm'),
 * answered in the display unit. NaN for anything else — the field then goes back to what it held.
 *
 * A small recursive-descent parser rather than eval: the text comes from an input box.
 */
export function evalExpr(
  text: string,
  { current = 0, length = false, unit = 'm' }: { current?: number; length?: boolean; unit?: DisplayUnit } = {},
): number {
  let source = text.trim().replace(/,/g, '.').replace(/°/g, '');
  if (!source) return Number.NaN;

  let relative: string | null = null;
  const prefix = source.match(RELATIVE);
  if (prefix) {
    relative = prefix[1] === '+' ? '+=' : prefix[1];
    source = source.slice(prefix[1].length);
  }

  const tokens = source.match(TOKENS) ?? [];
  let at = 0;
  const peek = () => tokens[at];

  const factor = (): number => {
    const token = tokens[at++];
    if (token === '(') {
      const inner = sum();
      return tokens[at++] === ')' ? inner : Number.NaN;
    }
    if (token === '-') return -factor();
    if (token === '+') return factor();

    const match = token?.match(NUMBER);
    if (!match) return Number.NaN;

    const value = Number.parseFloat(match[1]);
    if (!match[2]) return value;
    if (!length) return Number.NaN;
    return value * LENGTH_UNITS[match[2].toLowerCase()] * DISPLAY_UNITS[unit].factor;
  };

  const product = (): number => {
    let value = factor();
    while (peek() === '*' || peek() === '/') value = tokens[at++] === '*' ? value * factor() : value / factor();
    return value;
  };

  const sum = (): number => {
    let value = product();
    while (peek() === '+' || peek() === '-') value = tokens[at++] === '+' ? value + product() : value - product();
    return value;
  };

  let value = sum();
  if (at !== tokens.length || !Number.isFinite(value)) return Number.NaN;

  if (relative === '+=') value = current + value;
  else if (relative === '-=') value = current - value;
  else if (relative === '*=') value = current * value;
  else if (relative === '/=') value = current / value;

  return Number.isFinite(value) ? value : Number.NaN;
}

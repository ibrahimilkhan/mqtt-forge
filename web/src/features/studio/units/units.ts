/**
 * The scene is always metres; this is the one place a length becomes what the reader chose to read
 * it in. DesignBox had three formatters for this and two of them ignored the choice, so the HUD
 * and the inspector could disagree about one distance — there is one now, and everything uses it.
 */
export type DisplayUnit = 'mm' | 'cm' | 'm' | 'in';

export const DISPLAY_UNITS: Record<DisplayUnit, { factor: number; label: string; digits: number }> = {
  mm: { factor: 1000, label: 'mm', digits: 2 },
  cm: { factor: 100, label: 'cm', digits: 3 },
  m: { factor: 1, label: 'm', digits: 4 },
  in: { factor: 1 / 0.0254, label: 'in', digits: 3 },
};

export const toDisplay = (metres: number, unit: DisplayUnit) => metres * DISPLAY_UNITS[unit].factor;
export const fromDisplay = (value: number, unit: DisplayUnit) => value / DISPLAY_UNITS[unit].factor;

/** Rounded, and through Number so trailing zeros go: 1.50 is 1.5. */
export const roundTo = (value: number, digits: number) => Number(value.toFixed(digits));

export const formatLength = (metres: number, unit: DisplayUnit, digits = DISPLAY_UNITS[unit].digits) =>
  `${roundTo(toDisplay(metres, unit), digits)} ${DISPLAY_UNITS[unit].label}`;

export const radToDeg = (rad: number) => (rad * 180) / Math.PI;
export const degToRad = (deg: number) => (deg * Math.PI) / 180;

export const formatAngle = (rad: number, digits = 2) => `${roundTo(radToDeg(rad), digits)}°`;

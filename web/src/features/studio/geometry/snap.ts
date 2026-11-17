/** To the nearest multiple of `step`; a step of zero or less means no snapping. */
export const snapTo = (value: number, step: number) => (step > 0 ? Math.round(value / step) * step : value);

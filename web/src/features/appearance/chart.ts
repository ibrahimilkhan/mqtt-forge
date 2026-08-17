/**
 * How much of the chart to draw.
 *
 * The same run of readings answers different questions for different readers. Someone watching a
 * device come up wants a glance at whether the line is moving; someone chasing a fault wants the
 * spread, the outliers and the shape; someone deciding whether a sensor is behaving wants both
 * views at once. One of these is not a better default than the others — it depends who is at the
 * keyboard, so it is theirs to set, next to the fonts.
 */
export const CHART_DETAIL = {
  plain: {
    label: 'Plain — the line alone',
    note: false,
    controls: false,
    marks: false,
    histogram: false,
  },
  full: {
    label: 'Full — line, marks and statistics',
    note: true,
    controls: true,
    marks: true,
    histogram: false,
  },
  deep: {
    label: 'Deep — both views, quartiles and fences',
    note: true,
    controls: true,
    marks: true,
    histogram: true,
  },
} as const;

export type ChartDetailId = keyof typeof CHART_DETAIL;

export const CHART_DETAIL_DEFAULT: ChartDetailId = 'full';

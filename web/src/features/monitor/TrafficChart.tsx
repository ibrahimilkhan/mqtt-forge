import { useMemo, useState } from 'react';
import { chartable } from '../../lib/chartable';
import { fitDistribution } from '../../lib/distribution';
import { above, branchesUnder, named } from '../../lib/fieldTree';
import { domainFor, SCALES, type ScaleId } from '../../lib/scale';
import { numericFields, sampleOfRuns, type Series } from '../../lib/series';
import { shapeOf } from '../../lib/shape';
import { cadence, changePoint, cycle, summarise } from '../../lib/stats';
import { useNow } from '../../lib/useNow';
import { useRuleLookup } from '../../lib/useRuleLookup';
import { Download, Fold, Unfold } from '../brand/icons';
import { CHIP, CONTROLS } from '../appearance/controls';
import type { ReadingId } from '../appearance/readings';
import { useAppearanceStore } from '../../stores/appearanceStore';
import type { LogEntry } from '../../stores/logStore';
import { ChartNote } from './ChartNote';
import { ChartVoid } from './ChartVoid';
import { TrafficHistogram } from './TrafficHistogram';
import { TrafficLine } from './TrafficLine';
import { TrafficMultiples } from './TrafficMultiples';
import { useExport } from './useExport';
import styles from './TrafficChart.module.css';

type View = 'time' | 'distribution';

/** Periods of silence before a topic with a rhythm counts as having stopped. */
const SILENT_AFTER = 3;

/**
 * The chart over the entries, and what to do with it.
 *
 * Everything here is a question about the same run of readings: which topic of a branch to
 * follow, which field of the message, whether to read it in order or as a distribution, how much
 * of the plot's height to spend on the range — and how to get the run out of the console and into
 * whatever the reader actually analyses in.
 */
export function TrafficChart({
  runs,
  frozen = false,
}: {
  /** The traffic as one run per topic, which is what a chart of a branch draws. */
  runs: LogEntry[][];
  /** The pane is being held still, so the run on show is not the run arriving. */
  frozen?: boolean;
}) {
  // undefined means 'whichever field the run is mostly about'; a string picks one; null is the
  // body itself. Reset by the remount the pane does when the selection changes.
  const [field, setField] = useState<string | null | undefined>(undefined);
  const [view, setView] = useState<View>('time');
  // Null follows the run: the setting decides for measurements, and a pulse train overrides it,
  // since a pulse's peak *is* the reading and a range that clipped it would clip the signal.
  const [range, setRange] = useState<ScaleId | null>(null);
  // One topic out of a branch, once the reader has clicked into it.
  const [focus, setFocus] = useState<string | null>(null);
  const ruleOf = useRuleLookup();
  const preferred = useAppearanceStore((state) => state.scale);
  const readings = useAppearanceStore((state) => state.readings);

  // A topic clicked into is one of the runs already, so this picks rather than walks: the
  // branch's other thousands of topics are not touched to find it.
  const narrowed = useMemo(
    () => (focus ? runs.filter((run) => run[0]?.topic === focus) : runs),
    [runs, focus],
  );
  // A focused topic that has fallen out of the log takes the pane back to the branch rather than
  // leaving it looking at nothing.
  const shown = narrowed.length > 0 ? narrowed : runs;

  const fields = useMemo(() => numericFields(sampleOfRuns(shown)), [shown]);
  const drawn = useMemo(() => chartable(shown, field), [shown, field]);

  const controls = (
    <Controls
      fields={fields}
      field={drawn.kind === 'one' ? drawn.series.field : field}
      onField={setField}
      view={view}
      onView={setView}
      range={range}
      onRange={setRange}
      offerViews={drawn.kind === 'one'}
      // Nothing drawn, nothing to scale: four chips offering to change the range of a sentence.
      offerRanges={drawn.kind !== 'none'}
      series={drawn.kind === 'one' ? drawn.series : null}
      // The way back out of a topic the reader clicked into, in the place the way in was.
      branch={focus}
      onBranch={() => setFocus(null)}
    />
  );

  if (drawn.kind === 'none') {
    return (
      <figure className={styles.chart} data-testid="chart" data-detail="void">
        {controls}
        <ChartVoid reason={drawn.reason} onField={setField} fields={fields} />
      </figure>
    );
  }

  if (drawn.kind === 'many') {
    return (
      <figure className={styles.chart} data-testid="chart" data-detail="many">
        {controls}
        <TrafficMultiples
          series={drawn.series}
          more={drawn.more}
          scale={range ?? preferred}
          colourOf={(topic) => ruleOf(topic)?.colour}
          onFocus={setFocus}
        />
      </figure>
    );
  }

  return (
    <Single
      series={drawn.series}
      view={view}
      range={range}
      preferred={preferred}
      frozen={frozen}
      colour={ruleOf(drawn.series.topic)?.colour}
      controls={controls}
      readings={readings}
    />
  );
}

function Single({
  series,
  view,
  range,
  preferred,
  frozen,
  colour,
  controls,
  readings,
}: {
  series: Series;
  view: View;
  range: ScaleId | null;
  preferred: ScaleId;
  frozen: boolean;
  colour?: string;
  controls: React.ReactNode;
  readings: Partial<Record<ReadingId, boolean>>;
}) {
  // Held against the readings rather than the render: a pointer moving across the plot must not
  // re-run a goodness-of-fit test on five thousand values for every pixel it crosses.
  const stats = useMemo(() => {
    const values = series.readings.map((reading) => reading.value);
    const summary = summarise(values)!;
    const shape = shapeOf(series.readings, summary);

    return {
      values,
      summary,
      shape,
      fit: fitDistribution(values),
      pace: cadence(series.readings.map((reading) => reading.at)),
      // Neither is a reading about a switch: a door has no trend and no period worth the name,
      // and a change-point over two levels finds one on every other click of it.
      step: shape.id === 'continuous' ? changePoint(values) : null,
      period: shape.id === 'continuous' ? cycle(values) : null,
    };
  }, [series]);

  // What the reader asked for, unless the run is one whose peaks are the point. A pulse clipped
  // to its typical range is a flat line with the events shaved off the top — the one drawing
  // that would be worse than useless.
  const scale = range ?? (stats.shape.id === 'continuous' ? preferred : 'extremes');
  const domain = useMemo(
    () => domainFor(stats.values, stats.summary, scale),
    [stats.values, stats.summary, scale],
  );

  // A topic that publishes on a period is a topic whose silence means something, and how long a
  // silence has to be before it does is the period itself. Checked on a beat, since nothing
  // arriving is exactly the case where nothing prompts a redraw. No faster than a second, and no
  // slower than half a minute: this is a warning, not a stopwatch.
  // Not while held: the newest reading on show then gets older by the second while the topic may
  // be publishing perfectly well behind the hold, and an alarm would be about the reader's hand.
  const beat = stats.pace && !frozen ? Math.min(Math.max(stats.pace.every, 1000), 30_000) : null;
  const now = useNow(beat);

  const quiet =
    stats.pace && !frozen ? now - series.readings[series.readings.length - 1].at.getTime() : 0;
  const silence = stats.pace && quiet > stats.pace.every * SILENT_AFTER ? quiet : null;

  return (
    <figure
      className={styles.chart}
      data-testid="chart"
      // The controls, the plot and the note — the plot is the one that stretches.
      data-detail={view === 'distribution' ? 'dist' : 'full'}
      data-shape={stats.shape.id}
      style={colour ? { color: colour } : undefined}
    >
      {controls}

      {view === 'time' && (
        <TrafficLine
          series={series}
          summary={stats.summary}
          domain={domain}
          shape={stats.shape}
          step={stats.step}
          colour={colour}
        />
      )}

      {view === 'distribution' && (
        <TrafficHistogram series={series} summary={stats.summary} colour={colour} />
      )}

      <ChartNote
          summary={stats.summary}
          shape={stats.shape}
          domain={domain}
          fit={stats.fit}
          pace={stats.pace}
          step={stats.step}
          stepAt={stats.step ? series.readings[stats.step.at].at : null}
          period={stats.period}
          skipped={series.skipped}
          sparse={series.sparse}
          of={series.of}
          silence={silence}
          chosen={readings}
        />
    </figure>
  );
}

/**
 * What to chart and how to read it, over the picture rather than under it.
 *
 * These change what the picture *is*, so they are read first — and every one of them is a
 * question the run itself cannot answer: which topic, which field, in order or in aggregate,
 * and how much of the height to spend on the range.
 */
function Controls({
  fields,
  field,
  onField,
  view,
  onView,
  range,
  onRange,
  offerViews,
  offerRanges,
  series,
  branch,
  onBranch,
}: {
  fields: string[];
  field: string | null | undefined;
  onField: (field: string) => void;
  view: View;
  onView: (view: View) => void;
  range: ScaleId | null;
  onRange: (range: ScaleId | null) => void;
  offerViews: boolean;
  offerRanges: boolean;
  series: Series | null;
  branch: string | null;
  onBranch: () => void;
}) {
  const [saved, setSaved] = useState<'idle' | 'done' | 'refused'>('idle');
  /** Which group of fields the chips are standing in. The empty prefix is the top of the body. */
  const [under, setUnder] = useState('');
  const [chooser, setChooser] = useState(true);
  const exporter = useExport();

  // Derived rather than corrected, because the fields change underneath this: clicking into one
  // topic of a branch swaps the whole list, and a prefix left over from the last one would leave
  // the row empty with a back chip as its only content. Falling back to the top costs a line and
  // cannot get stuck.
  const level = useMemo(() => {
    const shown = branchesUnder(fields, under);

    return shown.length > 0 ? { under, shown } : { under: '', shown: branchesUnder(fields, '') };
  }, [fields, under]);

  // Whether this body nests its numbers at all — which decides whether the chip row is a thing
  // that changes as it is used, and so whether it may share a line with anything.
  const deep = useMemo(() => fields.some((name) => name.includes('.')), [fields]);

  // A first save with no folder yet opens the dialog rather than refusing and telling the reader
  // to go and set something up before pressing the button they have just pressed.
  const take = async () => {
    if (!series) return;

    try {
      const where = await exporter.save(fileName(series), csv(series));
      // Null is a dismissed dialog, which is an answer rather than a failure — nothing was
      // written, and saying 'failed' at someone who changed their mind would be a lie.
      setSaved(where === null && exporter.canChoose ? 'idle' : 'done');
    } catch {
      setSaved('refused');
    }
    window.setTimeout(() => setSaved('idle'), 2500);
  };

  const saveLabel = exporter.folder
    ? `Save the readings as CSV into ${exporter.folder}`
    : 'Save the readings as CSV';

  return (
    <div className={styles.controls}>
      {branch && (
        <button
          type="button"
          className={styles.chip}
          aria-label="Back to every topic under the branch"
          title={CONTROLS.branch.what}
          onClick={onBranch}
        >
          {CONTROLS.branch.label}
        </button>
      )}

      {/* One topic can carry a whole environment. Which of its fields is wanted is the reader's
          business, so all of them are on offer and the best covered one leads — but a device that
          reports its whole configuration in one message has forty of them, and forty chips
          reading `broker.session.expiryInterval` are the chart region full of somebody else's
          field names with the chart pushed off the bottom of it.

          So the list is walked rather than shown: one level of segments at a time, a step in and a
          step back out, which is the shape the message already has and the shape the reader is
          holding in their head while they hunt for one number in it. A body with two flat numbers
          in it is unaffected — its top level is both of them. */}
      {fields.length > 1 && (
        <div
          className={styles.fields}
          // A nested body's chip row changes on every step of the walk — six segments, then two,
          // then five — and while it shared a line with the range and the view, every one of
          // those steps slid them along and shunted the plot up or down under the reader's hand.
          // A body whose numbers are flat has a row that never changes, so it keeps the line it
          // has always shared. See .fields[data-deep].
          data-deep={deep ? '' : undefined}
          role="group"
          aria-label="Field to chart"
        >
          {chooser ? (
            <>
              {level.under !== '' && (
                <>
                  <button
                    type="button"
                    className={styles.chip}
                    data-role="up"
                    aria-label={`Back out of ${named(level.under)}`}
                    title={CONTROLS.up.what}
                    onClick={() => setUnder(above(level.under))}
                  >
                    <span className={styles.mark} aria-hidden="true">
                      ←
                    </span>
                    {named(level.under)}
                  </button>
                  {/* The way out is not one of the things that can be picked, so a rule stands
                      between it and them — the same answer the ranges group gives to the same
                      question one group over. */}
                  <span className={styles.split} aria-hidden="true" />
                </>
              )}

              {level.shown.map((branch) =>
                branch.field !== null ? (
                  <button
                    key={branch.segment}
                    type="button"
                    className={styles.chip}
                    aria-label={`Chart ${branch.field}`}
                    aria-pressed={field === branch.field}
                    onClick={() => onField(branch.field!)}
                  >
                    {branch.segment}
                  </button>
                ) : (
                  <button
                    key={branch.segment}
                    type="button"
                    className={styles.chip}
                    data-role="into"
                    aria-label={`Open ${named(branch.under!)}`}
                    title={`${branch.count} field${branch.count === 1 ? '' : 's'} under it`}
                    onClick={() => setUnder(branch.under!)}
                  >
                    {branch.segment}
                    <span className={styles.mark} aria-hidden="true">
                      ›
                    </span>
                  </button>
                ),
              )}

              {/* Away, once the reader has what they came for. The chips are a way in rather than
                  a reading, and a way in that stays open is a way in that has become furniture.

                  A mark, and held against the far end. It was the word 'hide' standing at the end
                  of `channel dbm errors peers txPower`, where it read as one more thing the
                  message carries — a field called hide. Nothing drawn can be mistaken for a field
                  name, and nothing at the other end of the row can be mistaken for part of the
                  list. */}
              <span className={styles.split} data-end aria-hidden="true" />
              <button
                type="button"
                className={styles.chip}
                data-role="aside"
                aria-label="Put the field chips away"
                title={CONTROLS.fewer.what}
                onClick={() => setChooser(false)}
              >
                <Fold />
              </button>
            </>
          ) : (
            /* What is left when they are away: the field being charted, which is the one thing
               the row was still saying that the reader needs. A label rather than a control — the
               way back is the mark beside it, and two controls for one gesture is one of them
               being guessed at. */
            <>
              <span className={styles.chosen}>{field ?? CONTROLS.field.label}</span>
              <span className={styles.split} data-end aria-hidden="true" />
              <button
                type="button"
                className={styles.chip}
                data-role="aside"
                aria-label="Show the field chips"
                title={CONTROLS.fewer.what}
                onClick={() => setChooser(true)}
              >
                <Unfold />
              </button>
            </>
          )}
        </div>
      )}

      {/* How much of the plot's height goes on the range. 'auto' lets the reading decide: the
          setting for measurements, the extremes for anything whose peaks are the signal. */}
      {offerRanges && (
      <div className={styles.ranges} role="group" aria-label="Range to draw">
        <button
          type="button"
          className={styles.chip}
          aria-label="Range to suit the run"
          title={CONTROLS.auto.what}
          aria-pressed={range === null}
          onClick={() => onRange(null)}
        >
          {CONTROLS.auto.label}
        </button>
        {(Object.keys(SCALES) as ScaleId[]).map((id) => (
          <button
            key={id}
            type="button"
            className={styles.chip}
            aria-label={SCALES[id].label}
            title={SCALES[id].hint}
            aria-pressed={range === id}
            onClick={() => onRange(id)}
          >
            {CHIP[id]}
          </button>
        ))}
      </div>
      )}

      <div className={styles.views}>
        {/* Deep draws both, so there is nothing here to choose between. */}
        {offerViews && (
          <>
            <button
              type="button"
              className={styles.chip}
              aria-label="Over time"
              title={CONTROLS.time.what}
              aria-pressed={view === 'time'}
              onClick={() => onView('time')}
            >
              {CONTROLS.time.label}
            </button>
            <button
              type="button"
              className={styles.chip}
              aria-label="Distribution"
              title={CONTROLS.dist.what}
              aria-pressed={view === 'distribution'}
              onClick={() => onView('distribution')}
            >
              {CONTROLS.dist.label}
            </button>
          </>
        )}
        {/* Beside the views, not among them: csv is not another way of reading the run, it is
            the run leaving. */}
        {series && (
          <span className={styles.export}>
            <button
              type="button"
              className={styles.chip}
              aria-label={saveLabel}
              title={CONTROLS.csv.what}
              data-state={saved}
              disabled={exporter.saving || exporter.choosing}
              onClick={take}
            >
              {/* In front of the word rather than instead of it: 'csv' says what the file is and
                  the mark says what the button does, and neither is the other. It goes while the
                  button is reporting — 'saved' and 'failed' are what happened, not what pressing
                  it will do, and a mark that means 'save' standing in front of 'failed' is the
                  button arguing with itself. */}
              {saved === 'idle' && (
                <span className={styles.mark} aria-hidden="true">
                  <Download />
                </span>
              )}
              {{ idle: CONTROLS.csv.label, done: 'saved', refused: 'failed' }[saved]}
            </button>
          </span>
        )}
      </div>
    </div>
  );
}

/** The topic and the field it was charted on, which is what tells two saved runs apart. */
const fileName = (series: Series) =>
  `${series.topic}${series.field ? `-${series.field}` : ''}`;

/** Timestamps in full, so a run pasted into anything else sorts and plots without being fixed. */
function csv(series: Series): string {
  const rows = series.readings.map((reading) => `${reading.at.toISOString()},${reading.value}`);

  return [`time,${series.field ?? series.topic}`, ...rows].join('\n');
}

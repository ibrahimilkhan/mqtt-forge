import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { chartable } from '../../lib/chartable';
import { fitDistribution } from '../../lib/distribution';
import { above, branchesUnder, clip, named } from '../../lib/fieldTree';
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
 * The height a chart region needs before it draws anything beyond the picture.
 *
 * In its column the chart is a glance: a couple of hundred pixels holding a row of chips, a line,
 * and a note of a dozen readings under it. Everything in there is worth having, and all of it at
 * once means the line — the one thing that cannot be read any other way — is left forty pixels to
 * happen in, with the readings about it taking three times the room the run itself gets.
 *
 * So a small region draws the picture and the way to choose what is in it, and nothing else. The
 * readings, the range, the view and csv are not lost: they are what the chart thrown open is
 * *for*, and the control that throws it open is in the corner of the region they left.
 *
 * 220px, which is what the parts actually cost: the note is four rows on a wide pane and seven on
 * a narrow one — 14px a row, 4px between them, 10px above — so 133px at its worst, the controls
 * row is 30px, and the plot's own floor is the 46px `.chart[data-detail]` gives it. It was 300,
 * picked by eye, and 300 is a number the console's own geometry could not reach: a chart thrown
 * open takes three fifths of the window less 62px of chrome, so on a 1366x768 laptop the reader
 * enlarged the chart and got 297px — an enlarged chart with its readings still missing, which is
 * exactly what was reported. Windows cannot violate it either: see MIN_H in floating.ts, which is
 * this number plus that chrome.
 *
 * Height alone: a narrow region makes the chip row scroll, which it is built to do, but no amount
 * of width gives a 46px plot room to be a plot.
 */
const ROOM_FOR_MORE = 220;

/**
 * Whether the region has room for more than the picture.
 *
 * Measured rather than inferred from where the chart is standing, because 'small' is a size and
 * not a place: the column, a window pinned off it and the chart thrown open are all the same
 * component, and a window dragged down to a strip has exactly the problem the column has.
 *
 * A callback ref rather than a ref read once in an effect, and that is the whole of a bug this
 * shipped with. The region is not one element — it is the figure that says there is nothing to
 * draw, the figure that holds a branch's small multiples, or the single chart's own — and the
 * chart swaps between them under its own feet: clicking one plot of a branch replaces a `figure`
 * with a component, which React mounts as a new node. An effect with an empty dependency list was
 * then left observing a node no longer in the document, and a node with no box measures 0: the
 * observer reported 'no room' once and never spoke again, so the chart thrown open never noticed
 * the room it had just been given. Pinning it into a window looked like the cure because a window
 * mounts a chart from scratch. This runs on whichever figure React attaches, each time it
 * attaches a different one.
 *
 * True until something measures, so a runtime with no ResizeObserver draws what it drew before
 * rather than a chart stripped of its readings on the strength of a measurement it never took.
 * The region's height is set by the split above it, never by what is in it, so nothing here can
 * hide the note, shrink the region and bring the note back.
 */
function useRoom() {
  const [roomy, setRoomy] = useState(true);

  // Memoised deliberately: a ref callback made fresh on every render is torn down and rebuilt on
  // every render, which would be a new observer per keystroke of traffic.
  const region = useCallback((measured: HTMLElement | null) => {
    if (!measured || typeof ResizeObserver === 'undefined') return;

    const watch = new ResizeObserver(([entry]) => setRoomy(entry.contentRect.height >= ROOM_FOR_MORE));
    watch.observe(measured);

    return () => watch.disconnect();
  }, []);

  return { region, roomy };
}

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
  const { region, roomy } = useRoom();
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
      offerViews={roomy && drawn.kind === 'one'}
      // Nothing drawn, nothing to scale: four chips offering to change the range of a sentence.
      offerRanges={roomy && drawn.kind !== 'none'}
      // csv goes with them: it is not a way of reading the run either, and a region with no room
      // for the readings has none for a button that writes them to a file.
      series={roomy && drawn.kind === 'one' ? drawn.series : null}
      // The way back out of a topic the reader clicked into, in the place the way in was.
      branch={focus}
      onBranch={() => setFocus(null)}
    />
  );

  if (drawn.kind === 'none') {
    return (
      <figure ref={region} className={styles.chart} data-testid="chart" data-detail="void">
        {controls}
        <ChartVoid reason={drawn.reason} onField={setField} fields={fields} />
      </figure>
    );
  }

  if (drawn.kind === 'many') {
    return (
      <figure ref={region} className={styles.chart} data-testid="chart" data-detail="many">
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
      region={region}
      roomy={roomy}
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
  region,
  roomy,
  series,
  view,
  range,
  preferred,
  frozen,
  colour,
  controls,
  readings,
}: {
  region: React.RefCallback<HTMLElement>;
  /** Whether the region has room for the readings under the picture. */
  roomy: boolean;
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
      ref={region}
      className={styles.chart}
      data-testid="chart"
      // The controls, the plot and the note — the plot is the one that stretches. A region with
      // no room for the note is the controls and the plot, and the plot takes what is left.
      data-detail={!roomy ? 'plain' : view === 'distribution' ? 'dist' : 'full'}
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

      {roomy && (
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
      )}
    </figure>
  );
}

/** How wide the fade at each end of the chip row is, so a chip stepped onto lands clear of it. */
const FADE = 16;

/** The chips themselves. The control that puts the row away is not one of them — it is not in it. */
const chipsOf = (strip: HTMLElement) => [...strip.querySelectorAll<HTMLElement>(':scope > button')];

/**
 * How many chips are off each end of the row, and the way onto them.
 *
 * The row scrolls rather than wraps, because a second line of chips is the plot moving under the
 * hand that is walking the list. What scrolling cost was any way of knowing there was more: the
 * scrollbar is hidden — on the platforms that reserve room for one, its appearing is the very
 * shift the row exists to stop — so the whole signal was sixteen pixels of fade, which reads as
 * an edge rather than as an answer.
 *
 * A count, then, and the same count the log already gives at its fold: `3 →` says there are three
 * more and presses onto them. Counted rather than a bare 'more' for the reason the log counts —
 * the number is what tells a reader whether it is worth the press.
 *
 * Only chips wholly out of sight are counted, so the number never claims one the reader can
 * already read half of.
 */
function useAlong(strip: React.RefObject<HTMLDivElement | null>, walked: string) {
  // Two numbers rather than one object: this sets state on every frame of a scroll, and React
  // bails out on an unchanged number where a fresh { behind, ahead } is always a new object.
  const [behind, setBehind] = useState(0);
  const [ahead, setAhead] = useState(0);

  useLayoutEffect(() => {
    const shelf = strip.current;
    if (!shelf) return;

    // A new level is a new row: a scroll left over from the last one points into the middle of a
    // list whose beginning the reader has not seen.
    shelf.scrollLeft = 0;

    let live = true;
    const recount = () => {
      if (!live) return;
      // A layout nothing has measured puts every chip at zero, which is not the same answer as
      // every chip being out of sight.
      if (shelf.clientWidth === 0) {
        setBehind(0);
        setAhead(0);

        return;
      }

      const box = shelf.getBoundingClientRect();
      let back = 0;
      let on = 0;
      for (const chip of chipsOf(shelf)) {
        const at = chip.getBoundingClientRect();
        // A pixel of slack: scrollLeft is fractional under zoom and on a HiDPI screen, so a row
        // scrolled to its end reads as half a pixel short of it.
        if (at.right <= box.left + 1) back += 1;
        else if (at.left >= box.right - 1) on += 1;
      }
      setBehind(back);
      setAhead(on);
    };

    recount();
    shelf.addEventListener('scroll', recount, { passive: true });
    const watch = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(recount);
    watch?.observe(shelf);
    // The row is mono and the face is swapped in after the first paint, which changes every width
    // in it without changing the row's own box.
    document.fonts?.ready.then(recount);

    return () => {
      live = false;
      shelf.removeEventListener('scroll', recount);
      watch?.disconnect();
    };
  }, [strip, walked]);

  /** A screenful, stopping on a chip's edge, so no step lands with a name cut in half. */
  const along = (way: 1 | -1) => {
    const shelf = strip.current;
    if (!shelf) return;

    const box = shelf.getBoundingClientRect();
    const chips = chipsOf(shelf);
    const off =
      way === 1
        ? chips.find((chip) => chip.getBoundingClientRect().left >= box.right - 1)
        : chips.reverse().find((chip) => chip.getBoundingClientRect().right <= box.left + 1);
    const step = !off
      ? way * shelf.clientWidth
      : way === 1
        ? off.getBoundingClientRect().left - box.left - FADE
        : off.getBoundingClientRect().right - box.right + FADE;

    shelf.scrollBy({ left: step, behavior: 'smooth' });
  };

  return { behind, ahead, along };
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
  const strip = useRef<HTMLDivElement>(null);
  const exporter = useExport();

  // Derived rather than corrected, because the fields change underneath this: clicking into one
  // topic of a branch swaps the whole list, and a prefix left over from the last one would leave
  // the row empty with a back chip as its only content. Falling back to the top costs a line and
  // cannot get stuck.
  const level = useMemo(() => {
    const shown = branchesUnder(fields, under);

    return shown.length > 0 ? { under, shown } : { under: '', shown: branchesUnder(fields, '') };
  }, [fields, under]);

  // Keyed on where the walk is standing and on whether the chips are out at all: both change the
  // row's contents entirely, and a count left over from the last list is a count about nothing.
  const { behind, ahead, along } = useAlong(strip, `${level.under}|${chooser}`);

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
              {/* Only the chips scroll, and only the chips are faded.

                  The control that puts the row away used to be inside the scroller, where two
                  things happened to it: an auto margin cannot hold anything at the end of a box
                  whose free space is negative, so it was simply the last thing in the scroll
                  content and off the end of the row; and the fade, which is painted on the
                  scroller's own edge and never moves, ate its right-hand side. Outside the
                  scroller it is where it says it is. */}
              <span className={styles.shelf}>
                {/* What is behind, and the way back onto it. Absolute, so a count appearing
                    neither narrows the row nor moves a chip along it — and outside the strip,
                    because a mask composites everything inside the box it is painted on,
                    sticky and absolute children included. */}
                {behind > 0 && (
                  <button
                    type="button"
                    className={styles.along}
                    data-side="start"
                    data-testid="along-start"
                    aria-label={`${behind} more, back along the row`}
                    title={CONTROLS.along.what}
                    onClick={() => along(-1)}
                  >
                    ←{behind}
                  </button>
                )}

                <div
                  ref={strip}
                  className={styles.strip}
                  data-testid="field-strip"
                  // Which end has more behind it, which is the end that fades. A row that fits
                  // carries no fade at all, and the chip at a crisp edge is the last one.
                  data-more={[behind && 'start', ahead && 'end'].filter(Boolean).join(' ') || undefined}
                >
              {level.under !== '' && (
                <>
                  <button
                    type="button"
                    className={styles.chip}
                    data-role="up"
                    aria-label={`Back out of ${named(level.under)}`}
                    // Where you are standing is the longest name the row ever holds — it is
                    // every segment walked so far, joined. Clipped like the rest, and the whole
                    // of it is on the chip's title beside what the chip does.
                    title={`${named(level.under)} — ${CONTROLS.up.what}`}
                    onClick={() => setUnder(above(level.under))}
                  >
                    <span className={styles.mark} aria-hidden="true">
                      ←
                    </span>
                    {clip(named(level.under))}
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
                    // Only when the chip is not saying the whole name: a title on every one of
                    // them is a tooltip that follows the pointer down a row it has no business
                    // in, and repeats what the reader can already see.
                    title={clipped(branch.segment) ? branch.field! : undefined}
                    onClick={() => onField(branch.field!)}
                  >
                    {clip(branch.segment)}
                  </button>
                ) : (
                  <button
                    key={branch.segment}
                    type="button"
                    className={styles.chip}
                    data-role="into"
                    aria-label={`Open ${named(branch.under!)}`}
                    title={`${clipped(branch.segment) ? `${branch.segment} — ` : ''}${branch.count} field${branch.count === 1 ? '' : 's'} under it`}
                    onClick={() => setUnder(branch.under!)}
                  >
                    {clip(branch.segment)}
                    <span className={styles.mark} aria-hidden="true">
                      ›
                    </span>
                  </button>
                ),
              )}

                </div>

                {/* What is still ahead. `→` rather than `›`, which is the mark an `into` chip
                    wears: `4 ›` standing among field names reads as a group called 4, which is
                    the mistake the word 'hide' made at the other end of this row. */}
                {ahead > 0 && (
                  <button
                    type="button"
                    className={styles.along}
                    data-side="end"
                    data-testid="along-end"
                    aria-label={`${ahead} more along the row`}
                    title={CONTROLS.along.what}
                    onClick={() => along(1)}
                  >
                    {ahead}→
                  </button>
                )}
              </span>

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
              <span
                className={styles.chosen}
                title={field && clipped(field) ? field : undefined}
              >
                {clip(field ?? CONTROLS.field.label)}
              </span>
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

/** Whether a name is longer than a chip holds, and so is drawn with two dots on the end. */
const clipped = (name: string) => clip(name) !== name;

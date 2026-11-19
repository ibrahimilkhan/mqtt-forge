import { useState } from 'react';
import { PanelShell } from '../../components/PanelShell';
import panel from '../../styles/panel.module.css';
import { SCALES, type ScaleId } from '../../lib/scale';
import { useAppearanceStore } from '../../stores/appearanceStore';
import {
  CONTROL_GROUP_TITLES,
  CONTROL_GROUPS,
  CONTROL_IDS,
  CONTROLS,
  RANGE_CHIPS,
} from '../appearance/controls';
import { useExport } from '../monitor/useExport';
import {
  READING_GROUPS,
  READING_IDS,
  READINGS,
  showsReading,
  type ReadingGroup,
  type ReadingId,
} from '../appearance/readings';
import styles from './ChartPanel.module.css';
import { ChartPreview } from './ChartPreview';
import type { SampleId } from './sample';

const GROUPS = Object.keys(READING_GROUPS) as ReadingGroup[];

/** A range's hint is written to follow a dash — in the chip's name, in the note — so it starts
    lower-case and has no stop. Beside the controls' sentences here it has to be one too. */
const sentence = (hint: string) => `${hint[0].toUpperCase()}${hint.slice(1)}.`;

/** A range's name is the head of its label in the catalogue: 'Typical — fitted to the bulk of
    readings'. The tail says what the hint under it says better, so only the head is printed. */
const named = (id: ScaleId) => SCALES[id].label.split(' — ')[0];

/**
 * What each range does to a run with one stray reading in it, as a line.
 *
 * The three hints are accurate and a reader still has to picture them. Drawn, the difference is
 * the whole picture: the stray takes the plot, the stray is cut off at the edge, the heights are
 * bent. Keyed by the catalogue's own ids, so a range added there does not compile without one.
 */
const SKETCH: Record<ScaleId, string> = {
  extremes: 'M0 26L14 25L28 27L42 26L54 26L60 4L66 26L80 25L94 27L108 26L120 26',
  typical: 'M0 20L14 12L28 26L42 16L54 20L58 1H62L66 20L80 13L94 27L108 17L120 21',
  log: 'M0 34L14 31L28 27L42 22L56 16L70 11L84 7L98 5L108 3L120 2',
};

/** Whether a reading is drawn the way it was shipped, rather than the way the reader left it. */
const asShipped = (id: ReadingId, chosen: Partial<Record<ReadingId, boolean>>) =>
  showsReading(id, chosen) === !READINGS[id].off;

/**
 * The sample chart a reading appears under, when it only appears under one of them.
 *
 * `n` is counted on both and the last group is printed under every chart, so neither has a
 * sample to ask for.
 */
function sampleFor(id: ReadingId): SampleId | null {
  if (id === 'n') return null;
  if (READINGS[id].group === 'quantity') return 'measurement';
  if (READINGS[id].group === 'events') return 'switch';

  return null;
}

const matches = (id: ReadingId, look: string) =>
  look === '' ||
  READINGS[id].label.toLowerCase().includes(look) ||
  READINGS[id].what.toLowerCase().includes(look);

/**
 * Everything about the chart in one place: how much of it to draw, what range to draw it in, what
 * to draw round it, and which of the readings under it are wanted.
 *
 * The readings are the reason this panel exists. The note prints a dozen labels three or four
 * characters long — `n`, `σ` as 'spread', `duty`, `fences` — and a label that short is only
 * readable by someone who already knows what it stands for. The cells carry titles, which is no
 * help to a reader who does not know there is anything to hover. Here every one of them is
 * written out in full, beside the switch that puts it away.
 */
export function ChartPanel({ onClose }: { onClose: () => void }) {
  // No selector: the panel shows every value, so it must re-render on any change.
  const { scale, readings, setScale, toggleReading, resetReadings } = useAppearanceStore();
  const exporter = useExport();

  const [look, setLook] = useState('');
  const [hot, setHot] = useState<ReadingId | null>(null);
  const [sample, setSample] = useState<SampleId>('measurement');
  // Whether the preview's sample was changed by a switch rather than by the reader, so the
  // preview can say so. Without it the picture changes under a hand that was nowhere near it.
  const [moved, setMoved] = useState(false);

  const needle = look.trim().toLowerCase();
  const shown = READING_IDS.filter((id) => showsReading(id, readings)).length;
  const changed = READING_IDS.filter((id) => !asShipped(id, readings)).length;
  const found = READING_IDS.filter((id) => matches(id, needle));

  /** Turning a reading on brings up the sample it appears under: a switch pressed with nothing
      to show for it reads as a switch that is broken. */
  const bring = (wanted: SampleId | null) => {
    if (wanted === null || wanted === sample) return;
    setSample(wanted);
    setMoved(true);
  };

  const toggle = (id: ReadingId, on: boolean) => {
    toggleReading(id, on);
    if (on) bring(sampleFor(id));
  };

  /** Only the ones that are not already there, so a group set all one way stores what changed
      and not a line for every reading in it — the store keeps only what was touched. */
  const setGroup = (group: ReadingGroup, on: boolean) => {
    const moving = READING_IDS.filter(
      (id) => READINGS[id].group === group && showsReading(id, readings) !== on,
    );
    for (const id of moving) toggleReading(id, on);
    if (on) bring(moving.map(sampleFor).find((wanted) => wanted !== null) ?? null);
  };

  const restore = () => {
    resetReadings();
    setMoved(false);
  };

  return (
    <PanelShell title="Chart" named onClose={onClose}>
      {/* A container, so the layout answers to the width the panel has and not the window's: the
          rail beside it opens and shuts, and takes two hundred pixels with it when it does. */}
      <div className={styles.frame}>
        <div className={styles.layout}>
          <div className={styles.settings}>
            {/* Three cards rather than a select. There are three ranges and there will not be
                thirty; a select hid two of them, and printed the one it showed as a label too
                long for the column. Open, each can carry what it does and the chip the chart
                calls it by, so a reader meets `mid` here before meeting it over a plot. */}
            <fieldset className={styles.range}>
              <legend className={styles.heading}>Range</legend>
              {/* The range that is on says what it does under the row, where the cards are too
                  narrow to each carry their own sentence — see `.cards::after`. Handed over as
                  an attribute so it is drawn by the stylesheet that knows when it is needed,
                  and is not a second copy of the hint in the document for a reader to be read
                  twice. */}
              <div className={styles.cards} data-picked={sentence(SCALES[scale].hint)}>
                {RANGE_CHIPS.map((range) => (
                  <label
                    key={range.id}
                    className={styles.card}
                    data-selected={range.id === scale ? '' : undefined}
                  >
                    <span className={styles.cardTop}>
                      {/* Named for the range and described by what it does, like the readings
                          below: 'Typical, radio button' and then the sentence. */}
                      <input
                        type="radio"
                        name="chart-range"
                        value={range.id}
                        aria-labelledby={`range-${range.id}`}
                        aria-describedby={`range-what-${range.id}`}
                        checked={range.id === scale}
                        onChange={() => setScale(range.id)}
                      />
                      <b className={styles.cardName} id={`range-${range.id}`}>
                        {named(range.id)}
                      </b>
                      <span className={styles.chip}>{range.label}</span>
                    </span>
                    <svg
                      className={styles.sketch}
                      viewBox="0 0 120 36"
                      preserveAspectRatio="none"
                      aria-hidden="true"
                      focusable="false"
                    >
                      <path d={SKETCH[range.id]} />
                    </svg>
                    {/* The ranges describe themselves in the scale catalogue the chart draws
                        them from, so they are printed from there rather than said a second time
                        here. */}
                    <span className={styles.what} id={`range-what-${range.id}`}>
                      {sentence(range.hint)}
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>

            <section className={styles.readings}>
              {/* The reset beside the heading of what it resets. At the foot of the panel it
                  stood a screen of switches and a glossary away from them, under the save folder
                  it does not touch. */}
              <div className={styles.readingsTop}>
                <div className={styles.readingsTitle}>
                  <h3 className={styles.heading}>Readings</h3>
                  <span className={styles.count} aria-live="polite">
                    {shown} of {READING_IDS.length} shown
                    {changed > 0 && <span className={styles.countChanged}> · {changed} changed</span>}
                  </span>
                </div>
                {/* Dead until something has been changed: a reset that is always live says
                    nothing about whether there is anything to reset. */}
                <button type="button" className="ghost" disabled={changed === 0} onClick={restore}>
                  Restore defaults
                </button>
              </div>
              <p className={panel.note}>Statistics shown under the chart, where applicable.</p>

              {/* Two dozen switches is a list to search, not one to read down every time. It
                  looks in the meanings as well as the names, because the name is the part a
                  reader is here for not knowing: 'deviation' has to find `spread`. */}
              <input
                type="search"
                className={styles.look}
                aria-label="Filter readings"
                placeholder="Filter readings"
                value={look}
                onChange={(event) => setLook(event.target.value)}
              />

              {GROUPS.map((group) => {
                const ids = READING_IDS.filter((id) => READINGS[id].group === group);
                const listed = ids.filter((id) => found.includes(id));
                if (listed.length === 0) return null;

                const title = READING_GROUPS[group].title;
                const on = ids.filter((id) => showsReading(id, readings)).length;
                // The sample that is up has none of this group's readings on it.
                const elsewhere =
                  (group === 'quantity' && sample === 'switch') ||
                  (group === 'events' && sample === 'measurement');

                return (
                  <fieldset key={group} className={styles.group}>
                    <legend className={styles.legend}>{title}</legend>
                    <div className={styles.groupTop}>
                      <p className={styles.about}>
                        {READING_GROUPS[group].about}
                        {/* Short, and on a line of its own — see `.elsewhere`. */}
                        {elsewhere && (
                          <em className={styles.elsewhere}>
                            Shown on the {group === 'events' ? 'Switch' : 'Measurement'} sample.
                          </em>
                        )}
                      </p>
                      <span className={styles.groupCount}>
                        {on}/{ids.length}
                      </span>
                      {/* Named for the group as well, and starting with the word on it: there
                          are three of each on the panel, and 'All' alone is three buttons
                          with one name. */}
                      <button
                        type="button"
                        className={`ghost ${styles.mini}`}
                        aria-label={`All on — ${title}`}
                        disabled={on === ids.length}
                        onClick={() => setGroup(group, true)}
                      >
                        All
                      </button>
                      <button
                        type="button"
                        className={`ghost ${styles.mini}`}
                        aria-label={`None on — ${title}`}
                        disabled={on === 0}
                        onClick={() => setGroup(group, false)}
                      >
                        None
                      </button>
                    </div>

                    <div className={styles.list}>
                      {listed.map((id) => (
                        <label
                          key={id}
                          className={styles.reading}
                          data-hot={hot === id ? '' : undefined}
                          onMouseEnter={() => setHot(id)}
                          onMouseLeave={() => setHot(null)}
                          onFocus={() => setHot(id)}
                          onBlur={() => setHot(null)}
                        >
                          {/* The switch is named for the reading and *described* by its
                              meaning, rather than taking both as its name: read aloud, 'mean,
                              checked' and then the sentence is a control with a name; one long
                              run of prose is a control with a paragraph. */}
                          <input
                            type="checkbox"
                            aria-labelledby={`reading-${id}`}
                            aria-describedby={`what-${id}`}
                            checked={showsReading(id, readings)}
                            onChange={(event) => toggle(id, event.target.checked)}
                          />
                          <span className={styles.readingText}>
                            <span className={styles.readingHead}>
                              <b className={styles.readingLabel} id={`reading-${id}`}>
                                {READINGS[id].label}
                              </b>
                              {/* Beside the name and outside it, so the switch is still called
                                  'mean' and not 'mean changed'. */}
                              {!asShipped(id, readings) && (
                                <span className={styles.changed} title="Changed from the default">
                                  <span className="srOnly">changed from the default</span>
                                </span>
                              )}
                            </span>
                            <span className={styles.readingWhat} id={`what-${id}`}>
                              {READINGS[id].what}
                            </span>
                          </span>
                        </label>
                      ))}
                    </div>
                  </fieldset>
                );
              })}

              {found.length === 0 && <p className={styles.nothing}>No reading matches the filter.</p>}
            </section>

            {/* Under the readings, not over them. It is set once and then left for months, and
                at the top it stood between the range and the readings — the two things this
                panel is opened for. Its own row rather than a line in the csv chip's
                explanation: it is a setting, it persists across saves, and changing it should
                not mean pressing the thing that uses it. */}
            <section className={styles.saving}>
              {/* No id: it carried `save-folder-label` for an `aria-labelledby` that no longer
                  exists — the button beside it names itself now, for the reason its own comment
                  gives — and an id nothing points at is a promise to a reader nobody kept. */}
              <h3 className={styles.heading}>Save folder</h3>
              <div className={styles.folder}>
                <span
                  className={styles.folderPath}
                  data-testid="export-folder"
                  // A path is cut from its head, since the tail is what tells two folders apart. A
                  // sentence is not, and cutting one from its head reads as gibberish.
                  data-path={exporter.folder ? '' : undefined}
                  title={exporter.folder ?? undefined}
                >
                  {exporter.canChoose
                    ? (exporter.folder ?? 'Not set — CSV export will prompt')
                    : 'Folder selection unavailable — CSV downloads directly.'}
                </span>
                {exporter.canChoose && (
                  <button
                    type="button"
                    className="ghost"
                    /* Named for what pressing it does, and starting with the word on it: pointed at
                       the label alone it answered to 'Save folder', which is a noun with no verb in
                       it and does not contain the word a reader sees — so anyone driving by voice
                       said 'click choose' at a control by that name that answered to another. */
                    aria-label={exporter.folder ? 'Change the save folder' : 'Choose a save folder'}
                    disabled={exporter.choosing}
                    onClick={() => exporter.choose()}
                  >
                    {exporter.folder ? 'Change…' : 'Choose…'}
                  </button>
                )}
              </div>
              <p className={panel.note}>Where the csv control over the plot puts its files.</p>
            </section>

            {/* The chips over the plot are three and four characters long, because they share a
                row with a pane that can be two hundred pixels wide. Short is right for the chip
                and wrong for a reader meeting it — and a `title` is a thing you have to already
                suspect is there. So the words live here, beside the readings that are explained
                the same way.

                Shut until asked for: it is something to look up, not something to set, and open
                it was the longer half of a panel whose switches are above it. */}
            <details className={styles.fold}>
              <summary>Controls over the plot</summary>

              {/* Set as the readings above are — a box to a group, its name and what it is
                  about, then its chips as many to a row as fit — so the two halves of the panel
                  are read the same way. They were three columns side by side, one to a group,
                  and the groups are eight chips, one and three: one column ran the length of the
                  fold and the two beside it stopped a fifth of the way down. */}
              {CONTROL_GROUPS.map((group) => (
                <fieldset key={group} className={styles.group}>
                  <legend className={styles.legend}>{CONTROL_GROUP_TITLES[group].title}</legend>
                  <div className={styles.groupTop}>
                    <p className={styles.about}>
                      {CONTROL_GROUP_TITLES[group].about}
                      {/* The three ranges were listed here, chip and hint. They are the cards at
                          the top of the panel now, and said twice they were two lists to keep in
                          step and one more thing to read past. */}
                      {group === 'range' && (
                        <em className={styles.pointer}>
                          The other chips in this row are the ranges at the top of this panel,
                          under the names printed beside them there.
                        </em>
                      )}
                    </p>
                  </div>

                  {/* In the order the chart puts them in, so the list can be read against the
                      row. */}
                  <div className={styles.list}>
                    {CONTROL_IDS.filter((id) => CONTROLS[id].group === group).map((id) => (
                      <p key={id} className={styles.control}>
                        <b className={styles.chip}>{CONTROLS[id].label}</b>
                        <span className={styles.what}>{CONTROLS[id].what}</span>
                        {/* A line of its own, not the tail of the sentence before it: what a
                            chip does and when it is there at all are two questions, and run
                            together the second read as part of the first. */}
                        {CONTROLS[id].when && <em className={styles.when}>{CONTROLS[id].when}</em>}
                      </p>
                    ))}
                  </div>
                </fieldset>
              ))}
            </details>
          </div>

          <ChartPreview
            scale={scale}
            readings={readings}
            sample={sample}
            onSample={(id) => {
              setSample(id);
              setMoved(false);
            }}
            hot={hot}
            moved={moved}
          />
        </div>
      </div>
    </PanelShell>
  );
}

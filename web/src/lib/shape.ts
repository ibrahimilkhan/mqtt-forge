import type { Reading } from './series';
import type { Summary } from './stats';

/**
 * What kind of thing a run of readings is, which decides what can honestly be said about it.
 *
 * A mean is a fact about a temperature and a fiction about a door sensor: 'the door was 0.3 open
 * on average' describes nothing that ever happened. The same goes for a pulse train, where the
 * average sits in the gap between the two levels the signal actually visits, and for a packet
 * counter, where the value itself is meaningless and the only reading anyone wants is how fast it
 * is climbing.
 *
 * So the run is classified first, and the chart and the note both follow it: how the line is
 * drawn, which range it is drawn in, and which numbers are worth printing under it.
 */
export type ShapeId = 'continuous' | 'state' | 'pulse' | 'counter';

export type Shape =
  /** Readings of a quantity. Means, deviations and trends all mean what they usually mean. */
  | { id: 'continuous' }
  /** A number that only ever goes up. Its value says nothing; its rate says everything. */
  | { id: 'counter'; rate: number | null; wraps: number }
  /** A handful of levels, or a rest with events on it. Counted and timed, not averaged. */
  | { id: 'state' | 'pulse'; levels: number; pulses: Pulses };

/** What a run of events adds up to, when averaging it would describe nothing that happened. */
export type Pulses = {
  /** The level the run sits at between events. */
  rest: number;
  /** The level it goes to. */
  peak: number;
  /** The line between the two, which every count below is taken against. */
  threshold: number;
  /** Separate excursions past it. */
  count: number;
  /** The share of readings spent past it, from 0 to 1. */
  duty: number;
  /** Middle time from one excursion's start to the next, in milliseconds. */
  every: number | null;
  /** Middle time an excursion lasts, in milliseconds. Null when none of them has finished. */
  width: number | null;
};

/** Below this a run has no habits, and every rule here would be reading a coincidence. */
export const ENOUGH_TO_CLASSIFY = 8;

/** More levels than this and the readings are a quantity that happens to be coarse. */
const MOST_LEVELS = 4;

/** Two levels is a switch, whatever the split between them. */
const A_SWITCH = 2;

/**
 * How much of its fair share a level has to hold to be a state rather than an event.
 *
 * Without this, a sensor reading 1, 2, 3 all day with three spikes in it has four levels and
 * reads as a four-state machine — when what it really is is a small signal with events on top of
 * it, and the events are the thing. Half of an even split is a generous floor: a run really
 * moving between four states can be lopsided about it, but not a hundred to one.
 */
const HOLDS_ITS_SHARE = 0.5;

/** A level the run visited once is somewhere it went, not somewhere it lives. */
const VISITS_AGAIN = 2;

/** Below this the run crossed between its levels once, which is a step rather than a switch. */
const LEAVES_AND_RETURNS = 2;

/** Past this share of the run, an excursion is not an event on a rest — it is the run. */
const MOST_OF_A_DUTY = 0.35;

/** Fewer than this and it is one thing that happened, not a rhythm. */
const FEWEST_PULSES = 3;

/** How far past the run's own scatter a reading has to be to count as leaving the rest. */
const DEPARTS_BY = 6;

export function shapeOf(readings: Reading[], summary: Summary): Shape {
  const values = readings.map((reading) => reading.value);

  if (values.length < ENOUGH_TO_CLASSIFY || summary.high === summary.low) return { id: 'continuous' };

  const levels = tally(values);

  const counting = climbing(readings, levels.size);
  if (counting) return counting;

  // A handful of levels, each of them somewhere the run actually lives: a switch, a mode, a
  // state machine. Checked before the pulse test, since a switch also rests and leaves — the
  // difference is that its rest is one exact value rather than a band the readings wander in.
  if (levels.size <= MOST_LEVELS && lived(levels, values.length)) {
    const pulses = pulsesOf(readings, midpoint(values), summary);

    // A run that crossed between its levels once did not switch — it stepped, and the note has a
    // better reading of that: how far it moved and when. A switch goes back and forth.
    if (pulses.count >= LEAVES_AND_RETURNS) return { id: 'state', levels: levels.size, pulses };
  }

  const events = spiking(readings, summary);
  if (events) return { id: 'pulse', levels: levels.size, pulses: events };

  return { id: 'continuous' };
}

/**
 * A number that only ever goes up.
 *
 * Packets, bytes, joules, revolutions: the reading is a running total, so its value is an
 * accident of when the device last restarted and the only thing worth charting is the slope.
 * Sensor noise makes a real quantity wobble, so 'never once went down' is a strict enough test to
 * separate a total from a temperature that happens to be rising.
 *
 * A wrap or a restart is allowed for — that is a counter behaving exactly like a counter — and
 * counted, since a rate worked out straight across one would be a large negative number.
 */
function climbing(readings: Reading[], levels: number): Shape | null {
  // A total worth reading takes more than a handful of values. Without this, a door sensor going
  // 0, 1, 0, 1 reads as a counter that wraps on every close.
  if (levels <= MOST_LEVELS) return null;

  let rise = 0;
  let wraps = 0;
  const steps = new Set<number>();

  for (let i = 1; i < readings.length; i++) {
    const step = readings[i].value - readings[i - 1].value;

    if (step >= 0) {
      rise += step;
      steps.add(step);
      continue;
    }

    // A drop that lands near the bottom of the run is a counter starting again. A drop that
    // lands anywhere else is a quantity going down, and this is not a counter at all.
    if (readings[i].value > readings[i - 1].value / 2) return null;
    wraps++;
  }

  // Every wrap is a reading the rate cannot be taken across, and a run that is mostly wraps is
  // not a counter being read, it is a device being restarted.
  if (rise <= 0 || wraps * 4 > readings.length) return null;

  // A total that climbs by exactly the same amount every single time is not a total — nothing
  // that gets counted arrives that evenly. It is a ramp: a sweep, a setpoint, a simulator, a
  // temperature climbing steadily. Those have a value that means something and a trend worth
  // printing, and reading them as counters would throw both away.
  if (steps.size < 2) return null;

  const span = readings[readings.length - 1].at.getTime() - readings[0].at.getTime();

  return { id: 'counter', rate: span > 0 ? (rise / span) * 1000 : null, wraps };
}

/**
 * A run that rests somewhere and occasionally leaves.
 *
 * The rest is the middle reading, and 'leaving' is measured against the run's own scatter about
 * it rather than against a fixed size — a pressure that idles at 1013 and spikes to 1400 and a
 * flow meter that idles at 0 and spikes to 3 are the same signal, and only the second of them
 * would clear any threshold written in units.
 *
 * Three excursions at least: one is an outlier, which the note already rings, and two is a
 * coincidence. A run that spends more than about a third of itself away from the rest does not
 * have a rest — it has two levels, and either the state test above caught it or it is a quantity
 * moving between them.
 */
function spiking(readings: Reading[], summary: Summary): Pulses | null {
  const values = readings.map((reading) => reading.value);
  const rest = summary.median;

  const strays = values.map((value) => Math.abs(value - rest)).sort((a, b) => a - b);
  const scatter = strays[Math.floor(strays.length / 2)];

  // With no scatter at all, anything that is not the rest has left it.
  const reach = scatter > 0 ? DEPARTS_BY * scatter : 0;

  const away = values.filter((value) => Math.abs(value - rest) > reach).length;
  if (away === 0 || away > values.length * MOST_OF_A_DUTY) return null;

  // The peak is the end the excursions actually go to; a run that dips instead of spiking is the
  // same signal upside down, and reading it against the wrong end would count every rest as one.
  const above = values.filter((value) => value - rest > reach).length;
  const peak = above * 2 >= away ? summary.high : summary.low;
  const pulses = pulsesOf(readings, rest + (peak - rest) / 2, summary);

  return pulses.count >= FEWEST_PULSES ? { ...pulses, rest, peak } : null;
}

/** Halfway between the lowest and highest level a state run visits. */
const midpoint = (values: number[]) => (Math.min(...values) + Math.max(...values)) / 2;

/** How many readings each distinct value holds. */
function tally(values: number[]): Map<number, number> {
  const seen = new Map<number, number>();
  for (const value of values) seen.set(value, (seen.get(value) ?? 0) + 1);

  return seen;
}

/**
 * Whether every level is somewhere the run lives rather than somewhere it went once.
 *
 * Two of them is a switch however lopsided the split, since there is nothing else two levels
 * could be. Past two, each has to be visited more than once and hold something like its share —
 * otherwise a quantity with one wild reading in it has an extra 'level' and reads as a machine.
 */
function lived(levels: Map<number, number>, n: number): boolean {
  const least = Math.min(...levels.values());
  if (least < VISITS_AGAIN) return false;

  return levels.size <= A_SWITCH || least / n >= HOLDS_ITS_SHARE / levels.size;
}

/**
 * The excursions past a threshold, counted and timed.
 *
 * 'Past' is whichever side the run spends less of itself on, so the same arithmetic reads a
 * sensor that idles low and pulses high and one that idles high and drops — a door that is shut
 * all day and open twice has two events, not four hundred.
 */
function pulsesOf(readings: Reading[], threshold: number, summary: Summary): Pulses {
  const high = readings.filter((reading) => reading.value >= threshold).length;
  // The minority side is the event. A dead heat reads high as the event, which is the convention
  // every logic analyser uses.
  const isEvent = (reading: Reading) =>
    high * 2 <= readings.length ? reading.value >= threshold : reading.value < threshold;

  const starts: number[] = [];
  const widths: number[] = [];
  let open: number | null = null;

  readings.forEach((reading, index) => {
    if (isEvent(reading)) {
      if (open === null) {
        open = index;
        starts.push(index);
      }
      return;
    }

    // Measured to the first reading that is back at rest: an excursion one reading long lasted
    // until the next reading said otherwise, not for no time at all.
    if (open !== null) widths.push(reading.at.getTime() - readings[open].at.getTime());
    open = null;
  });

  const gaps = starts.slice(1).map((start, i) => readings[start].at.getTime() - readings[starts[i]].at.getTime());
  const events = readings.filter(isEvent).length;

  return {
    rest: high * 2 <= readings.length ? summary.low : summary.high,
    peak: high * 2 <= readings.length ? summary.high : summary.low,
    threshold,
    count: starts.length,
    duty: events / readings.length,
    every: middle(gaps),
    width: middle(widths),
  };
}

const middle = (values: number[]): number | null => {
  if (values.length === 0) return null;

  const sorted = [...values].sort((a, b) => a - b);

  return sorted[Math.floor(sorted.length / 2)];
};

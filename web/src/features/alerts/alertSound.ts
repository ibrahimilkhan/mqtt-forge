import { create } from 'zustand';
import { useAppearanceStore } from '../../stores/appearanceStore';
import type { AlertDto, AlertSeverity } from '../../types/api';

/**
 * What each severity sounds like: a pitch, and how many times it says it.
 *
 * Three tones a room can tell apart with its back to the screen. Pitch alone is not enough —
 * hearing is the sense this reaches when nobody is looking, and 'was that the high one or the
 * middle one' is a question with no answer once the sound has stopped. The count is what
 * survives: one beep is a note, three is an alarm, and nobody has to remember a frequency.
 *
 * D5, F#5 and B5, which is a chord rather than three arbitrary numbers: played over each other
 * by a broker raising two rules at once they still sound like a machine and not like a fault in
 * one. Nothing above about a kilohertz, because the cheap laptop speaker this will actually come
 * out of turns everything above that into the same hiss.
 */
export const TONES: Record<AlertSeverity, { hz: number; beeps: number }> = {
  info: { hz: 587.33, beeps: 1 },
  warn: { hz: 739.99, beeps: 2 },
  critical: { hz: 987.77, beeps: 3 },
};

/** How long one beep lasts, and the silence after it. Seconds, which is what WebAudio counts in. */
const BEEP = 0.12;
const GAP = 0.08;

/**
 * How loud, at the peak of the ramp.
 *
 * Well under one. This is a monitoring console that may sit on a desk all day beside somebody on
 * a call; an alarm has to be noticed, not to be the loudest thing the machine can do. The reader
 * has an operating system volume control and this has no business competing with it.
 */
const PEAK = 0.18;

/**
 * Said in the panel and at the root of the app, in one wording, from here.
 *
 * Two places saying the same thing in two sentences is two things to read; and the second half of
 * it is an instruction, not a description, because the state it names is one the reader can leave
 * in a single click.
 */
export const NOT_READY = 'Sound is not ready — click to turn it on';

/** Loudest wins when a batch arrives together. */
const RANK: Record<AlertSeverity, number> = { info: 0, warn: 1, critical: 2 };

type SoundState = {
  /** A context exists and the browser is letting it run. Never persisted; see the note below. */
  armed: boolean;
  /** An alert asked for a tone and there was no permission to play it. */
  waiting: boolean;
};

/**
 * Whether this page can currently make a sound.
 *
 * Deliberately not in `appearanceStore`, and deliberately not persisted. The preference is a
 * choice the reader made and it belongs with the other choices; this is a permission the browser
 * grants per page load and takes back with the tab. Storing it would mean a fresh tab opening
 * with `armed: true` and no context behind it, which is precisely the quiet failure rule 5 is
 * about — the console would believe it could be heard and say nothing more.
 *
 * Read it as a store, `useSoundStore((state) => state.armed)`, the way every other store in this
 * console is read. There is no wrapper hook: a second name for one field is a second thing to
 * keep in step, and it is the name two other tasks each guessed at differently.
 */
export const useSoundStore = create<SoundState>(() => ({ armed: false, waiting: false }));

// One context per page. Building a second is how a page ends up with a dozen of them: browsers
// cap them, and the cap is reached by exactly this code called once per alert.
let context: AudioContext | null = null;

/** Safari called it something else for years, and still answers to that name. */
type WithWebkit = Window & { webkitAudioContext?: typeof AudioContext };

/**
 * The page's context, built on first use.
 *
 * Building one needs no gesture — it simply starts `suspended` — so this is safe to call from the
 * arrival of an alert. Running it is what needs the gesture, and that is `armSound` below.
 */
function audio(): AudioContext | null {
  if (context) return context;

  const Ctor = window.AudioContext ?? (window as WithWebkit).webkitAudioContext;
  if (!Ctor) return null;

  try {
    context = new Ctor();
  } catch {
    // A browser that refuses to build one at all: nothing to fall back to, and nothing to say.
    return null;
  }

  return context;
}

/** The listener waiting for the gesture, kept so it can be taken off again. */
let gesture: (() => void) | null = null;

function stopWatching(): void {
  if (!gesture) return;

  window.removeEventListener('pointerdown', gesture);
  window.removeEventListener('keydown', gesture);
  gesture = null;
}

/**
 * Take the next thing the reader does as the permission the browser is holding out for.
 *
 * One shot, on either kind of input — a console driven from the keyboard must not be a console
 * that never gets its sound. It is installed only when a tone has actually been missed, so a
 * reader who never turns the sound on never has a listener on their window at all.
 */
export function armOnNextGesture(): void {
  if (gesture || useSoundStore.getState().armed) return;

  const arm = () => {
    stopWatching();
    void armSound();
  };

  gesture = arm;
  window.addEventListener('pointerdown', arm);
  window.addEventListener('keydown', arm);
}

/**
 * Ask the browser to let this page make a sound, and report whether it agreed.
 *
 * Called from a gesture — the panel's button, or the listener above. `resume()` resolves either
 * way; what says whether it worked is the state afterwards.
 */
export async function armSound(): Promise<boolean> {
  const ctx = audio();
  if (!ctx) {
    useSoundStore.setState({ armed: false, waiting: false });
    return false;
  }

  if (ctx.state !== 'running') {
    try {
      await ctx.resume();
    } catch {
      // Refused. The state below is the answer; there is nothing to report separately.
    }
  }

  const armed = ctx.state === 'running';
  // Armed clears the wait: whatever was missed, the next one will be heard.
  useSoundStore.setState(armed ? { armed: true, waiting: false } : { armed: false });

  return armed;
}

/** One severity's beeps, laid out end to end from now. */
function beeps(ctx: AudioContext, severity: AlertSeverity): void {
  const { hz, beeps: count } = TONES[severity];

  for (let index = 0; index < count; index += 1) {
    const at = ctx.currentTime + index * (BEEP + GAP);
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(hz, at);

    // Ramped rather than switched. A tone that starts and stops at full gain clicks at both ends,
    // and the click is louder than the tone — which turns a discreet alarm into a snap.
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(PEAK, at + 0.01);
    gain.gain.linearRampToValueAtTime(0, at + BEEP);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(at);
    osc.stop(at + BEEP);
  }
}

/**
 * Sound one alert, if the reader asked for sound and the browser is allowing it.
 *
 * Returns whether anything was actually heard, so a caller never has to guess. The one state
 * worth naming is the middle one: the preference is on, a tone was owed, and the browser has not
 * been clicked yet. That sets `waiting`, which is what the panel and the prompt read.
 */
export function soundAlert(severity: AlertSeverity): boolean {
  if (!useAppearanceStore.getState().alertSound) return false;

  const ctx = audio();
  // No WebAudio here at all. There is no gesture that would help, so there is nothing to promise
  // and nothing to say — 'click to turn it on' would point at a control that cannot work.
  if (!ctx) return false;

  if (!useSoundStore.getState().armed || ctx.state !== 'running') {
    useSoundStore.setState({ armed: false, waiting: true });
    armOnNextGesture();
    return false;
  }

  try {
    beeps(ctx, severity);
  } catch {
    return false;
  }

  return true;
}

/** Whether a mute is still standing. The server should not send one; the guard costs nothing. */
const quiet = (alert: AlertDto) =>
  alert.mutedUntil !== null && Date.parse(alert.mutedUntil) > Date.now();

/**
 * One tone for one batch of raised alerts, at the worst severity in it.
 *
 * `alertsRaised` carries an array, and a rule with a wide filter can fill it — ten oscillators
 * over each other is a noise rather than an alarm, and the reader learns nothing from it that the
 * loudest one alone would not have told them. `screen` and `sound` are separate actions, so an
 * alert that never asked to be heard is not heard.
 *
 * `actions` is free text on the wire, because a failed delivery is written into it as
 * 'webhook: 404'. The match here is the whole word and not a prefix, so no failure can ever be
 * mistaken for a request to make a noise.
 */
export function soundFor(alerts: ReadonlyArray<AlertDto>): boolean {
  const wanting = alerts.filter((alert) => alert.actions.includes('sound') && !quiet(alert));
  if (wanting.length === 0) return false;

  const worst = wanting.reduce((found, alert) =>
    RANK[alert.severity] > RANK[found.severity] ? alert : found,
  );

  return soundAlert(worst.severity);
}

/**
 * The button: the preference and the permission in one press.
 *
 * They are asked for together because the press is the gesture. Setting the preference now and
 * taking the permission later is how a setting ends up on with nothing behind it.
 */
export async function turnSoundOn(): Promise<boolean> {
  useAppearanceStore.getState().setAlertSound(true);
  return armSound();
}

/**
 * Off, and nothing owed.
 *
 * The context is left open. It costs nothing while nothing is playing, and keeping it means a
 * reader who turns the sound back on in the same page is not asked for a gesture a second time.
 */
export function turnSoundOff(): void {
  useAppearanceStore.getState().setAlertSound(false);
  useSoundStore.setState({ waiting: false });
}

/**
 * Put the page back to how it opened.
 *
 * For tests, which run many pages in one process while this module holds one context for the life
 * of a page. Nothing in the app calls it: closing the tab is what does this in a browser.
 */
export function forgetSound(): void {
  stopWatching();

  try {
    void context?.close();
  } catch {
    // A context already closed, or one the browser will not close. Neither matters here.
  }

  context = null;
  useSoundStore.setState({ armed: false, waiting: false });
}

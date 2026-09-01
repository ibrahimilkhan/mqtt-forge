import { useAppearanceStore } from '../../stores/appearanceStore';
import panel from '../../styles/panel.module.css';
import styles from './SoundButton.module.css';
import { NOT_READY, turnSoundOff, turnSoundOn, useSoundStore } from './alertSound';

/**
 * The sound switch, in the panel. The only one — task 3's panel mounts this and draws no sound
 * control of its own, because two controls for one preference is two wordings to keep in step and
 * one of them will drift.
 *
 * Three states rather than two, because there are three: off, on and audible, and on and waiting
 * for the browser. The third is the one this control exists for — a switch that read 'on' while
 * the page could make no sound would be the console telling a lie about the one thing it was
 * asked to do when nobody is looking.
 *
 * A press while it is waiting is the gesture the browser was holding out for, so it arms rather
 * than turning the setting off: the setting is already on, and what is missing is permission.
 */
export function SoundButton() {
  const on = useAppearanceStore((state) => state.alertSound);
  const armed = useSoundStore((state) => state.armed);
  const ready = on && armed;

  return (
    <div className={styles.sound}>
      <button
        type="button"
        className="ghost"
        aria-pressed={on}
        title={
          ready
            ? 'Alerts that ask for a tone will be heard'
            : on
              ? NOT_READY
              : 'Play a tone when an alert asks for one'
        }
        onClick={() => (ready ? turnSoundOff() : void turnSoundOn())}
      >
        {ready ? 'Sound on' : on ? 'Sound waiting' : 'Sound off'}
      </button>

      {on && !armed && <p className={panel.note}>{NOT_READY}</p>}
    </div>
  );
}

/**
 * The same sentence at the root of the app, and only once a tone has actually been missed.
 *
 * The panel is where the switch is, and the panel is shut most of the time — which is exactly
 * when an alarm matters. This is the standing line that says a tone was owed and not paid, and it
 * is beside the notice stack rather than in it: a notice is one alert, and this is about all of
 * them.
 */
export function SoundPrompt() {
  const on = useAppearanceStore((state) => state.alertSound);
  const waiting = useSoundStore((state) => state.waiting);

  if (!on || !waiting) return null;

  return (
    <div className={styles.prompt} role="status">
      <p>{NOT_READY}</p>
      <button type="button" onClick={() => void turnSoundOn()}>
        Turn the sound on
      </button>
    </div>
  );
}

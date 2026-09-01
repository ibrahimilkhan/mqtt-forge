import { useAppearanceStore } from '../../stores/appearanceStore';
import panel from '../../styles/panel.module.css';
import styles from './SoundButton.module.css';
import { NOT_READY, turnSoundOff, turnSoundOn, useSoundStore } from './alertSound';

/**
 * The sound switch, in Settings. The only one — nothing else draws a sound control, because two
 * controls for one preference is two wordings to keep in step and one of them will drift.
 *
 * Two labels, because the switch has two positions: on and off. It carried a third for a while —
 * 'waiting' — for the case where the preference is on and the browser has not yet let a sound
 * through. That is a real state and it is still said, under the switch rather than on it: it is a
 * fact about the browser, not a position anybody put the switch in, and a reader looking for the
 * setting they chose should find it where they left it.
 *
 * A press while it is on but unarmed is the gesture the browser was holding out for, so it arms
 * rather than turning the setting off: the setting is already on, and what is missing is
 * permission.
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
        {on ? 'Sound on' : 'Sound off'}
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
 * stands beside the alarm wall rather than on it: a row on the wall is one alarm, and this is
 * about all of them.
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

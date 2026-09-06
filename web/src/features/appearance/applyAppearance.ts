import { useAppearanceStore, type AppearanceChoices } from '../../stores/appearanceStore';
import { useLogStore } from '../../stores/logStore';
import { MONO, SANS } from './fonts';

// Inline style on :root outranks tokens.css's --sans/--mono/font-size, re-fonting the app.
function write({ sans, mono, size, loadMb }: AppearanceChoices) {
  const root = document.documentElement;
  root.style.setProperty('--sans', SANS[sans].stack);
  root.style.setProperty('--mono', MONO[mono].stack);
  root.style.fontSize = `${size}px`;

  // Not appearance, and here for the same reason the rest of this is: it is a stored choice that
  // something else has to be told about, once at startup and again whenever it changes. The log
  // holds the traffic and does the cutting back; this is only the reader's answer reaching it.
  // Idempotent — the store checks what it is holding before it does anything — so the subscribe
  // below calling it on every font change costs nothing.
  useLogStore.getState().setBudget(loadMb * 1024 * 1024);
}

// Called before first render (module code runs before React paints), so the default
// font never flashes before the stored choice applies.
export function startApplyingAppearance(): () => void {
  write(useAppearanceStore.getState());
  return useAppearanceStore.subscribe(write);
}

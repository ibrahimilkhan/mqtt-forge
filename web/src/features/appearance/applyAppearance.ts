import { useAppearanceStore, type AppearanceChoices } from '../../stores/appearanceStore';
import { MONO, SANS } from './fonts';

// Inline style on :root outranks tokens.css's --sans/--mono/font-size, re-fonting the app.
function write({ sans, mono, size }: AppearanceChoices) {
  const root = document.documentElement;
  root.style.setProperty('--sans', SANS[sans].stack);
  root.style.setProperty('--mono', MONO[mono].stack);
  root.style.fontSize = `${size}px`;
}

// Called before first render (module code runs before React paints), so the default
// font never flashes before the stored choice applies.
export function startApplyingAppearance(): () => void {
  write(useAppearanceStore.getState());
  return useAppearanceStore.subscribe(write);
}

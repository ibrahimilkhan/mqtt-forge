import { useAppearanceStore, type AppearanceChoices } from '../../stores/appearanceStore';
import { MONO, SANS } from './fonts';

// tokens.css declares --sans, --mono and the root font-size on :root; an inline style on
// the same element outranks them, so writing here re-fonts the whole app in one go.
function write({ sans, mono, size }: AppearanceChoices) {
  const root = document.documentElement;
  root.style.setProperty('--sans', SANS[sans].stack);
  root.style.setProperty('--mono', MONO[mono].stack);
  root.style.fontSize = `${size}px`;
}

// One subscriber writes to the document, so no component re-renders for a font change.
// Called before the first render: module code runs before React paints anything, which
// is why the stored choice never flashes past in the default font.
export function startApplyingAppearance(): () => void {
  write(useAppearanceStore.getState());
  return useAppearanceStore.subscribe(write);
}

export type PanelId = 'broker' | 'subscribe' | 'mobile' | 'settings';

type Panel = { id: PanelId; label: string };

// These share the one panel column, so only one is ever open. Publish and the log are not here:
// they have fixed places in the workspace and are always on screen.
export const PANELS: ReadonlyArray<Panel> = [
  { id: 'broker', label: 'Broker' },
  { id: 'subscribe', label: 'Subscribe' },
  { id: 'mobile', label: 'Mobile' },
  { id: 'settings', label: 'Settings' },
];

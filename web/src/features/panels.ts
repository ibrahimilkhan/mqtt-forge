export type PanelId = 'broker' | 'subscribe' | 'publish';

export const PANELS: ReadonlyArray<{ id: PanelId; label: string }> = [
  { id: 'broker', label: 'Broker' },
  { id: 'subscribe', label: 'Subscribe' },
  { id: 'publish', label: 'Publish' },
];

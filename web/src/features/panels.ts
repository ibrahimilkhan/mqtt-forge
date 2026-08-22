import type { ReactElement } from 'react';
import { Antenna, Blend, ChartLine, Funnel, QrCode, Settings } from './brand/icons';

export type PanelId = 'broker' | 'subscribe' | 'colours' | 'chart' | 'mobile' | 'settings';

/**
 * What the panel is for, rather than what it is called.
 *
 * Six flat buttons is a list to read through; three groups of two is a list to point at. The
 * headings are the questions someone actually arrives with: what am I connected to, what am I
 * reading, and what else is here.
 */
export type PanelGroup = 'Link' | 'Reading' | 'Tools';

type Panel = { id: PanelId; label: string; group: PanelGroup; icon: () => ReactElement };

// These share the one panel column, so only one is ever open. Publish and the log are not here:
// they have fixed places in the workspace and are always on screen.
//
// Chart comes before Colours in Reading, which is the other way round from how they used to
// stand: reading a topic starts with the plot, and how the tree is coloured is what you go and
// adjust once you have been watching a while.
export const PANELS: ReadonlyArray<Panel> = [
  { id: 'broker', label: 'Broker', group: 'Link', icon: Antenna },
  { id: 'subscribe', label: 'Filters', group: 'Link', icon: Funnel },
  { id: 'chart', label: 'Chart', group: 'Reading', icon: ChartLine },
  { id: 'colours', label: 'Colours', group: 'Reading', icon: Blend },
  { id: 'mobile', label: 'QR', group: 'Tools', icon: QrCode },
  { id: 'settings', label: 'Settings', group: 'Tools', icon: Settings },
];

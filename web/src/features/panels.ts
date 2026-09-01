import type { ReactElement } from 'react';
import { Antenna, Bell, Blend, ChartLine, Funnel, QrCode, Settings } from './brand/icons';

export type PanelId = 'broker' | 'subscribe' | 'colours' | 'chart' | 'alerts' | 'mobile' | 'settings';

/**
 * What the panel is for, rather than what it is called.
 *
 * Seven flat buttons is a list to read through; three groups is a list to point at. The headings
 * are the questions someone actually arrives with: what am I connected to, what am I reading, and
 * what else is here.
 *
 * The groups used to be two apiece, and this comment used to say so as though the pairs were the
 * point. They were not: two is what those two questions happened to need. Reading is three now,
 * and both alternatives were worse. Alerts under Tools puts the thing that wakes you at night
 * beside the QR code and the type size. Alerts in a group of its own spends a whole heading on
 * one button and turns a list of three groups into a list of four — which is the shape the
 * grouping was introduced to get away from.
 *
 * It belongs in Reading because that is the question it answers. Which topics am I watching, how
 * are they coloured, and when should the console tell me are the same question asked three times.
 */
export type PanelGroup = 'Link' | 'Reading' | 'Tools';

type Panel = { id: PanelId; label: string; group: PanelGroup; icon: () => ReactElement };

// These share the one panel column, so only one is ever open. Publish and the log are not here:
// they have fixed places in the workspace and are always on screen.
//
// Chart comes before Colours in Reading, which is the other way round from how they used to
// stand: reading a topic starts with the plot, and how the tree is coloured is what you go and
// adjust once you have been watching a while. Alerts comes after both, for the same reason one
// step further on: a rule is written about a run somebody has already been watching.
export const PANELS: ReadonlyArray<Panel> = [
  { id: 'broker', label: 'Broker', group: 'Link', icon: Antenna },
  { id: 'subscribe', label: 'Filters', group: 'Link', icon: Funnel },
  { id: 'chart', label: 'Chart', group: 'Reading', icon: ChartLine },
  { id: 'colours', label: 'Colours', group: 'Reading', icon: Blend },
  { id: 'alerts', label: 'Alerts', group: 'Reading', icon: Bell },
  { id: 'mobile', label: 'QR', group: 'Tools', icon: QrCode },
  { id: 'settings', label: 'Settings', group: 'Tools', icon: Settings },
];

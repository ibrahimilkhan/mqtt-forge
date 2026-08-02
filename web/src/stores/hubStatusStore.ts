import { create } from 'zustand';

type HubStatus = 'live' | 'reconnecting';

type HubStatusState = { status: HubStatus; setStatus: (status: HubStatus) => void };

// The hub's own health, not the broker's; client state, so a store rather than the query cache.
export const useHubStatusStore = create<HubStatusState>((set) => ({
  status: 'live',
  setStatus: (status) => set({ status }),
}));

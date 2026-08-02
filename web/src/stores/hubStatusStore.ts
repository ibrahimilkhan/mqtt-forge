import { create } from 'zustand';

type HubStatus = 'live' | 'reconnecting';

type HubStatusState = { status: HubStatus; setStatus: (status: HubStatus) => void };

// The hub's own health, which is not the broker's. This is client state rather than
// anything fetched, so it belongs in a store rather than in the query cache.
export const useHubStatusStore = create<HubStatusState>((set) => ({
  status: 'live',
  setStatus: (status) => set({ status }),
}));

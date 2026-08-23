import type {
  ConnectRequest,
  ConnectionStateResponse,
  SavedConnection,
  SavedProfile,
} from '../types/api';
import { json, request } from './client';

export const getConnectionState = () => request<ConnectionStateResponse>('/api/connection');

// 204 when nothing has been saved yet, which the client turns into undefined — and undefined is
// the one thing React Query refuses to hold, so 'nothing saved' is carried as null instead. Left
// as undefined the query threw on every first run, retried three times, and arrived at the same
// empty form by way of an error state.
export const getSavedSettings = async (): Promise<SavedConnection | null> =>
  (await request<SavedConnection | undefined>('/api/connection/settings')) ?? null;

export const connect = (body: ConnectRequest) =>
  request<ConnectionStateResponse>('/api/connection', { method: 'POST', ...json(body) });

export const disconnect = () => request<void>('/api/connection', { method: 'DELETE' });

// Calls off an attempt still in flight — the attempt, not the connection. The request that
// started it may belong to a panel the user has since navigated away from, so the abort is
// its own request rather than a hang-up on that one.
export const cancelConnect = () => request<void>('/api/connection/attempt', { method: 'DELETE' });

// ---- brokers somebody chose to keep ----
//
// Apart from the settings above, which are a cache the API overwrites after every connect that
// works. These are written only when somebody presses Save, and stay until they delete one.

export const getSavedProfiles = () =>
  request<SavedProfile[]>('/api/connection/profiles');

// PUT because the name is the identity: saving one that is already there replaces it, which is
// what correcting a port on a broker you already keep means by pressing Save again.
export const saveProfile = (name: string, connection: ConnectRequest) =>
  request<void>('/api/connection/profiles', { method: 'PUT', ...json({ name, connection }) });

export const deleteProfile = (name: string) =>
  request<void>(`/api/connection/profiles/${encodeURIComponent(name)}`, { method: 'DELETE' });

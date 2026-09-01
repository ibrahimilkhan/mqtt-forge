import type {
  ConnectRequest,
  ConnectionStateResponse,
  ReconnectStatus,
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

// ---- the standing arrangement to keep a link ----
//
// Four calls about one thing: whether a link that drops is put back, and what is being done
// about one right now. The abort above is a different question — it hangs up on one CONNECT and
// knows nothing about ladders.

export const getReconnectStatus = () => request<ReconnectStatus>('/api/connection/reconnect');

/** The standing answer, remembered across restarts. */
export const setReconnectEnabled = (enabled: boolean) =>
  request<ReconnectStatus>('/api/connection/reconnect', { method: 'PUT', ...json({ enabled }) });

/** Dials now, whatever the ladder was waiting for. Works with the option off. */
export const reconnectNow = () =>
  request<ReconnectStatus>('/api/connection/reconnect', { method: 'POST' });

/**
 * Calls off the outage being worked on, and the attempt in flight with it.
 *
 * Not the same as turning the option off, and the panel offers both: this is "stop, I am looking
 * at it" and lasts until the next connection that works, where the switch is the standing answer.
 */
export const stopReconnecting = () =>
  request<ReconnectStatus>('/api/connection/reconnect', { method: 'DELETE' });

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

// ---- the three files an encrypted connection can be given ----
//
// The paths are read where the server runs, so typing one is naming a path on a machine the
// reader may not be sitting at. Where the host owns a window it owns a file dialog too, and that
// is the one place a path can be pointed at rather than remembered.

/** Which of the three boxes is being filled in, which is what names the dialog. */
export type CertificateFileKind = 'authority' | 'certificate' | 'key';

/**
 * Whether this host can be asked for a file at all.
 *
 * False in a browser and true in the desktop window, and the difference is not a setting: the
 * dialog belongs to the host, and only a host that owns a window has one. A file input cannot
 * stand in — it hands over the bytes and hides the path, and the bytes are no use to a server
 * that has to open the file itself.
 */
export const getCertificateDialog = () =>
  request<{ canChoose: boolean }>('/api/connection/certificate-file');

/** Opens the host's dialog. A dismissed dialog comes back as no path. */
export const pickCertificateFile = (kind: CertificateFileKind) =>
  request<{ path: string | null }>('/api/connection/certificate-file', {
    method: 'POST',
    ...json({ kind }),
  });

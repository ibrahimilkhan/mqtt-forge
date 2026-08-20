import { json, request } from './client';

/**
 * Where saved readings go, and whether this host can be asked to change it.
 *
 * `canChoose` is false in a browser and true in the desktop window, and the difference is not a
 * setting: the folder dialog belongs to the host, and only a host that owns a window has one. The
 * browser cannot stand in — `showDirectoryPicker` needs a secure context and the window loads a
 * LAN address over plain http, which is why the clipboard is missing there too.
 */
export type ExportFolder = { folder: string | null; canChoose: boolean };

export const getExportFolder = () => request<ExportFolder>('/api/export/folder');

/** Opens the host's dialog. A dismissed dialog comes back as the folder unchanged. */
export const chooseExportFolder = () =>
  request<ExportFolder>('/api/export/folder', { method: 'POST' });

/** Writes one file into the chosen folder, and says where it landed. */
export const saveCsv = (name: string, content: string) =>
  request<{ path: string }>('/api/export/csv', { method: 'POST', ...json({ name, content }) });

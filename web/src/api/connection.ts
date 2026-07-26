import type { ConnectRequest, ConnectionStateResponse, SavedConnection } from '../types/api';
import { json, request } from './client';

export const getConnectionState = () => request<ConnectionStateResponse>('/api/connection');

// Answers 204 when nothing has been saved yet, which the client turns into undefined.
export const getSavedSettings = () => request<SavedConnection | undefined>('/api/connection/settings');

export const connect = (body: ConnectRequest) =>
  request<ConnectionStateResponse>('/api/connection', { method: 'POST', ...json(body) });

export const disconnect = () => request<void>('/api/connection', { method: 'DELETE' });

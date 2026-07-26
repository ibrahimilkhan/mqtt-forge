import type { PublishRequest } from '../types/api';
import { json, request } from './client';

export const publish = (body: PublishRequest) =>
  request<void>('/api/publish', { method: 'POST', ...json(body) });

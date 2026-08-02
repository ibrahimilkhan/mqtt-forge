import type { SubscribeRequest } from '../types/api';
import { json, request } from './client';

export const getSubscriptions = () => request<string[]>('/api/subscriptions');

export const subscribe = (body: SubscribeRequest) =>
  request<void>('/api/subscriptions', { method: 'POST', ...json(body) });

// Query value, not a path segment — '#' and '/' can't survive in one.
export const unsubscribe = (topicFilter: string) =>
  request<void>(`/api/subscriptions?topicFilter=${encodeURIComponent(topicFilter)}`, { method: 'DELETE' });

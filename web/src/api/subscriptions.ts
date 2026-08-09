import type { SubscribeRequest } from '../types/api';
import { json, request } from './client';

export const getSubscriptions = () => request<string[]>('/api/subscriptions');

export const subscribe = (body: SubscribeRequest) =>
  request<void>('/api/subscriptions', { method: 'POST', ...json(body) });

// One SUBSCRIBE packet for the lot. The broker round trip is the whole cost of subscribing, so
// sending filters one at a time is 50ms of waiting each; measured, 600 of them took 31 seconds
// that way and 0.15 seconds in packets of 200.
export const subscribeBatch = (filters: SubscribeRequest[]) =>
  request<void>('/api/subscriptions/batch', { method: 'POST', ...json({ filters }) });

// Query value, not a path segment — '#' and '/' can't survive in one.
export const unsubscribe = (topicFilter: string) =>
  request<void>(`/api/subscriptions?topicFilter=${encodeURIComponent(topicFilter)}`, { method: 'DELETE' });

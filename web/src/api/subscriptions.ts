import type { SubscribeRequest } from '../types/api';
import { json, request } from './client';

export const getSubscriptions = () => request<string[]>('/api/subscriptions');

export const subscribe = (body: SubscribeRequest) =>
  request<void>('/api/subscriptions', { method: 'POST', ...json(body) });

// The filter travels as a query value; '#' and '/' cannot be carried in a path segment.
export const unsubscribe = (topicFilter: string) =>
  request<void>(`/api/subscriptions?topicFilter=${encodeURIComponent(topicFilter)}`, { method: 'DELETE' });

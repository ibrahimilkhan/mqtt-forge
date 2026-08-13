import type { ColourRule } from '../lib/topicColour';
import { json, request } from './client';

// The whole list travels in one document: a rule carries no id because nothing points at one.
export const getColourRules = async (): Promise<ColourRule[]> =>
  (await request<{ rules: ColourRule[] }>('/api/colour-rules')).rules ?? [];

export const putColourRules = (rules: ColourRule[]) =>
  request<void>('/api/colour-rules', { method: 'PUT', ...json({ rules }) });

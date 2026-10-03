import { ApiError } from '../lib/problemDetails';
import type { FlowDto, FlowSavedDto, FlowStatusDto, FlowsDto } from '../types/api';
import { json, request } from './client';

/** The flows, what is wrong with any of them, and whether webhooks leave this host. */
export const getFlows = () => request<FlowsDto>('/api/flows');

/** What every run has done, for a page that has not heard a push yet. */
export const getFlowStatus = () => request<FlowStatusDto>('/api/flows/status');

/**
 * A save: the flow is kept and, when switched on, run — or refused with a 400 that says why, node
 * by node.
 *
 * One flow per request, never the whole set, so a second console saving a different flow at the
 * same moment cannot delete this one.
 */
export const putFlow = (flow: FlowDto) =>
  request<FlowSavedDto>(`/api/flows/${encodeURIComponent(flow.id)}`, { method: 'PUT', ...json(flow) });

/**
 * A test: the draft runs once on the server, beside the flow's active run, and nothing is kept.
 * Refused like a save, with a 400 that says why, node by node.
 */
export const testFlow = (flow: FlowDto) =>
  request<void>(`/api/flows/${encodeURIComponent(flow.id)}/test`, { method: 'POST', ...json(flow) });

/** Stops a flow's test run. */
export const stopTest = (id: string) =>
  request<void>(`/api/flows/${encodeURIComponent(id)}/test`, { method: 'DELETE' });

/** Stops the flow and forgets it. */
export const deleteFlow = (id: string) =>
  request<void>(`/api/flows/${encodeURIComponent(id)}`, { method: 'DELETE' });

/**
 * Whether a save, or a test, was refused for what is in it — as opposed to a server that could not
 * be reached, or a file it will not write over. Its `errors` are keyed flow, node:{id} and edge:{id}.
 */
export const isFlowInvalid = (error: unknown): error is ApiError =>
  error instanceof ApiError && error.reason === 'flowInvalid';

/**
 * Whether the server has no flow by that id to delete: another console deleted it since this one
 * last read the list. Its own 404, which says so, and not one from something in front of it.
 */
export const isFlowUnknown = (error: unknown): error is ApiError =>
  error instanceof ApiError && error.status === 404 && error.reason === 'flowUnknown';

/** Whether the server had no test of that flow going: it ended, or another console stopped it. */
export const isTestUnknown = (error: unknown): error is ApiError =>
  error instanceof ApiError && error.status === 404 && error.reason === 'testUnknown';

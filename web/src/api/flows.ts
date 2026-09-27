import { ApiError } from '../lib/problemDetails';
import type { FlowDto, FlowSavedDto, FlowStatusDto, FlowsDto } from '../types/api';
import { json, request } from './client';

/** The flows, what is wrong with any of them, and whether webhooks leave this host. */
export const getFlows = () => request<FlowsDto>('/api/flows');

/** What the running flows have done, for a page that has not heard a push yet. */
export const getFlowStatus = () => request<FlowStatusDto>('/api/flows/status');

/**
 * A deploy: the flow is kept and run, or refused with a 400 that says why, node by node.
 *
 * One flow per request, never the whole set, so a second console deploying a different flow at
 * the same moment cannot delete this one.
 */
export const putFlow = (flow: FlowDto) =>
  request<FlowSavedDto>(`/api/flows/${encodeURIComponent(flow.id)}`, { method: 'PUT', ...json(flow) });

/** Stops the flow and forgets it. */
export const deleteFlow = (id: string) =>
  request<void>(`/api/flows/${encodeURIComponent(id)}`, { method: 'DELETE' });

/** Presses a running Inject node's button. */
export const injectNode = (flowId: string, nodeId: string) =>
  request<void>(
    `/api/flows/${encodeURIComponent(flowId)}/nodes/${encodeURIComponent(nodeId)}/inject`,
    { method: 'POST' },
  );

/**
 * Whether a deploy was refused for what is in it — as opposed to a server that could not be
 * reached, or a file it will not write over. Its `errors` are keyed flow, node:{id} and edge:{id}.
 */
export const isFlowInvalid = (error: unknown): error is ApiError =>
  error instanceof ApiError && error.reason === 'flowInvalid';

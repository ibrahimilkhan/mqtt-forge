import type { HealthResponse } from '../types/api';
import { request } from './client';

export const getHealth = () => request<HealthResponse>('/api/health');

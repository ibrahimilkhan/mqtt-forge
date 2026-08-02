// Wraps the backend's ProblemDetails response as a single error type.
export class ApiError extends Error {
  readonly status: number;
  readonly title?: string;
  readonly errors?: Record<string, string[]>;

  constructor(status: number, message: string, title?: string, errors?: Record<string, string[]>) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.title = title;
    this.errors = errors;
  }
}

// Named describeError, not describe, to avoid clashing with Vitest's global.
export const describeError = (error: unknown) =>
  error instanceof ApiError ? error.message : String(error);

// Keyed by the DTO property name, which is Pascal-cased.
export function fieldError(error: unknown, field: string): string | undefined {
  if (!(error instanceof ApiError)) return undefined;
  return error.errors?.[field]?.[0];
}

type ProblemDetails = {
  title?: string;
  detail?: string;
  errors?: Record<string, string[]>;
};

export async function toApiError(response: Response): Promise<ApiError> {
  let problem: ProblemDetails = {};

  // A failing proxy may answer with HTML or nothing at all.
  try {
    problem = (await response.json()) as ProblemDetails;
  } catch {
    problem = {};
  }

  const message = problem.detail ?? problem.title ?? `HTTP ${response.status}`;
  return new ApiError(response.status, message, problem.title, problem.errors);
}

// Reduces the backend's ProblemDetails response to a single error type, so components
// deal with this type rather than with HTTP details.
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

type ProblemDetails = {
  title?: string;
  detail?: string;
  errors?: Record<string, string[]>;
};

export async function toApiError(response: Response): Promise<ApiError> {
  let problem: ProblemDetails = {};

  // A failing proxy or gateway answers with HTML, or with nothing at all.
  try {
    problem = (await response.json()) as ProblemDetails;
  } catch {
    problem = {};
  }

  const message = problem.detail ?? problem.title ?? `HTTP ${response.status}`;
  return new ApiError(response.status, message, problem.title, problem.errors);
}

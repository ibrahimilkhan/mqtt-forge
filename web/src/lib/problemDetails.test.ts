import { describe, expect, it } from 'vitest';
import { ApiError, toApiError } from './problemDetails';

// Builds the kind of response the backend's ProblemDetails middleware produces.
function problemResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/problem+json' },
  });
}

describe('toApiError', () => {
  it('prefers detail over title, matching what the old console displayed', async () => {
    const error = await toApiError(
      problemResponse(502, { title: 'Broker unreachable', detail: 'Connection refused' }),
    );

    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toBe('Connection refused');
    expect(error.title).toBe('Broker unreachable');
    expect(error.status).toBe(502);
  });

  it('carries the field errors FluentValidation returns', async () => {
    const error = await toApiError(
      problemResponse(400, {
        title: 'One or more validation errors occurred.',
        errors: { Host: ['Host is required'] },
      }),
    );

    expect(error.errors).toEqual({ Host: ['Host is required'] });
    expect(error.message).toBe('One or more validation errors occurred.');
  });

  it('carries the failure reason the connect endpoint adds', async () => {
    const error = await toApiError(
      problemResponse(502, { title: 'Could not connect to broker', detail: '...', reason: 'refused' }),
    );

    expect(error.reason).toBe('refused');
  });

  it('leaves the reason undefined on errors that carry none', async () => {
    const error = await toApiError(problemResponse(409, { title: 'Not connected' }));

    expect(error.reason).toBeUndefined();
  });

  it('falls back to the status when the body is not usable', async () => {
    const error = await toApiError(new Response('<html>gateway</html>', { status: 504 }));

    expect(error.message).toBe('HTTP 504');
    expect(error.status).toBe(504);
  });
});

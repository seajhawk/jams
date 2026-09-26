/**
 * An error a route handler turns into a JSON response with this status. Lives in its own module
 * (re-exported by `@/lib/api`) so low-level libraries such as the limit policy can throw it
 * without importing the auth chokepoint.
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** When set, the response carries `Retry-After` with this many seconds. */
    readonly retryAfterSeconds?: number
  ) {
    super(message)
  }
}

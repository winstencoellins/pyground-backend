import { Elysia, ValidationError } from "elysia";

/** Throw this from handlers. `code` is stable (the web translates it); `message` is for developers. */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export const errorBody = (code: string, message: string) => ({ error: { code, message } });

function classify(code: string | number, error: unknown): [number, string, string] {
  if (error instanceof ApiError) return [error.status, error.code, error.message];
  if (error instanceof ValidationError) {
    const first = error.all[0];
    const where = first && "path" in first && first.path ? `${first.path}: ` : "";
    return [400, "VALIDATION_ERROR", `${error.type} ${where}${first?.summary ?? "invalid"}`];
  }
  if (code === "NOT_FOUND") return [404, "NOT_FOUND", "Route not found"];
  if (code === "PARSE") return [400, "INVALID_BODY", "Request body could not be parsed"];
  console.error("Unhandled error:", error instanceof Error ? error.stack : error);
  return [500, "INTERNAL_ERROR", "Internal server error"];
}

/**
 * Turns every error into { error: { code, message } }. Unknown errors never leak details.
 * Returns a raw Response so set.headers (e.g. Retry-After) are kept and status is explicit.
 */
export const errorHandler = new Elysia({ name: "error-handler" }).onError(
  { as: "global" },
  ({ code, error, set }) => {
    const [status, errCode, message] = classify(code, error);
    const headers = new Headers();
    for (const [k, v] of Object.entries(set.headers)) if (v != null) headers.set(k, String(v));
    return Response.json(errorBody(errCode, message), { status, headers });
  },
);

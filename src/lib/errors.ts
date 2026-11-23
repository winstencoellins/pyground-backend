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

/** Turns every error into { error: { code, message } }. Unknown errors never leak details. */
export const errorHandler = new Elysia({ name: "error-handler" }).onError(
  { as: "global" },
  ({ code, error, set }) => {
    if (error instanceof ApiError) {
      set.status = error.status;
      return errorBody(error.code, error.message);
    }
    if (error instanceof ValidationError) {
      set.status = 400;
      const first = error.all[0];
      const where = first && "path" in first && first.path ? `${first.path}: ` : "";
      return errorBody("VALIDATION_ERROR", `${error.type} ${where}${first?.summary ?? "invalid"}`);
    }
    switch (code) {
      case "NOT_FOUND":
        set.status = 404;
        return errorBody("NOT_FOUND", "Route not found");
      case "PARSE":
        set.status = 400;
        return errorBody("INVALID_BODY", "Request body could not be parsed");
    }
    console.error("Unhandled error:", error instanceof Error ? error.stack : error);
    set.status = 500;
    return errorBody("INTERNAL_ERROR", "Internal server error");
  },
);

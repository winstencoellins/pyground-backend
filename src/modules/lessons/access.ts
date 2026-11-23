import { t } from "elysia";
import { ApiError } from "../../lib/errors";
import { DEFAULT_LOCALE, getCatalog } from "./content";

type AccessUser = { role?: string | null; accessUntil?: Date | string | null } | null | undefined;

export const slugParams = t.Object({ slug: t.String({ pattern: "^[a-z0-9-]+$", maxLength: 100 }) });

/** Paid content is open to ADMINs and to anyone whose pass hasn't expired. */
export function hasAccess(user: AccessUser, now = new Date()): boolean {
  if (!user) return false;
  if (user.role === "ADMIN") return true;
  return user.accessUntil != null && new Date(user.accessUntil) > now;
}

/** Throws 403 ACCESS_REQUIRED for a paid lesson the user can't open. */
export function assertCanOpen(lesson: { isFree: boolean }, user: AccessUser) {
  if (!lesson.isFree && !hasAccess(user)) {
    throw new ApiError(403, "ACCESS_REQUIRED", "An active access pass is required");
  }
}

/** The canonical (Indonesian) lesson, or 404 LESSON_NOT_FOUND; then the paywall check. */
export function requireOpenableLesson(slug: string, user: AccessUser) {
  const lesson = getCatalog().byLocale[DEFAULT_LOCALE].get(slug);
  if (!lesson) throw new ApiError(404, "LESSON_NOT_FOUND", `No lesson "${slug}"`);
  assertCanOpen(lesson, user);
  return lesson;
}

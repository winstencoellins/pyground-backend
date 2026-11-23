type AccessUser = { role?: string | null; accessUntil?: Date | string | null } | null | undefined;

/** Paid content is open to ADMINs and to anyone whose pass hasn't expired. */
export function hasAccess(user: AccessUser, now = new Date()): boolean {
  if (!user) return false;
  if (user.role === "ADMIN") return true;
  return user.accessUntil != null && new Date(user.accessUntil) > now;
}

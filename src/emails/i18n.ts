export type EmailLocale = "id" | "en";

/** User.locale (ID | EN) -> email language. Anything unexpected falls back to Indonesian. */
export const emailLocale = (user: { locale?: unknown }): EmailLocale =>
  user.locale === "EN" ? "en" : "id";

// Subjects only for now; React Email bodies arrive with Resend (task #28).
export const SUBJECTS = {
  verification: { id: "Verifikasi email Pyground-mu", en: "Verify your Pyground email" },
  passwordReset: { id: "Atur ulang kata sandi Pyground-mu", en: "Reset your Pyground password" },
} satisfies Record<string, Record<EmailLocale, string>>;

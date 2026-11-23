import { render } from "@react-email/render";
import type { ReactElement } from "react";
import { Resend } from "resend";

export type Mail = { to: string; subject: string; react: ReactElement; locale: string };

/**
 * Sends through Resend. Without RESEND_API_KEY: development prints the email (so links can be
 * clicked locally); production logs only that it wasn't sent, never the content or recipient.
 * Never throws: callers (auth hooks, webhook) must not fail because email is down.
 */
export async function sendEmail(mail: Mail): Promise<boolean> {
  const text = await render(mail.react, { plainText: true });
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    if (process.env.NODE_ENV === "production") {
      console.warn(`[email] "${mail.subject}" not sent: RESEND_API_KEY is not set`);
    } else {
      console.info(`[email] (${mail.locale}) "${mail.subject}" to ${mail.to}\n${text}`);
    }
    return false;
  }
  try {
    const { error } = await new Resend(key).emails.send({
      from: process.env.EMAIL_FROM || "Pyground <onboarding@resend.dev>",
      to: mail.to,
      subject: mail.subject,
      html: await render(mail.react),
      text,
    });
    if (error) throw new Error(`${error.name}: ${error.message}`);
    return true;
  } catch (err) {
    console.error(`[email] "${mail.subject}" failed:`, (err as Error).message);
    return false;
  }
}

// Daily cron (Railway: 0 1 * * * = 08:00 WIB): emails users whose pass ends in 3 days or today,
// by the Asia/Jakarta calendar. Safe to re-run: each (user, kind, accessUntil) is sent at most once.
import { expiryEmail } from "../emails";
import { sendEmail } from "../emails/send";
import type { ReminderKind } from "../generated/prisma/client";
import { prisma } from "../lib/prisma";

const DAY = 86_400_000;
const WIB = 7 * 60 * 60 * 1000; // Asia/Jakarta is UTC+7 all year (no DST)

/** [start, end) in UTC of the Jakarta calendar day that is `offsetDays` after `now`'s Jakarta day. */
export function jakartaDay(now: Date, offsetDays: number): [Date, Date] {
  const jakartaMidnight = Math.floor((now.getTime() + WIB) / DAY) * DAY - WIB;
  const start = jakartaMidnight + offsetDays * DAY;
  return [new Date(start), new Date(start + DAY)];
}

const JOBS: { kind: ReminderKind; template: "expiresSoon" | "expiresToday"; offsetDays: number }[] =
  [
    { kind: "EXPIRES_IN_3_DAYS", template: "expiresSoon", offsetDays: 3 },
    { kind: "EXPIRES_TODAY", template: "expiresToday", offsetDays: 0 },
  ];

export async function sendReminders(now = new Date()) {
  const counts = { EXPIRES_IN_3_DAYS: 0, EXPIRES_TODAY: 0, failed: 0 };
  for (const job of JOBS) {
    const [from, to] = jakartaDay(now, job.offsetDays);
    const users = await prisma.user.findMany({
      where: {
        accessUntil: { gte: from, lt: to },
        emailVerified: true,
        role: "STUDENT",
        reminderEmails: { none: { kind: job.kind, accessUntil: { gte: from, lt: to } } },
      },
    });
    for (const user of users) {
      const accessUntil = user.accessUntil!;
      // Claim first (unique constraint) so two overlapping runs can't both send.
      const claimed = await prisma.reminderEmail.createMany({
        data: [{ userId: user.id, kind: job.kind, accessUntil }],
        skipDuplicates: true,
      });
      if (claimed.count === 0) continue;
      const sent = await sendEmail(expiryEmail(job.template, user, accessUntil));
      if (sent) {
        counts[job.kind]++;
      } else {
        // Not delivered (Resend down or no API key): release the claim so a re-run can retry.
        await prisma.reminderEmail.deleteMany({
          where: { userId: user.id, kind: job.kind, accessUntil },
        });
        counts.failed++;
      }
    }
  }
  return counts;
}

if (import.meta.main) {
  const counts = await sendReminders();
  console.log(`[send-reminders] ${JSON.stringify(counts)}`);
  await prisma.$disconnect();
  process.exit(counts.failed ? 1 : 0);
}

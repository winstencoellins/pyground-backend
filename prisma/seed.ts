// Seeds one admin (always) and sample student data (never in production). Safe to re-run.
import { auth } from "../src/lib/auth";
import { prisma } from "../src/lib/prisma";

const DAY = 24 * 60 * 60 * 1000;

async function ensureUser(email: string, password: string, name: string) {
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return existing;
  const { user } = await auth.api.signUpEmail({ body: { email, password, name } });
  return prisma.user.findUniqueOrThrow({ where: { id: user.id } });
}

const adminEmail = process.env.SEED_ADMIN_EMAIL;
const adminPassword = process.env.SEED_ADMIN_PASSWORD;
if (!adminEmail || !adminPassword) {
  throw new Error("Set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD to seed the admin user");
}

const admin = await ensureUser(adminEmail, adminPassword, "Pyground Admin");
await prisma.user.update({
  where: { id: admin.id },
  data: { role: "ADMIN", emailVerified: true },
});
console.log(`admin: ${adminEmail}`);

if (process.env.NODE_ENV !== "production") {
  const student = await ensureUser("student@example.com", "student-password", "Siswa Contoh");
  const now = Date.now();

  await prisma.order.upsert({
    where: { orderId: "PYG-SEED-0001" },
    update: {},
    create: {
      userId: student.id,
      orderId: "PYG-SEED-0001",
      amount: 49_000,
      status: "PAID",
      paymentType: "qris",
      paidAt: new Date(now - 2 * DAY),
    },
  });
  await prisma.user.update({
    where: { id: student.id },
    // 30-day pass paid 2 days ago + 7-day admin grant below
    data: { emailVerified: true, accessUntil: new Date(now - 2 * DAY + 37 * DAY) },
  });

  for (const lessonSlug of ["what-is-programming", "variables-and-data-types"]) {
    await prisma.lessonProgress.upsert({
      where: { userId_lessonSlug: { userId: student.id, lessonSlug } },
      update: {},
      create: { userId: student.id, lessonSlug },
    });
  }

  if ((await prisma.quizAttempt.count({ where: { userId: student.id } })) === 0) {
    await prisma.quizAttempt.create({
      data: {
        userId: student.id,
        lessonSlug: "what-is-programming",
        score: 100,
        answers: [1, 2],
      },
    });
  }

  if ((await prisma.accessGrant.count({ where: { userId: student.id } })) === 0) {
    await prisma.accessGrant.create({
      data: { userId: student.id, grantedById: admin.id, days: 7, reason: "Seed: sample grant" },
    });
  }
  console.log("sample student: student@example.com / student-password");
}

await prisma.$disconnect();

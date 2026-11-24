import { Elysia, t } from "elysia";
import { prisma } from "../../lib/prisma";
import { limit } from "../../lib/rate-limit";
import { sessionPlugin } from "../../plugins/session";
import { requireOpenableLesson, slugParams } from "../lessons/access";
import { getCatalog } from "../lessons/content";

export const progressRoutes = new Elysia()
  .use(sessionPlugin)
  .get(
    "/api/progress",
    async ({ user }) => {
      const catalog = getCatalog();
      const rows = await prisma.lessonProgress.findMany({
        where: { userId: user.id },
        select: { lessonSlug: true, completedAt: true },
        orderBy: { completedAt: "asc" },
      });
      // Ignore progress for lessons that were renamed or removed from /content.
      const completed = rows
        .filter((r) => catalog.byLocale.id.has(r.lessonSlug))
        .map((r) => ({ slug: r.lessonSlug, completedAt: r.completedAt }));
      const done = new Set(completed.map((c) => c.slug));

      const stages = new Map<number, { stage: number; total: number; completed: number }>();
      for (const lesson of catalog.ordered) {
        const s = stages.get(lesson.stage) ?? { stage: lesson.stage, total: 0, completed: 0 };
        s.total++;
        if (done.has(lesson.slug)) s.completed++;
        stages.set(lesson.stage, s);
      }
      const percent = (n: number, total: number) => (total ? Math.round((n / total) * 100) : 0);
      return {
        completed,
        stages: [...stages.values()].map((s) => ({ ...s, percent: percent(s.completed, s.total) })),
        overall: percent(done.size, catalog.ordered.length),
      };
    },
    { auth: true },
  )
  .post(
    "/api/progress/:slug/complete",
    async ({ user, params }) => {
      requireOpenableLesson(params.slug, user);
      // Idempotent and race-safe: INSERT ... ON CONFLICT DO NOTHING keeps the first completedAt.
      const key = { userId: user.id, lessonSlug: params.slug };
      await prisma.lessonProgress.createMany({ data: [key], skipDuplicates: true });
      const row = await prisma.lessonProgress.findUniqueOrThrow({
        where: { userId_lessonSlug: key },
      });
      return { slug: row.lessonSlug, completedAt: row.completedAt };
    },
    { auth: true, params: slugParams, beforeHandle: limit("progress", 60, 60_000) },
  )
  .post(
    "/api/quiz/:slug/attempts",
    async ({ user, params, body }) => {
      requireOpenableLesson(params.slug, user);
      // shortcut: score is computed by the web and trusted; grade server-side if scores ever matter (certificates).
      const attempt = await prisma.quizAttempt.create({
        data: {
          userId: user.id,
          lessonSlug: params.slug,
          score: body.score,
          answers: body.answers,
        },
      });
      return {
        id: attempt.id,
        slug: attempt.lessonSlug,
        score: attempt.score,
        createdAt: attempt.createdAt,
      };
    },
    {
      auth: true,
      params: slugParams,
      beforeHandle: limit("quiz", 30, 60_000),
      // answers[i] = chosen option index for question i (null = skipped)
      body: t.Object({
        score: t.Integer({ minimum: 0, maximum: 100 }),
        answers: t.Array(t.Union([t.Integer({ minimum: 0, maximum: 50 }), t.Null()]), {
          maxItems: 100,
        }),
      }),
    },
  );

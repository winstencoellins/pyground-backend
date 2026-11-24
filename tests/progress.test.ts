import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { prisma } from "../src/lib/prisma";
import { call, cleanupUsers, createUser, type ErrorBody } from "./helpers";

const DAY = 86_400_000;
let student: { id: string; cookie: string };
let paid: { id: string; cookie: string };

beforeAll(async () => {
  spyOn(console, "info").mockImplementation(() => {});
  [student, paid] = await Promise.all([
    createUser(),
    createUser({ accessUntil: new Date(Date.now() + 10 * DAY) }),
  ]);
});
afterAll(cleanupUsers);

const complete = (slug: string, cookie?: string) =>
  call(`/api/progress/${slug}/complete`, { method: "POST", headers: cookie ? { cookie } : {} });
const attempt = (slug: string, json: unknown, cookie: string) =>
  call(`/api/quiz/${slug}/attempts`, { method: "POST", json, headers: { cookie } });

type Progress = {
  completed: { slug: string; completedAt: string }[];
  stages: { stage: number; total: number; completed: number; percent: number }[];
  overall: number;
};

describe("POST /api/progress/:slug/complete", () => {
  it("marks a free lesson complete, idempotently (keeps the first completedAt)", async () => {
    const first = (await (await complete("what-is-programming", student.cookie)).json()) as {
      completedAt: string;
    };
    const again = await complete("what-is-programming", student.cookie);
    expect(again.status).toBe(200);
    expect(((await again.json()) as { completedAt: string }).completedAt).toBe(first.completedAt);
    expect(await prisma.lessonProgress.count({ where: { userId: student.id } })).toBe(1);
  });

  it("concurrent repeats don't fail or duplicate", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => complete("for-loops", paid.cookie)),
    );
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect(
      await prisma.lessonProgress.count({ where: { userId: paid.id, lessonSlug: "for-loops" } }),
    ).toBe(1);
  });

  it("paid lesson without a pass -> 403 ACCESS_REQUIRED, nothing saved", async () => {
    const res = await complete("for-loops", student.cookie);
    expect(res.status).toBe(403);
    expect(((await res.json()) as ErrorBody).error.code).toBe("ACCESS_REQUIRED");
    expect(
      await prisma.lessonProgress.count({ where: { userId: student.id, lessonSlug: "for-loops" } }),
    ).toBe(0);
  });

  it("unknown lesson -> 404, no session -> 401", async () => {
    expect((await complete("nope", student.cookie)).status).toBe(404);
    expect((await complete("what-is-programming")).status).toBe(401);
  });
});

describe("GET /api/progress", () => {
  it("returns completed lessons and per-stage percentages", async () => {
    await complete("try-except", paid.cookie);
    const res = await call("/api/progress", { headers: { cookie: paid.cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Progress;
    expect(body.completed.map((c) => c.slug).sort()).toEqual(["for-loops", "try-except"]);
    expect(body.stages).toEqual([
      { stage: 1, total: 14, completed: 0, percent: 0 },
      { stage: 2, total: 1, completed: 1, percent: 100 },
      { stage: 3, total: 1, completed: 1, percent: 100 },
      { stage: 4, total: 1, completed: 0, percent: 0 },
    ]);
    expect(body.overall).toBe(12); // 2 of 17 lessons
  });

  it("ignores progress rows for lessons no longer in /content", async () => {
    await prisma.lessonProgress.create({
      data: { userId: student.id, lessonSlug: "deleted-lesson" },
    });
    const body = (await (
      await call("/api/progress", { headers: { cookie: student.cookie } })
    ).json()) as Progress;
    expect(body.completed.map((c) => c.slug)).toEqual(["what-is-programming"]);
    expect(body.overall).toBe(6); // 1 of 17 lessons
  });

  it("requires a session", async () => {
    expect((await call("/api/progress")).status).toBe(401);
  });
});

describe("POST /api/quiz/:slug/attempts", () => {
  it("saves score and answers; every attempt is kept", async () => {
    for (const score of [50, 100]) {
      const res = await attempt(
        "what-is-programming",
        { score, answers: [1, score === 100 ? 2 : null] },
        student.cookie,
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ slug: "what-is-programming", score });
    }
    const rows = await prisma.quizAttempt.findMany({
      where: { userId: student.id },
      orderBy: { createdAt: "asc" },
    });
    expect(rows.map((r) => [r.score, r.answers])).toEqual([
      [50, [1, null]],
      [100, [1, 2]],
    ]);
  });

  it("validates score range and answer shape", async () => {
    for (const json of [
      { score: 101, answers: [] },
      { score: -1, answers: [] },
      { score: 50.5, answers: [] },
      { score: 50, answers: ["a"] },
      { score: 50, answers: Array(101).fill(0) },
      { score: 50 },
    ]) {
      expect((await attempt("what-is-programming", json, student.cookie)).status).toBe(400);
    }
  });

  it("paid lesson without a pass -> 403", async () => {
    expect((await attempt("for-loops", { score: 100, answers: [1] }, student.cookie)).status).toBe(
      403,
    );
  });
});

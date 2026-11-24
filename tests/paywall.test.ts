import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { prisma } from "../src/lib/prisma";
import { hasAccess } from "../src/modules/lessons/access";
import { getCatalog } from "../src/modules/lessons/content";
import { call, cleanupUsers, createUser, type ErrorBody } from "./helpers";

const DAY = 86_400_000;
let expiring: { id: string; cookie: string };
let noPass: { id: string; cookie: string };

beforeAll(async () => {
  spyOn(console, "info").mockImplementation(() => {});
  [expiring, noPass] = await Promise.all([
    createUser({ accessUntil: new Date(Date.now() + DAY) }),
    createUser(),
  ]);
});
afterAll(cleanupUsers);

const paidLessons = () =>
  (["id", "en"] as const).flatMap((locale) =>
    [...getCatalog().byLocale[locale].values()]
      .filter((l) => !l.isFree)
      .map((l) => ({ locale, l })),
  );
/** Distinctive body text: the first non-heading line of the lesson. */
const snippetOf = (source: string) =>
  source
    .split("\n")
    .find((line) => line.trim() && !line.startsWith("#"))!
    .slice(0, 40);

describe("hasAccess boundaries", () => {
  const now = new Date("2026-01-01T00:00:00Z");
  it("no user, no pass, or a pass ending exactly now -> no access", () => {
    expect(hasAccess(null, now)).toBe(false);
    expect(hasAccess({ accessUntil: null }, now)).toBe(false);
    expect(hasAccess({ accessUntil: now }, now)).toBe(false);
  });
  it("a pass ending 1ms from now, or ADMIN without a pass -> access", () => {
    expect(hasAccess({ accessUntil: new Date(now.getTime() + 1) }, now)).toBe(true);
    expect(hasAccess({ role: "ADMIN", accessUntil: null }, now)).toBe(true);
    expect(hasAccess({ accessUntil: "2026-01-02T00:00:00Z" }, now)).toBe(true);
  });
});

describe("no paid lesson leaks", () => {
  it("covers every paid lesson in both locales (sanity)", () => {
    expect(paidLessons().length).toBe(12);
  });

  for (const who of ["anonymous", "signed in without a pass"] as const) {
    it(`${who}: every paid lesson -> 403 ACCESS_REQUIRED, body without lesson text`, async () => {
      for (const { locale, l } of paidLessons()) {
        const headers: Record<string, string> =
          who === "anonymous" ? {} : { cookie: noPass.cookie };
        const res = await call(`/api/lessons/${l.slug}?locale=${locale}`, { headers });
        const text = await res.text();
        expect({ slug: l.slug, locale, status: res.status }).toEqual({
          slug: l.slug,
          locale,
          status: 403,
        });
        expect((JSON.parse(text) as ErrorBody).error.code).toBe("ACCESS_REQUIRED");
        expect(text).not.toContain(snippetOf(l.source));
        expect(text).not.toContain("initialCode");
      }
    });
  }

  it("the course index exposes titles only, never lesson source", async () => {
    const text = await (await call("/api/lessons")).text();
    for (const { l } of paidLessons()) expect(text).not.toContain(snippetOf(l.source));
    expect(text).not.toContain("initialCode");
  });

  it("slug tricks don't bypass the check", async () => {
    for (const path of [
      "FOR-LOOPS",
      "for-loops%00",
      "for_loops",
      "for-loops.mdx",
      "..%2Ffor-loops",
    ]) {
      const res = await call(`/api/lessons/${path}`);
      expect({ path, ok: res.ok }).toEqual({ path, ok: false });
      expect(await res.text()).not.toContain("range(1, 6)");
    }
  });
});

describe("expiry takes effect on the next request (no stale session data)", () => {
  it("200 while active, 403 right after accessUntil passes, same session cookie", async () => {
    const headers = { cookie: expiring.cookie };
    expect((await call("/api/lessons/for-loops", { headers })).status).toBe(200);
    await prisma.user.update({
      where: { id: expiring.id },
      data: { accessUntil: new Date(Date.now() - 1000) },
    });
    expect((await call("/api/lessons/for-loops", { headers })).status).toBe(403);
    const idx = (await (await call("/api/lessons", { headers })).json()) as {
      stages: { modules: { lessons: { slug: string; locked: boolean }[] }[] }[];
    };
    const forLoops = idx.stages
      .flatMap((s) => s.modules.flatMap((m) => m.lessons))
      .find((l) => l.slug === "for-loops");
    expect(forLoops?.locked).toBe(true);
  });
});

describe("responses are never cacheable by shared caches", () => {
  it("lesson detail (200 and 403), index, progress and errors send Cache-Control: private, no-store", async () => {
    const responses = [
      await call("/api/lessons/what-is-programming"),
      await call("/api/lessons/for-loops"),
      await call("/api/lessons"),
      await call("/api/progress", { headers: { cookie: noPass.cookie } }),
      await call("/api/nope"),
    ];
    for (const res of responses) expect(res.headers.get("cache-control")).toBe("private, no-store");
  });
});

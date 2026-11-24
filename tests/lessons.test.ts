import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getCatalog, loadCatalog, resolveLesson } from "../src/modules/lessons/content";
import { call, cleanupUsers, createUser, type ErrorBody } from "./helpers";

const DAY = 86_400_000;
let withAccess: string, expired: string, admin: string;

beforeAll(async () => {
  spyOn(console, "info").mockImplementation(() => {}); // verification links on sign-up
  [withAccess, expired, admin] = await Promise.all([
    createUser({ accessUntil: new Date(Date.now() + 5 * DAY) }).then((u) => u.cookie),
    createUser({ accessUntil: new Date(Date.now() - DAY) }).then((u) => u.cookie),
    createUser({ role: "ADMIN" }).then((u) => u.cookie),
  ]);
});
afterAll(cleanupUsers);

describe("real content", () => {
  it("loads and validates every lesson in both locales", () => {
    const catalog = getCatalog();
    expect(catalog.ordered.map((l) => l.slug)).toEqual([
      "what-is-programming",
      "comments-and-errors",
      "variables",
      "data-types",
      "type-conversion",
      "arithmetic-operators",
      "user-input",
      "string-basics",
      "string-methods",
      "f-strings",
      "comparison-and-logic",
      "if-else",
      "elif",
      "cashier-project",
      "for-loops",
      "while-loops",
      "break-and-continue",
      "loop-patterns",
      "lists",
      "list-methods",
      "list-slicing",
      "tuples",
      "dictionaries",
      "dictionary-loops",
      "sets",
      "functions",
      "parameters-and-return",
      "default-and-keyword-arguments",
      "variable-scope",
      "reading-tracebacks",
      "common-errors",
      "debugging-techniques",
      "grade-book-project",
      "try-except",
      "raising-exceptions",
      "files-basics",
      "csv-files",
      "json-files",
      "modules-and-imports",
      "standard-library",
      "pip-and-venv",
      "list-comprehensions",
      "dict-and-set-comprehensions",
      "classes-and-objects",
      "instance-methods",
      "class-attributes",
      "inheritance",
      "special-methods",
      "dataclasses",
      "args-and-kwargs",
      "unpacking-arguments",
      "functions-as-objects",
      "decorators",
      "iterators",
      "generators",
      "datetime-basics",
      "http-requests",
      "type-hints",
      "testing-with-pytest",
      "expense-tracker-project",
      "how-the-web-works",
    ]);
    expect(catalog.byLocale.en.size).toBe(61);
  });

  it("every <Playground initialCode> is valid Python", () => {
    const snippets: [string, string][] = [];
    for (const locale of ["id", "en"] as const) {
      for (const lesson of getCatalog().byLocale[locale].values()) {
        // `<Playground expectError initialCode=...>` is a deliberate error for the learner to fix.
        for (const [, broken, code] of lesson.source.matchAll(
          /<Playground (expectError )?initialCode=\{`([\s\S]*?)`\}/g,
        )) {
          if (!broken) snippets.push([`${locale}/${lesson.slug}`, code!]);
        }
      }
    }
    expect(snippets.length).toBeGreaterThan(0);
    // One python3 process for all snippets (one per snippet is too slow as content grows).
    const check = `import json, sys
for name, code in json.load(sys.stdin):
    try:
        compile(code, name, "exec")
    except SyntaxError as e:
        print(f"{name}: {e}")`;
    const py = Bun.spawnSync(["python3", "-c", check], {
      stdin: new TextEncoder().encode(JSON.stringify(snippets)),
    });
    expect(py.stderr.toString()).toBe("");
    expect(py.stdout.toString()).toBe("");
  });
});

describe("loader validation + locale fallback", () => {
  let root: string;
  const write = (path: string, fm: Record<string, unknown>) => {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    const yaml = Object.entries(fm)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
      .join("\n");
    writeFileSync(file, `---\n${yaml}\n---\n# body\n`);
  };
  const base = {
    title: "T",
    slug: "a",
    stage: 1,
    module: "M",
    order: 1,
    isFree: true,
    estimatedMinutes: 5,
    description: "d",
  };

  beforeAll(() => (root = mkdtempSync(join(tmpdir(), "pyground-content-"))));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("falls back to Indonesian with fallbackLocale when the English file is missing", () => {
    write("id/1-x/01-m/a.mdx", base);
    write("id/1-x/01-m/b.mdx", { ...base, slug: "b", order: 2 });
    write("en/1-x/01-m/a.mdx", { ...base, title: "English" });
    const catalog = loadCatalog(root);
    expect(resolveLesson(catalog, "a", "en")).toMatchObject({
      locale: "en",
      lesson: { title: "English" },
    });
    expect(resolveLesson(catalog, "a", "en")?.fallbackLocale).toBeUndefined();
    expect(resolveLesson(catalog, "b", "en")).toMatchObject({ locale: "id", fallbackLocale: "id" });
    expect(resolveLesson(catalog, "b", "id")?.fallbackLocale).toBeUndefined();
    expect(resolveLesson(catalog, "nope", "en")).toBeNull();
  });

  it("rejects an English file that changes isFree (would bypass the paywall)", () => {
    write("en/1-x/01-m/b.mdx", { ...base, slug: "b", order: 2, isFree: false });
    write("en/1-x/01-m/a.mdx", { ...base, isFree: false });
    expect(() => loadCatalog(root)).toThrow('"isFree" differs from the id version');
  });

  it("rejects English-only lessons, slug/file mismatches and missing keys", () => {
    write("en/1-x/01-m/a.mdx", base);
    write("en/1-x/01-m/b.mdx", { ...base, slug: "b", order: 2 });
    write("en/1-x/01-m/c.mdx", { ...base, slug: "c" });
    write("id/1-x/01-m/d.mdx", { ...base, slug: "not-d" });
    write("id/1-x/01-m/e.mdx", { ...base, slug: "e", description: undefined });
    const err = (() => {
      try {
        loadCatalog(root);
      } catch (e) {
        return (e as Error).message;
      }
    })();
    expect(err).toContain("en/c: has no Indonesian (id) version");
    expect(err).toContain("slug must match the file name");
    expect(err).toContain('"description" must be a string');
  });
});

describe("GET /api/lessons", () => {
  type Index = {
    locale: string;
    stages: {
      stage: number;
      title: string;
      isFree: boolean;
      modules: { id: string; title: string; lessons: { slug: string; locked: boolean }[] }[];
    }[];
  };
  const lessons = (idx: Index) => idx.stages.flatMap((s) => s.modules.flatMap((m) => m.lessons));

  it("anonymous: Indonesian by default, paid lessons locked", async () => {
    const idx = (await (await call("/api/lessons")).json()) as Index;
    expect(idx.locale).toBe("id");
    expect(idx.stages.map((s) => [s.stage, s.title, s.isFree])).toEqual([
      [1, "Dasar-Dasar", true],
      [2, "Inti Pemula", false],
      [3, "Menengah", false],
      [4, "Pengembangan Web dengan Flask", false],
    ]);
    expect(idx.stages[0]!.modules[0]).toMatchObject({
      id: "01-what-is-programming",
      title: "Apa Itu Pemrograman",
    });
    expect(lessons(idx)[0]).toMatchObject({ slug: "what-is-programming", locked: false });
    const paidStages = idx.stages.slice(1).flatMap((s) => s.modules.flatMap((m) => m.lessons));
    expect(paidStages.length).toBe(47);
    expect(paidStages.every((l) => l.locked)).toBe(true);
    expect(idx.stages[0]!.modules.flatMap((m) => m.lessons).some((l) => l.locked)).toBe(false);
  });

  it("?locale=en returns English titles", async () => {
    const idx = (await (await call("/api/lessons?locale=en")).json()) as Index;
    expect(idx.locale).toBe("en");
    expect(idx.stages[0]!.title).toBe("Foundations");
    expect(idx.stages[0]!.modules[0]!.title).toBe("What Is Programming");
  });

  it("active pass or ADMIN unlocks everything; an expired pass doesn't", async () => {
    for (const cookie of [withAccess, admin]) {
      const idx = (await (await call("/api/lessons", { headers: { cookie } })).json()) as Index;
      expect(lessons(idx).every((l) => !l.locked)).toBe(true);
    }
    const idx = (await (
      await call("/api/lessons", { headers: { cookie: expired } })
    ).json()) as Index;
    expect(lessons(idx).filter((l) => l.locked).length).toBe(47);
  });

  it("rejects unknown locales", async () => {
    expect((await call("/api/lessons?locale=fr")).status).toBe(400);
  });
});

describe("GET /api/lessons/:slug", () => {
  type Detail = {
    locale: string;
    fallbackLocale?: string;
    frontmatter: Record<string, unknown>;
    source: string;
  };

  it("free lesson is public, with frontmatter and raw MDX", async () => {
    const res = await call("/api/lessons/what-is-programming?locale=en");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Detail;
    expect(body.locale).toBe("en");
    expect(body.fallbackLocale).toBeUndefined();
    expect(body.frontmatter).toEqual({
      title: "What Is Programming?",
      slug: "what-is-programming",
      stage: 1,
      module: "What Is Programming",
      order: 1,
      isFree: true,
      estimatedMinutes: 10,
      description: "Meet programming, Python, and your very first program, right in the browser.",
    });
    expect(body.source).toStartWith("\n# What Is Programming?");
    expect(body.source).not.toContain("isFree:");
  });

  it("paid lesson: 403 ACCESS_REQUIRED anonymously and with an expired pass", async () => {
    for (const headers of [{}, { cookie: expired }] as Record<string, string>[]) {
      const res = await call("/api/lessons/for-loops", { headers });
      expect(res.status).toBe(403);
      const body = (await res.json()) as ErrorBody;
      expect(body.error.code).toBe("ACCESS_REQUIRED");
      expect(JSON.stringify(body)).not.toContain("range(");
    }
  });

  it("paid lesson: 200 with an active pass or as ADMIN", async () => {
    for (const cookie of [withAccess, admin]) {
      const res = await call("/api/lessons/for-loops", { headers: { cookie } });
      expect(res.status).toBe(200);
      expect(((await res.json()) as Detail).source).toContain("range(1, 6)");
    }
  });

  it("unknown slug -> 404 LESSON_NOT_FOUND; malformed slug -> 400", async () => {
    const res = await call("/api/lessons/does-not-exist");
    expect(res.status).toBe(404);
    expect(((await res.json()) as ErrorBody).error.code).toBe("LESSON_NOT_FOUND");
    expect((await call("/api/lessons/..%2F..%2Fetc")).status).toBe(400);
  });
});

describe("locale fallback through the HTTP routes", () => {
  let root: string;
  const original = process.env.CONTENT_DIR;
  const lesson = (fm: Record<string, unknown>, body: string) =>
    `---\n${Object.entries(fm)
      .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
      .join("\n")}\n---\n${body}\n`;
  const fm = { stage: 1, module: "Modul", order: 1, estimatedMinutes: 5, description: "d" };

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "pyground-fallback-"));
    const put = (path: string, text: string) => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    };
    put(
      "id/1-x/01-m/terjemah.mdx",
      lesson({ ...fm, title: "Ada Terjemahan", slug: "terjemah", isFree: true }, "Isi ID"),
    );
    put(
      "en/1-x/01-m/terjemah.mdx",
      lesson(
        { ...fm, title: "Translated", slug: "terjemah", isFree: true, module: "Module" },
        "EN body",
      ),
    );
    put(
      "id/1-x/01-m/belum.mdx",
      lesson(
        { ...fm, title: "Belum Diterjemahkan", slug: "belum", isFree: true, order: 2 },
        "Hanya ID",
      ),
    );
    put(
      "id/2-y/01-m/berbayar.mdx",
      lesson(
        { ...fm, stage: 2, title: "Berbayar", slug: "berbayar", isFree: false },
        "Rahasia berbayar",
      ),
    );
    process.env.CONTENT_DIR = root;
  });
  afterAll(() => {
    if (original === undefined) delete process.env.CONTENT_DIR;
    else process.env.CONTENT_DIR = original;
    rmSync(root, { recursive: true, force: true });
  });

  it('detail: missing English -> Indonesian content with fallbackLocale: "id"', async () => {
    const body = (await (await call("/api/lessons/belum?locale=en")).json()) as Record<
      string,
      unknown
    >;
    expect(body).toMatchObject({ locale: "id", fallbackLocale: "id", source: "Hanya ID\n" });
    expect((body.frontmatter as { title: string }).title).toBe("Belum Diterjemahkan");
  });

  it("detail: existing English -> English, no fallbackLocale", async () => {
    const body = (await (await call("/api/lessons/terjemah?locale=en")).json()) as Record<
      string,
      unknown
    >;
    expect(body).toMatchObject({ locale: "en", source: "EN body\n" });
    expect(body.fallbackLocale).toBeUndefined();
  });

  it("index: flags only the untranslated lesson", async () => {
    const idx = (await (await call("/api/lessons?locale=en")).json()) as {
      stages: {
        modules: { lessons: { slug: string; title: string; fallbackLocale?: string }[] }[];
      }[];
    };
    const lessons = idx.stages.flatMap((s) => s.modules.flatMap((m) => m.lessons));
    expect(lessons.map((l) => [l.slug, l.title, l.fallbackLocale ?? null])).toEqual([
      ["terjemah", "Translated", null],
      ["belum", "Belum Diterjemahkan", "id"],
      ["berbayar", "Berbayar", "id"],
    ]);
  });

  it("the paywall still applies to fallback content", async () => {
    const res = await call("/api/lessons/berbayar?locale=en");
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain("Rahasia");
    const ok = await call("/api/lessons/berbayar?locale=en", { headers: { cookie: withAccess } });
    expect(await ok.json()).toMatchObject({ fallbackLocale: "id", source: "Rahasia berbayar\n" });
  });
});

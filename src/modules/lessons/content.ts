import { readdirSync, readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";

export const LOCALES = ["id", "en"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "id";

export type Frontmatter = {
  title: string;
  slug: string;
  stage: number;
  module: string;
  order: number;
  isFree: boolean;
  estimatedMinutes: number;
  description: string;
};
export type Lesson = Frontmatter & { stageDir: string; moduleDir: string; source: string };
export type Catalog = { byLocale: Record<Locale, Map<string, Lesson>>; ordered: Lesson[] };

export const STAGE_TITLES: Record<number, Record<Locale, string>> = {
  1: { id: "Dasar-Dasar", en: "Foundations" },
  2: { id: "Inti Pemula", en: "Beginner Core" },
  3: { id: "Menengah", en: "Intermediate" },
  4: { id: "Pengembangan Web dengan Flask", en: "Flask Web Development" },
};

const FIELDS: Record<keyof Frontmatter, "string" | "number" | "boolean"> = {
  title: "string",
  slug: "string",
  stage: "number",
  module: "string",
  order: "number",
  isFree: "boolean",
  estimatedMinutes: "number",
  description: "string",
};
// Must be identical across locales; isFree especially, since access is decided from it.
const SHARED: (keyof Lesson)[] = [
  "slug",
  "stage",
  "order",
  "isFree",
  "estimatedMinutes",
  "stageDir",
  "moduleDir",
];

function parse(file: string, root: string): Lesson {
  const where = relative(root, file);
  const raw = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(raw);
  if (!match) throw new Error(`${where}: missing --- frontmatter ---`);
  const fm = Bun.YAML.parse(match[1]!) as Record<string, unknown>;

  const extra = Object.keys(fm).filter((k) => !(k in FIELDS));
  if (extra.length) throw new Error(`${where}: unknown frontmatter keys ${extra.join(", ")}`);
  for (const [key, type] of Object.entries(FIELDS)) {
    if (typeof fm[key] !== type) throw new Error(`${where}: "${key}" must be a ${type}`);
  }
  const lesson = fm as Frontmatter;
  // <locale>/<n-stage>/<nn-module>/<slug>.mdx
  const [stageDir, moduleDir] = where.split("/").slice(1, 3) as [string, string];
  if (lesson.slug !== basename(file, ".mdx"))
    throw new Error(`${where}: slug must match the file name`);
  if (!/^[a-z0-9-]+$/.test(lesson.slug)) throw new Error(`${where}: slug must be kebab-case`);
  if (String(lesson.stage) !== stageDir.split("-")[0])
    throw new Error(`${where}: stage doesn't match folder`);
  return { ...lesson, stageDir, moduleDir, source: raw.slice(match[0].length) };
}

/** Reads and validates content/<locale>/<stage>/<module>/<slug>.mdx. Throws listing every problem. */
export function loadCatalog(root: string): Catalog {
  const errors: string[] = [];
  const byLocale = { id: new Map(), en: new Map() } as Catalog["byLocale"];

  for (const locale of LOCALES) {
    let files: string[] = [];
    try {
      files = readdirSync(join(root, locale), { recursive: true, encoding: "utf8" })
        .filter((f) => f.endsWith(".mdx"))
        .map((f) => join(root, locale, f));
    } catch {
      if (locale === DEFAULT_LOCALE) errors.push(`${root}/${locale} is missing`);
    }
    for (const file of files) {
      try {
        const lesson = parse(file, root);
        if (byLocale[locale].has(lesson.slug))
          throw new Error(`${relative(root, file)}: duplicate slug`);
        byLocale[locale].set(lesson.slug, lesson);
      } catch (e) {
        errors.push((e as Error).message);
      }
    }
  }

  for (const [slug, en] of byLocale.en) {
    const id = byLocale.id.get(slug);
    if (!id) {
      errors.push(`en/${slug}: has no Indonesian (id) version`);
      continue;
    }
    for (const key of SHARED) {
      if (en[key] !== id[key]) errors.push(`en/${slug}: "${key}" differs from the id version`);
    }
  }
  if (errors.length) throw new Error(`Invalid lesson content:\n- ${errors.join("\n- ")}`);

  const ordered = [...byLocale.id.values()].sort(
    (a, b) =>
      a.stageDir.localeCompare(b.stageDir) ||
      a.moduleDir.localeCompare(b.moduleDir) ||
      a.order - b.order,
  );
  return { byLocale, ordered };
}

const CONTENT_DIR = process.env.CONTENT_DIR ?? join(import.meta.dir, "../../../content");
let cached: Catalog | undefined;

/** Cached in production; reloaded per call in development so content edits show up immediately. */
export function getCatalog(): Catalog {
  if (process.env.NODE_ENV !== "production") return loadCatalog(CONTENT_DIR);
  return (cached ??= loadCatalog(CONTENT_DIR));
}

/** The lesson in `locale`, or the Indonesian original with fallbackLocale when no translation exists. */
export function resolveLesson(catalog: Catalog, slug: string, locale: Locale) {
  const lesson = catalog.byLocale[locale].get(slug);
  if (lesson) return { lesson, locale };
  const original = catalog.byLocale[DEFAULT_LOCALE].get(slug);
  return original
    ? { lesson: original, locale: DEFAULT_LOCALE, fallbackLocale: "id" as const }
    : null;
}

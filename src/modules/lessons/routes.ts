import { Elysia, t } from "elysia";
import { ApiError } from "../../lib/errors";
import { optionalUser } from "../../plugins/session";
import { assertCanOpen, hasAccess, slugParams } from "./access";
import { DEFAULT_LOCALE, getCatalog, resolveLesson, STAGE_TITLES, type Locale } from "./content";

// Not t.UnionEnum: Elysia fills a missing UnionEnum with its first value, which would hide the user's saved locale.
const localeQuery = t.Object({ locale: t.Optional(t.Union([t.Literal("id"), t.Literal("en")])) });

/** ?locale wins, then the signed-in user's saved locale, then Indonesian. */
const pickLocale = (query: { locale?: Locale }, user: { locale?: string | null } | null): Locale =>
  query.locale ?? (user?.locale?.toLowerCase() === "en" ? "en" : DEFAULT_LOCALE);

type IndexLesson = {
  title: string;
  slug: string;
  isFree: boolean;
  estimatedMinutes: number;
  locked: boolean;
  fallbackLocale?: "id";
};
type IndexModule = { id: string; title: string; lessons: IndexLesson[] };
type IndexStage = { stage: number; title: string; isFree: boolean; modules: IndexModule[] };

export const lessonRoutes = new Elysia({ prefix: "/api/lessons" })
  .get(
    "/",
    async ({ query, request }) => {
      const user = await optionalUser(request.headers);
      const locale = pickLocale(query, user);
      const unlocked = hasAccess(user);
      const catalog = getCatalog();
      const stages: IndexStage[] = [];

      for (const original of catalog.ordered) {
        const { lesson, fallbackLocale } = resolveLesson(catalog, original.slug, locale)!;
        let stage = stages.at(-1);
        if (stage?.stage !== original.stage) {
          stage = {
            stage: original.stage,
            title: STAGE_TITLES[original.stage]?.[locale] ?? `Stage ${original.stage}`,
            isFree: true,
            modules: [],
          };
          stages.push(stage);
        }
        let mod = stage.modules.at(-1);
        if (mod?.id !== original.moduleDir) {
          mod = { id: original.moduleDir, title: lesson.module, lessons: [] };
          stage.modules.push(mod);
        }
        stage.isFree &&= original.isFree;
        mod.lessons.push({
          title: lesson.title,
          slug: lesson.slug,
          isFree: original.isFree,
          estimatedMinutes: original.estimatedMinutes,
          locked: !original.isFree && !unlocked,
          ...(fallbackLocale ? { fallbackLocale } : {}),
        });
      }
      return { locale, stages };
    },
    { query: localeQuery },
  )
  .get(
    "/:slug",
    async ({ params, query, request }) => {
      const user = await optionalUser(request.headers);
      const resolved = resolveLesson(getCatalog(), params.slug, pickLocale(query, user));
      if (!resolved) throw new ApiError(404, "LESSON_NOT_FOUND", `No lesson "${params.slug}"`);
      const { lesson, locale, fallbackLocale } = resolved;
      assertCanOpen(lesson, user);
      const { title, slug, stage, module, order, isFree, estimatedMinutes, description } = lesson;
      return {
        locale,
        ...(fallbackLocale ? { fallbackLocale } : {}),
        frontmatter: { title, slug, stage, module, order, isFree, estimatedMinutes, description },
        source: lesson.source,
      };
    },
    {
      params: slugParams,
      query: localeQuery,
    },
  );

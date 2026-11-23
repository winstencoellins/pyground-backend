# Lesson content

```
content/<locale>/<n-stage>/<nn-module>/<slug>.mdx     locale: id (source of truth) | en
```

- Every lesson exists in `id/`. `en/` is optional per lesson; missing translations fall back to
  Indonesian and the API adds `"fallbackLocale": "id"`.
- File name = `slug` (kebab-case), identical in both locales and in the same folders.
- Folder prefixes set the order of stages and modules; `order` sorts lessons inside a module.
- The API refuses to start if content is invalid (bad frontmatter, slug mismatch, English-only
  lesson, or an English file whose `slug`/`stage`/`order`/`isFree`/`estimatedMinutes` differ
  from the Indonesian one). Run `bun test tests/lessons.test.ts` after editing; it also checks
  that every `<Playground initialCode>` is valid Python.
- Prettier ignores this folder on purpose (it breaks Python indentation inside template strings).

## Frontmatter (all keys required, no others)

```yaml
title: Apa Itu Pemrograman?          # localized
slug: what-is-programming            # same in id and en
stage: 1                             # 1-4, must match the stage folder
module: Apa Itu Pemrograman          # localized module title (shown in the course index)
order: 1                             # position inside the module
isFree: true                         # decides the paywall; must match across locales
estimatedMinutes: 10
description: One sentence, localized.
```

## Components (rendered by pyground-web)

| Component | Props |
| --- | --- |
| `<Playground initialCode={\`...\`} />` | Python run in the browser. Use a template literal for multi-line code. |
| `<Quiz questions={[{ question, options: string[], answer: index, explanation }]} />` | Multiple choice. |
| `<Callout type="tip\|warning\|info">…</Callout>` | Markdown children. |
| `<AnimatedDiagram name="…" caption="…" />` | `name` selects a diagram built in the web app. |
| `<VideoEmbed url="https://www.youtube.com/embed/…" title="…" />` | |
| `<TerminalBlock command="…" output={\`...\`} />` | `output` optional. |
| `<FileTree>{\`tree text\`}</FileTree>` | Plain text tree. |

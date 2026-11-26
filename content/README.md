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
- Inside `initialCode`, avoid backslashes (`\n`) and `${`: the template literal would eat them.
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
| `<Playground expectError initialCode={\`...\`} />` | Code with a deliberate error for the learner to fix (skipped by the valid-Python test). `expectError` must come first. |
| `<Quiz questions={[{ question, options: string[], answer: index, explanation }]} />` | Multiple choice. Add `code: \`...\`` to a question for "predict the output": the snippet shows above the options. |
| `<Callout type="tip\|warning\|info">…</Callout>` | Markdown children. |
| `<AnimatedDiagram name="…" caption="…" />` | `name` selects a diagram built in the web app. |
| `<Exercise type="guided\|challenge\|apply" title steps? starter? tests hints? solution reflect?>task (markdown)</Exercise>` | Hands-on problem with a "Check answer" button. `tests`: `[{ input?: string[], output }]`, compared to the printed output exactly (input() prompts are not printed during a check; trailing spaces/blank lines ignored). guided: `steps`, every test shown. challenge: no steps, only the first test shown, the rest hidden (cover an edge case). Hints open one at a time; the `solution` unlocks after one check; `reflect` shows once all tests pass. `bun test tests/lessons.test.ts` runs every solution against its tests and checks the starter doesn't already pass; every Stage 1 lesson needs one of each type. `apply`: no help at all (no `steps`, `hints` or `starter`; the editor starts empty), and the `solution` only unlocks once every test passes. Each Stage 1 module except the mini project ends with a `checkpoint-<topic>.mdx` lesson holding only `apply` exercises. |
| `<TerminalBlock command="…" output={\`...\`} />` | `output` optional. |
| `<FileTree>{\`tree text\`}</FileTree>` | Plain text tree. |

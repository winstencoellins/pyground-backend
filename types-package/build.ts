// Emits src/app.ts declarations and keeps only app.d.ts as dist/index.d.ts.
// Fails if the contract would need anything besides `elysia` (e.g. Prisma or Better Auth types).
import { $ } from "bun";

const dir = import.meta.dir;
await $`rm -rf ${dir}/dist && bunx tsc -p ${dir}/tsconfig.json`;
const dts = await Bun.file(`${dir}/dist/src/app.d.ts`).text();
await $`rm -rf ${dir}/dist/src`;

const modules = new Set([...dts.matchAll(/(?:from |import\()"([^"]+)"/g)].map((m) => m[1]!));
const leaked = [...modules].filter((m) => m !== "elysia" && !m.startsWith("elysia/"));
if (leaked.length) {
  console.error(`App type references modules consumers won't have: ${leaked.join(", ")}`);
  process.exit(1);
}
if (!/export type App\b/.test(dts)) throw new Error("`export type App` missing from src/app.ts");

await Bun.write(`${dir}/dist/index.d.ts`, dts);
console.log(
  `types-package/dist/index.d.ts (${(dts.length / 1024).toFixed(0)} KB), imports: ${[...modules].join(", ")}`,
);

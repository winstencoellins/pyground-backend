// Daily cron: pg_dump (custom format) -> S3-compatible bucket (Cloudflare R2, AWS S3, Backblaze B2, ...).
// Restore: pg_restore --clean --no-owner -d "$DATABASE_URL" pyground-YYYYMMDD-HHMMSSZ.dump
// shortcut: no retention logic here; set a lifecycle rule on the bucket (e.g. expire after 30 days).
import { S3Client } from "bun";
import { rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** pyground/2026/11/pyground-20261124-010000Z.dump (UTC, sorts chronologically). */
export function backupKey(now: Date): string {
  const iso = now.toISOString(); // 2026-11-24T01:00:00.000Z
  const [y, m] = [iso.slice(0, 4), iso.slice(5, 7)];
  const stamp = iso.slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
  return `pyground/${y}/${m}/pyground-${stamp}Z.dump`;
}

/** postgresql://user:pass@host:port/db?sslmode=x -> libpq env vars, so the password never appears in `ps`. */
export function pgEnv(databaseUrl: string): Record<string, string> {
  const url = new URL(databaseUrl);
  const env: Record<string, string> = {
    PGHOST: url.hostname,
    PGPORT: url.port || "5432",
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
  };
  const sslmode = url.searchParams.get("sslmode");
  if (sslmode) env.PGSSLMODE = sslmode;
  return env;
}

export function s3FromEnv(env = process.env): S3Client {
  const missing = [
    "BACKUP_S3_ENDPOINT",
    "BACKUP_S3_BUCKET",
    "BACKUP_S3_ACCESS_KEY_ID",
    "BACKUP_S3_SECRET_ACCESS_KEY",
  ].filter((k) => !env[k]);
  if (missing.length) throw new Error(`Backup not configured, missing: ${missing.join(", ")}`);
  return new S3Client({
    endpoint: env.BACKUP_S3_ENDPOINT,
    bucket: env.BACKUP_S3_BUCKET,
    accessKeyId: env.BACKUP_S3_ACCESS_KEY_ID,
    secretAccessKey: env.BACKUP_S3_SECRET_ACCESS_KEY,
    region: env.BACKUP_S3_REGION || "auto",
  });
}

export async function runBackup(opts: {
  databaseUrl: string;
  s3: S3Client;
  now?: Date;
  pgDump?: string;
}) {
  const key = backupKey(opts.now ?? new Date());
  const file = join(tmpdir(), `pyground-backup-${crypto.randomUUID()}.dump`);
  const secret = pgEnv(opts.databaseUrl).PGPASSWORD;
  const redact = (text: string) => (secret ? text.replaceAll(secret, "***") : text);
  try {
    const proc = Bun.spawn(
      [
        opts.pgDump ?? process.env.PG_DUMP_PATH ?? "pg_dump",
        "--format=custom",
        "--no-owner",
        "--no-privileges",
        `--file=${file}`,
      ],
      { env: { ...process.env, ...pgEnv(opts.databaseUrl) }, stdout: "ignore", stderr: "pipe" },
    );
    const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    if (code !== 0)
      throw new Error(`pg_dump exited with ${code}: ${redact(stderr.trim()).slice(0, 500)}`);
    const { size } = await stat(file);
    if (size === 0) throw new Error("pg_dump produced an empty file");
    await opts.s3.write(key, Bun.file(file));
    return { key, bytes: size };
  } finally {
    await rm(file, { force: true });
  }
}

if (import.meta.main) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is not set");
  try {
    const { key, bytes } = await runBackup({ databaseUrl, s3: s3FromEnv() });
    console.log(`[backup] uploaded ${key} (${(bytes / 1024).toFixed(0)} KB)`);
  } catch (err) {
    console.error(`[backup] failed: ${(err as Error).message}`);
    process.exit(1);
  }
}

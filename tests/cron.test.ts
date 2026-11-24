import { afterAll, afterEach, beforeAll, describe, expect, it, mock, spyOn } from "bun:test";
import { S3Client } from "bun";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupKey, pgEnv, runBackup } from "../src/cron/backup";
import { jakartaDay, sendReminders } from "../src/cron/send-reminders";
import { prisma } from "../src/lib/prisma";
import { cleanupUsers, createUser } from "./helpers";

const DAY = 86_400_000;
const HOUR = 3_600_000;

describe("jakartaDay (Asia/Jakarta = UTC+7)", () => {
  it("08:00 WIB run: today is 17:00Z the previous UTC day", () => {
    const now = new Date("2026-11-24T01:00:00Z"); // 08:00 WIB, 24 Nov
    expect(jakartaDay(now, 0).map((d) => d.toISOString())).toEqual([
      "2026-11-23T17:00:00.000Z",
      "2026-11-24T17:00:00.000Z",
    ]);
    expect(jakartaDay(now, 3)[0].toISOString()).toBe("2026-11-26T17:00:00.000Z");
  });
  it("just after Jakarta midnight belongs to the new Jakarta day", () => {
    expect(jakartaDay(new Date("2026-11-23T17:30:00Z"), 0)[0].toISOString()).toBe(
      "2026-11-23T17:00:00.000Z",
    );
    expect(jakartaDay(new Date("2026-11-23T16:59:59Z"), 0)[0].toISOString()).toBe(
      "2026-11-22T17:00:00.000Z",
    );
  });
});

describe("sendReminders", () => {
  // A fixed run time far in the future so only this file's users fall in the windows.
  const NOW = new Date("2031-03-10T01:00:00Z"); // 08:00 WIB, 10 Mar 2031
  const [today] = jakartaDay(NOW, 0);
  const realFetch = globalThis.fetch;
  const sent: { to: string; subject: string }[] = [];
  let resendDown = false;
  const users: Record<string, string> = {};
  const make = async (name: string, data: Parameters<typeof createUser>[0]) => {
    const u = await createUser(data);
    users[name] = u.email;
    return u;
  };
  // Only reminder emails (createUser also triggers a verification email through the same mock).
  const sentTo = (name: string) =>
    sent.filter((m) => m.to === users[name] && !/Verif/.test(m.subject)).map((m) => m.subject);

  beforeAll(async () => {
    spyOn(console, "info").mockImplementation(() => {});
    spyOn(console, "error").mockImplementation(() => {});
    process.env.RESEND_API_KEY = "re_test";
    globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(String(input), init);
      if (!req.url.startsWith("https://api.resend.com")) return realFetch(input, init);
      if (resendDown)
        return Response.json({ name: "application_error", message: "down" }, { status: 500 });
      const body = (await req.json()) as { to: string; subject: string };
      sent.push({ to: String(body.to), subject: body.subject });
      return Response.json({ id: "e" });
    }) as unknown as typeof fetch;

    await Promise.all([
      make("in3days", {
        accessUntil: new Date(today.getTime() + 3 * DAY + 10 * HOUR),
        locale: "EN",
      }),
      make("todayLater", { accessUntil: new Date(today.getTime() + 20 * HOUR) }),
      make("todayEarlier", { accessUntil: new Date(today.getTime() + 2 * HOUR) }), // already passed at 08:00 WIB
      make("in2days", { accessUntil: new Date(today.getTime() + 2 * DAY + HOUR) }),
      make("in4days", { accessUntil: new Date(today.getTime() + 4 * DAY + HOUR) }),
      make("noPass", { accessUntil: null }),
      make("admin", { accessUntil: new Date(today.getTime() + 20 * HOUR), role: "ADMIN" }),
    ]);
    const unverified = await make("unverified", {
      accessUntil: new Date(today.getTime() + 20 * HOUR),
    });
    await prisma.user.update({ where: { id: unverified.id }, data: { emailVerified: false } });
  });
  afterEach(() => (sent.length = 0));
  afterAll(async () => {
    globalThis.fetch = realFetch;
    delete process.env.RESEND_API_KEY;
    await cleanupUsers();
  });

  it("sends the right email to the right users, in their language", async () => {
    const counts = await sendReminders(NOW);
    expect(counts).toEqual({ EXPIRES_IN_3_DAYS: 1, EXPIRES_TODAY: 2, failed: 0 });
    expect(sentTo("in3days")).toEqual(["Your Pyground access ends in 3 days"]);
    expect(sentTo("todayLater")).toEqual(["Akses Pyground-mu berakhir hari ini"]);
    expect(sentTo("todayEarlier")).toEqual(["Akses Pyground-mu berakhir hari ini"]);
    for (const n of ["in2days", "in4days", "noPass", "admin", "unverified"])
      expect(sentTo(n)).toEqual([]);
  });

  it("re-running the same day sends nothing", async () => {
    expect(await sendReminders(NOW)).toEqual({ EXPIRES_IN_3_DAYS: 0, EXPIRES_TODAY: 0, failed: 0 });
  });

  it("overlapping runs don't double-send", async () => {
    const u = await make("overlap", {
      accessUntil: new Date(today.getTime() + 3 * DAY + 5 * HOUR),
    });
    await Promise.all([sendReminders(NOW), sendReminders(NOW), sendReminders(NOW)]);
    expect(sentTo("overlap")).toHaveLength(1);
    expect(await prisma.reminderEmail.count({ where: { userId: u.id } })).toBe(1);
  });

  it("a renewal (new accessUntil) re-arms the reminders", async () => {
    const u = await prisma.user.findUniqueOrThrow({ where: { email: users.in3days } });
    // Renewed, then 30 days later the new expiry is 3 days away again.
    await prisma.user.update({
      where: { id: u.id },
      data: { accessUntil: new Date(u.accessUntil!.getTime() + 30 * DAY) },
    });
    await sendReminders(new Date(NOW.getTime() + 30 * DAY));
    expect(sentTo("in3days")).toEqual(["Your Pyground access ends in 3 days"]);
  });

  it("a failed delivery is retried by the next run", async () => {
    await make("flaky", { accessUntil: new Date(today.getTime() + 3 * DAY + 2 * HOUR) });
    resendDown = true;
    expect((await sendReminders(NOW)).failed).toBe(1);
    resendDown = false;
    expect((await sendReminders(NOW)).EXPIRES_IN_3_DAYS).toBe(1);
    expect(sentTo("flaky")).toHaveLength(1);
  });
});

describe("backup", () => {
  let dir: string;
  let server: ReturnType<typeof Bun.serve>;
  const uploads: { path: string; body: string }[] = [];
  const url = "postgresql://pyuser:s3cr%40t-pass@db.internal:6543/pydb?sslmode=require";

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "pyground-backup-test-"));
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        uploads.push({ path: new URL(req.url).pathname, body: await req.text() });
        return new Response(null, { status: 200, headers: { etag: '"x"' } });
      },
    });
  });
  afterAll(() => {
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  });

  const fakePgDump = (script: string) => {
    const path = join(dir, `pg_dump-${crypto.randomUUID()}`);
    writeFileSync(path, `#!/bin/sh\n${script}\n`);
    chmodSync(path, 0o755);
    return path;
  };
  const s3 = () =>
    new S3Client({
      endpoint: `http://localhost:${server.port}`,
      bucket: "backups",
      accessKeyId: "k",
      secretAccessKey: "s",
      region: "auto",
    });

  it("backupKey is dated UTC and sorts chronologically", () => {
    expect(backupKey(new Date("2026-11-24T01:00:05Z"))).toBe(
      "pyground/2026/11/pyground-20261124-010005Z.dump",
    );
  });

  it("pgEnv passes credentials as libpq env vars (not argv), URL-decoded", () => {
    expect(pgEnv(url)).toEqual({
      PGHOST: "db.internal",
      PGPORT: "6543",
      PGUSER: "pyuser",
      PGPASSWORD: "s3cr@t-pass",
      PGDATABASE: "pydb",
      PGSSLMODE: "require",
    });
  });

  it("dumps with pg_dump and uploads the file to the bucket", async () => {
    const envOut = join(dir, "env.txt");
    const pgDump = fakePgDump(
      `for a in "$@"; do case "$a" in --file=*) f="\${a#--file=}";; esac; done\n` +
        `echo "$PGHOST $PGUSER $PGPASSWORD $PGDATABASE $*" > ${envOut}\nprintf 'PGDMP-fake-dump' > "$f"`,
    );
    const result = await runBackup({
      databaseUrl: url,
      s3: s3(),
      pgDump,
      now: new Date("2026-11-24T01:00:00Z"),
    });
    expect(result).toEqual({ key: "pyground/2026/11/pyground-20261124-010000Z.dump", bytes: 15 });
    expect(uploads.at(-1)).toEqual({
      path: "/backups/pyground/2026/11/pyground-20261124-010000Z.dump",
      body: "PGDMP-fake-dump",
    });
    const seen = readFileSync(envOut, "utf8");
    expect(seen).toStartWith("db.internal pyuser s3cr@t-pass pydb --format=custom");
    expect(seen.split(" pydb ")[1]).not.toContain("s3cr@t-pass"); // password only in env, never in argv
    expect(
      readdirSync(tmpdir()).some((f) => f.startsWith("pyground-backup-") && f.endsWith(".dump")),
    ).toBe(false); // temp file removed
  });

  it("pg_dump failure: error is redacted, nothing uploaded, temp file removed", async () => {
    const before = uploads.length;
    const pgDump = fakePgDump(
      `echo "connection to db.internal failed: password s3cr@t-pass rejected" >&2\nexit 1`,
    );
    const err = await runBackup({ databaseUrl: url, s3: s3(), pgDump }).catch((e: Error) => e);
    expect(String(err)).toContain("pg_dump exited with 1");
    expect(String(err)).not.toContain("s3cr@t-pass");
    expect(uploads.length).toBe(before);
    expect(
      readdirSync(tmpdir()).some((f) => f.startsWith("pyground-backup-") && f.endsWith(".dump")),
    ).toBe(false);
  });

  it("empty dump is refused", async () => {
    const pgDump = fakePgDump(
      `for a in "$@"; do case "$a" in --file=*) : > "\${a#--file=}";; esac; done`,
    );
    expect(
      String(await runBackup({ databaseUrl: url, s3: s3(), pgDump }).catch((e: Error) => e)),
    ).toContain("empty");
  });
});

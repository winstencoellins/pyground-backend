import { app } from "./app";
import { checkProductionConfig } from "./lib/config-check";
import { prisma } from "./lib/prisma";

if (process.env.NODE_ENV === "production") {
  const { errors, warnings } = checkProductionConfig();
  for (const w of warnings) console.warn(`[config] warning: ${w}`);
  if (errors.length) {
    for (const e of errors) console.error(`[config] error: ${e}`);
    process.exit(1);
  }
}

const port = Number(process.env.PORT ?? 3001);
app.listen({
  port,
  // "::" listens on IPv6 and IPv4; Railway's private network (web -> api) uses IPv6.
  hostname: process.env.HOST ?? "::",
  // Largest legitimate body is a quiz attempt or Midtrans notification (a few KB).
  maxRequestBodySize: 1024 * 1024,
});
console.log(`pyground-api listening on :${port}`);

// Railway/Docker stop with SIGTERM. As PID 1, Bun would otherwise ignore it and get SIGKILLed mid-request.
let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    console.log(`[shutdown] ${signal}: finishing in-flight requests`);
    await app.stop(); // stops accepting new connections, lets active requests finish
    await prisma.$disconnect();
    process.exit(0);
  });
}

import { app } from "./app";

const port = Number(process.env.PORT ?? 3001);
// "::" listens on IPv6 and IPv4; Railway's private network (web -> api) uses IPv6.
app.listen({ port, hostname: process.env.HOST ?? "::" });
console.log(`pyground-api listening on :${port}`);

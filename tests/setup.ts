// Loaded before every test file (bunfig.toml). Bun reads .env, so a developer's real keys would otherwise be
// used by tests: never send real email from tests (they use fake @example.com addresses).
delete process.env.RESEND_API_KEY;

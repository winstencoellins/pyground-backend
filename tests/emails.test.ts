import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { render } from "@react-email/render";
import { authEmail, receiptEmail } from "../src/emails";
import { sendEmail } from "../src/emails/send";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.RESEND_API_KEY;
  delete process.env.EMAIL_FROM;
});

const user = (locale: "ID" | "EN") => ({ email: "budi@example.com", name: "Budi", locale });
const order = {
  orderId: "PYG-ABC-12345678",
  amount: 49000,
  paidAt: new Date("2026-11-23T03:00:00Z"), // 10:00 WIB
  paymentType: "qris",
  accessUntil: new Date("2026-12-23T03:00:00Z"),
};
const text = (mail: { react: Parameters<typeof render>[0] }) =>
  render(mail.react, { plainText: true });

describe("templates (both languages)", () => {
  it("verification: subject, greeting, link, Trixync footer", async () => {
    const id = authEmail(
      "verification",
      user("ID"),
      "http://localhost:3000/api/auth/verify-email?token=t1",
    );
    const en = authEmail(
      "verification",
      user("EN"),
      "http://localhost:3000/api/auth/verify-email?token=t1",
    );
    expect([id.subject, en.subject]).toEqual([
      "Verifikasi email Pyground-mu",
      "Verify your Pyground email",
    ]);
    expect(await text(id)).toContain("Halo Budi,");
    expect(await text(id)).toContain("Didukung oleh Trixync");
    expect(await text(en)).toContain("Hi Budi,");
    expect(await text(en)).toContain("Supported by Trixync");
    expect(await text(en)).toContain("verify-email?token=t1");
    expect(await render(en.react)).toContain('lang="en"');
  });

  it("password reset: both languages, mentions signing out everywhere", async () => {
    const id = authEmail("passwordReset", user("ID"), "http://x/reset?token=r");
    const en = authEmail("passwordReset", user("EN"), "http://x/reset?token=r");
    expect(id.subject).toBe("Atur ulang kata sandi Pyground-mu");
    expect(await text(id)).toContain("keluar dari semua perangkat");
    expect(en.subject).toBe("Reset your Pyground password");
    expect(await text(en)).toContain("signed out on all devices");
  });

  it("receipt: order details in Rupiah and WIB, processed by Trixync", async () => {
    const id = await text(receiptEmail(user("ID"), order));
    expect(receiptEmail(user("ID"), order).subject).toBe(
      "Kwitansi pembayaran Pyground PYG-ABC-12345678",
    );
    expect(id).toMatch(/Rp\s?49\.000/);
    expect(id).toContain("10.00 WIB");
    expect(id).toContain("QRIS");
    expect(id).toContain("Pembayaran diproses oleh Trixync.");
    expect(id).toContain("Didukung oleh Trixync");

    const en = await text(receiptEmail(user("EN"), order));
    expect(en).toContain("Payments are processed by Trixync.");
    expect(en).toContain("23 December 2026");
    expect(en).toContain("Supported by Trixync");
  });

  it("unknown user locale falls back to Indonesian", () => {
    expect(authEmail("verification", { email: "a@b.c", name: "A", locale: null }, "u").locale).toBe(
      "id",
    );
  });
});

describe("sendEmail", () => {
  const mail = () =>
    authEmail("verification", user("EN"), "http://localhost:3000/verify?token=abc");

  it("posts html + text to Resend with EMAIL_FROM", async () => {
    process.env.RESEND_API_KEY = "re_test_123";
    process.env.EMAIL_FROM = "Pyground <noreply@pyground.test>";
    const calls: { url: string; body: Record<string, unknown>; auth: string | null }[] = [];
    globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(String(input), init);
      calls.push({
        url: req.url,
        body: (await req.json()) as Record<string, unknown>,
        auth: req.headers.get("authorization"),
      });
      return Response.json({ id: "email_1" });
    }) as unknown as typeof fetch;

    expect(await sendEmail(mail())).toBe(true);
    // Ignore background emails from other test files that may hit the mock meanwhile.
    const mine = calls.filter((c) => c.body.to === "budi@example.com");
    expect(mine).toHaveLength(1);
    expect(mine[0]!.url).toBe("https://api.resend.com/emails");
    expect(mine[0]!.auth).toBe("Bearer re_test_123");
    expect(mine[0]!.body).toMatchObject({
      from: "Pyground <noreply@pyground.test>",
      to: "budi@example.com",
      subject: "Verify your Pyground email",
    });
    expect(String(mine[0]!.body.html)).toContain("<html");
    expect(String(mine[0]!.body.text)).toContain("verify?token=abc");
  });

  it("a Resend failure returns false and never throws", async () => {
    process.env.RESEND_API_KEY = "re_test_123";
    const err = spyOn(console, "error").mockImplementation(() => {});
    globalThis.fetch = mock(async () =>
      Response.json({ name: "validation_error", message: "Invalid from" }, { status: 422 }),
    ) as unknown as typeof fetch;
    expect(await sendEmail(mail())).toBe(false);
    globalThis.fetch = mock(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await sendEmail(mail())).toBe(false);
    expect(String(err.mock.calls.at(-1))).not.toContain("re_test_123");
    err.mockRestore();
  });

  it("no API key in development: prints the email instead", async () => {
    const info = spyOn(console, "info").mockImplementation(() => {});
    expect(await sendEmail(mail())).toBe(false);
    // Other files' background emails may log meanwhile, so look for this one specifically.
    const logged = info.mock.calls
      .map((c) => String(c[0]))
      .find((m) => m.includes("budi@example.com"));
    expect(logged).toContain('(en) "Verify your Pyground email" to budi@example.com');
    info.mockRestore();
  });
});

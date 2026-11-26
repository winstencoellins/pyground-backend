import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { checkProductionConfig } from "../src/lib/config-check";
import { prisma } from "../src/lib/prisma";
import {
  checkSuffix,
  codeFor,
  newCodeSecret,
  parseCode,
  suffixFor,
  todaysCode,
} from "../src/modules/marketing/codes";
import { codePricing } from "../src/modules/marketing/settings";
import { cleanupUsers, createUser } from "./helpers";

const rina = { handle: "RINA", codeSecret: newCodeSecret() };
const env = { ...process.env };
afterEach(() => {
  process.env = { ...env };
});

/** 2026-11-26 00:00 WIB = 2026-11-25T17:00Z. */
const midnightWib = new Date("2026-11-25T17:00:00Z");
const at = (iso: string) => new Date(iso);

describe("daily codes", () => {
  it("HANDLE-XXXXX with 5 unambiguous characters, stable within a Jakarta day", () => {
    const { code } = todaysCode(rina, at("2026-11-25T17:00:00Z"));
    expect(code).toMatch(/^RINA-[A-HJ-NP-Z2-9]{5}$/);
    expect(todaysCode(rina, at("2026-11-26T16:59:59Z")).code).toBe(code); // 23:59:59 WIB, same day
  });

  it("changes at exactly 00:00 WIB and says when", () => {
    const before = todaysCode(rina, new Date(midnightWib.getTime() - 1));
    const after = todaysCode(rina, midnightWib);
    expect(after.code).not.toBe(before.code);
    expect(before.rotatesAt).toEqual(midnightWib);
    expect(after.rotatesAt).toEqual(at("2026-11-26T17:00:00Z"));
  });

  it("differs per marketer, even with the same handle", () => {
    const other = { handle: "RINA", codeSecret: newCodeSecret() };
    expect(codeFor(other, 20000)).not.toBe(codeFor(rina, 20000));
  });

  it("today's code is valid; yesterday's until 06:00 WIB, then expired", () => {
    const yesterday = todaysCode(rina, new Date(midnightWib.getTime() - 1)).code.slice(5);
    const today = todaysCode(rina, midnightWib).code.slice(5);
    expect(checkSuffix(rina, today, midnightWib)).toBe("valid");
    expect(checkSuffix(rina, yesterday, at("2026-11-25T22:59:59Z"))).toBe("valid"); // 05:59:59 WIB
    expect(checkSuffix(rina, yesterday, at("2026-11-25T23:00:00Z"))).toBe("expired"); // 06:00 WIB
    expect(checkSuffix(rina, today, new Date(midnightWib.getTime() - 1))).toBe("invalid"); // tomorrow's
  });

  it("codes from the last 30 days read as expired, older ones and guesses as invalid", () => {
    const day = Math.floor((midnightWib.getTime() + 7 * 3_600_000) / 86_400_000);
    expect(checkSuffix(rina, suffixFor(rina.codeSecret, day - 10), midnightWib)).toBe("expired");
    expect(checkSuffix(rina, suffixFor(rina.codeSecret, day - 31), midnightWib)).toBe("invalid");
    const guess = suffixFor(newCodeSecret(), day);
    expect(checkSuffix(rina, guess, midnightWib)).toBe("invalid");
  });

  it("a new secret revokes every code", () => {
    const { code } = todaysCode(rina, midnightWib);
    const reset = { ...rina, codeSecret: newCodeSecret() };
    expect(checkSuffix(reset, code.slice(5), midnightWib)).toBe("invalid");
  });
});

describe("parseCode", () => {
  it("accepts case, spaces and a missing hyphen", () => {
    for (const input of ["RINA-7K3QX", "rina-7k3qx", "  RINA 7K3QX ", "rina7k3qx"]) {
      expect(parseCode(input)).toEqual({ handle: "RINA", suffix: "7K3QX" });
    }
  });
  it("rejects what can't be a code", () => {
    for (const input of [
      "",
      "RINA",
      "RI-7K3QX",
      "RINA-7K3Q0",
      "RINA-7K3QI",
      "TOOLONGHANDLE1-7K3QX",
      "RINA_-7K3QX",
    ]) {
      expect(parseCode(input)).toBeNull();
    }
  });
});

describe("pricing", () => {
  it("defaults: 10% off for the buyer, 20% of the paid amount for the marketer", () => {
    delete process.env.MARKETING_DISCOUNT_PERCENT;
    delete process.env.MARKETING_COMMISSION_PERCENT;
    expect(codePricing(49000)).toEqual({
      listPrice: 49000,
      discount: 4900,
      amount: 44100,
      commission: 8820,
    });
  });
  it("rounds down so the buyer never pays more and amount + discount = list price", () => {
    Object.assign(process.env, {
      MARKETING_DISCOUNT_PERCENT: "15",
      MARKETING_COMMISSION_PERCENT: "25",
    });
    const p = codePricing(49999); // 15% = 7499.85
    expect(p).toEqual({ listPrice: 49999, discount: 7499, amount: 42500, commission: 10625 });
  });
  it("bad rates fail loudly, and the production config check reports them", () => {
    process.env.MARKETING_DISCOUNT_PERCENT = "95";
    expect(() => codePricing(49000)).toThrow("MARKETING_DISCOUNT_PERCENT");
    const { errors } = checkProductionConfig({
      ...env,
      BETTER_AUTH_SECRET: "x".repeat(32),
      WEB_URL: "https://pyground.id",
      MARKETING_DISCOUNT_PERCENT: "ten",
      MARKETING_COMMISSION_PERCENT: "101",
    });
    expect(errors).toEqual([
      'MARKETING_DISCOUNT_PERCENT must be a whole percentage from 0 to 90, got "ten"',
      'MARKETING_COMMISSION_PERCENT must be a whole percentage from 0 to 100, got "101"',
    ]);
  });
});

describe("marketers table", () => {
  afterAll(cleanupUsers);

  it("one marketer per user, unique handles", async () => {
    const [a, b] = await Promise.all([createUser(), createUser()]);
    const handle = `T${crypto
      .randomUUID()
      .slice(0, 8)
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "")}`;
    await prisma.marketer.create({ data: { userId: a.id, handle, codeSecret: newCodeSecret() } });
    await expect(
      Promise.resolve(
        prisma.marketer.create({ data: { userId: b.id, handle, codeSecret: newCodeSecret() } }),
      ),
    ).rejects.toThrow();
    await expect(
      Promise.resolve(
        prisma.marketer.create({
          data: { userId: a.id, handle: `${handle}X`, codeSecret: newCodeSecret() },
        }),
      ),
    ).rejects.toThrow();
  });
});

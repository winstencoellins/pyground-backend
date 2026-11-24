import { describe, expect, it } from "bun:test";
import { streakOf } from "../src/modules/progress/streak";

// Times are written in WIB (UTC+7) to make Jakarta day boundaries obvious.
const wib = (s: string) => new Date(`${s}+07:00`);
const now = wib("2026-11-24T10:00:00");

describe("streakOf", () => {
  it("no activity -> zeros", () => {
    expect(streakOf([], now)).toEqual({ current: 0, longest: 0, activeToday: false });
  });

  it("counts consecutive Jakarta days ending today; several completions a day count once", () => {
    const s = streakOf(
      [
        wib("2026-11-22T08:00:00"),
        wib("2026-11-23T23:59:00"),
        wib("2026-11-24T00:01:00"),
        wib("2026-11-24T09:00:00"),
      ],
      now,
    );
    expect(s).toEqual({ current: 3, longest: 3, activeToday: true });
  });

  it("last active yesterday -> streak still alive, not active today", () => {
    const s = streakOf([wib("2026-11-22T12:00:00"), wib("2026-11-23T12:00:00")], now);
    expect(s).toEqual({ current: 2, longest: 2, activeToday: false });
  });

  it("a missed day resets current but keeps longest", () => {
    const s = streakOf(
      [
        wib("2026-11-10T12:00:00"),
        wib("2026-11-11T12:00:00"),
        wib("2026-11-12T12:00:00"),
        wib("2026-11-22T12:00:00"),
      ],
      now,
    );
    expect(s).toEqual({ current: 0, longest: 3, activeToday: false });
  });

  it("uses the Jakarta day, not the UTC day", () => {
    // 2026-11-23T18:00Z is 01:00 WIB on the 24th: today in Jakarta, yesterday in UTC.
    const s = streakOf([new Date("2026-11-23T18:00:00Z")], now);
    expect(s).toEqual({ current: 1, longest: 1, activeToday: true });
  });
});

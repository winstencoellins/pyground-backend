const DAY = 86_400_000;
const WIB = 7 * 60 * 60 * 1000; // Asia/Jakarta is UTC+7 all year (no DST)
const jakartaDayNumber = (d: Date) => Math.floor((d.getTime() + WIB) / DAY);

/**
 * Learning streak in Jakarta calendar days, counting days with at least one lesson completed.
 * `current` stays alive through today if the last active day was yesterday (the learner
 * still has today to keep it going); it resets to 0 once a whole day is missed.
 */
export function streakOf(activity: Date[], now = new Date()) {
  const days = [...new Set(activity.map(jakartaDayNumber))].sort((a, b) => a - b);
  let longest = 0;
  let run = 0;
  for (let i = 0; i < days.length; i++) {
    run = i > 0 && days[i] === days[i - 1]! + 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
  }
  const today = jakartaDayNumber(now);
  const last = days.at(-1);
  const current = last !== undefined && last >= today - 1 ? run : 0;
  return { current, longest, activeToday: last === today };
}

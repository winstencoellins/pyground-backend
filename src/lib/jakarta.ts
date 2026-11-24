export const DAY = 86_400_000;
const WIB = 7 * 60 * 60 * 1000; // Asia/Jakarta is UTC+7 all year (no DST)

/** Days since the epoch, counted in Jakarta calendar days. */
export const jakartaDayNumber = (d: Date) => Math.floor((d.getTime() + WIB) / DAY);
/** Start of Jakarta day `n` as a UTC instant. */
export const jakartaDayStart = (n: number) => new Date(n * DAY - WIB);
/** Jakarta day `n` as YYYY-MM-DD. */
export const jakartaDate = (n: number) => new Date(n * DAY).toISOString().slice(0, 10);

export type EmailLocale = "id" | "en";

/** User.locale (ID | EN) -> email language. Anything unexpected falls back to Indonesian. */
export const emailLocale = (user: { locale?: unknown }): EmailLocale =>
  user.locale === "EN" ? "en" : "id";

const L = <T>(id: T, en: T) => ({ id, en });

export const copy = {
  layout: {
    tagline: L(
      "Belajar Python dari nol sampai bisa bikin web app sendiri",
      "Learn Python from zero to building your own web app",
    ),
    supportedBy: L("Didukung oleh Trixync", "Supported by Trixync"),
    ignore: L(
      "Kalau kamu tidak merasa meminta email ini, abaikan saja.",
      "If you didn't request this email, you can safely ignore it.",
    ),
  },
  verification: {
    subject: L("Verifikasi email Pyground-mu", "Verify your Pyground email"),
    preview: L("Satu klik lagi untuk mulai belajar Python", "One click to start learning Python"),
    greeting: L("Halo {name},", "Hi {name},"),
    body: L(
      "Terima kasih sudah mendaftar di Pyground! Klik tombol di bawah untuk memverifikasi email-mu dan mulai belajar.",
      "Thanks for signing up for Pyground! Click the button below to verify your email and start learning.",
    ),
    button: L("Verifikasi email", "Verify email"),
    fallback: L("Atau buka link ini:", "Or open this link:"),
  },
  passwordReset: {
    subject: L("Atur ulang kata sandi Pyground-mu", "Reset your Pyground password"),
    preview: L("Link untuk mengatur ulang kata sandimu", "Your password reset link"),
    greeting: L("Halo {name},", "Hi {name},"),
    body: L(
      "Kami menerima permintaan untuk mengatur ulang kata sandi akunmu. Klik tombol di bawah untuk membuat kata sandi baru. Link ini hanya berlaku sebentar.",
      "We received a request to reset your account password. Click the button below to choose a new one. This link expires soon.",
    ),
    button: L("Atur ulang kata sandi", "Reset password"),
    fallback: L("Atau buka link ini:", "Or open this link:"),
    signedOut: L(
      "Setelah diganti, kamu akan keluar dari semua perangkat.",
      "Once changed, you'll be signed out on all devices.",
    ),
  },
  expiresSoon: {
    subject: L("Akses Pyground-mu berakhir 3 hari lagi", "Your Pyground access ends in 3 days"),
    preview: L(
      "Perpanjang agar belajarmu tidak terputus",
      "Renew so your learning isn't interrupted",
    ),
    greeting: L("Halo {name},", "Hi {name},"),
    body: L(
      "Akses Pyground-mu akan berakhir pada {accessUntil}. Perpanjang sekarang supaya kamu tetap bisa membuka semua materi berbayar dan melanjutkan progresmu.",
      "Your Pyground access ends on {accessUntil}. Renew now to keep every paid lesson unlocked and continue where you left off.",
    ),
    button: L("Perpanjang 30 hari", "Renew for 30 days"),
    note: L(
      "Perpanjangan ditambahkan ke sisa aksesmu, jadi tidak ada hari yang hilang.",
      "Renewing adds to your remaining time, so you won't lose any days.",
    ),
  },
  expiresToday: {
    subject: L("Akses Pyground-mu berakhir hari ini", "Your Pyground access ends today"),
    preview: L("Perpanjang untuk tetap membuka semua materi", "Renew to keep all lessons unlocked"),
    greeting: L("Halo {name},", "Hi {name},"),
    body: L(
      "Akses Pyground-mu berakhir hari ini ({accessUntil}). Setelah itu, materi berbayar akan terkunci, tapi progres dan hasil kuismu tetap tersimpan.",
      "Your Pyground access ends today ({accessUntil}). After that, paid lessons lock again, but your progress and quiz results stay saved.",
    ),
    button: L("Perpanjang sekarang", "Renew now"),
    note: L(
      "Materi gratis di Stage 1 tetap bisa kamu buka kapan saja.",
      "Free Stage 1 lessons stay open any time.",
    ),
  },
  receipt: {
    subject: L("Kwitansi pembayaran Pyground {orderId}", "Pyground payment receipt {orderId}"),
    preview: L(
      "Akses Pyground-mu aktif sampai {accessUntil}",
      "Your Pyground access is active until {accessUntil}",
    ),
    greeting: L("Halo {name},", "Hi {name},"),
    body: L(
      "Terima kasih! Pembayaranmu sudah kami terima dan akses ke semua materi Pyground sudah aktif.",
      "Thank you! We've received your payment and your access to all Pyground lessons is active.",
    ),
    item: L("Item", "Item"),
    itemName: L("Akses Pyground 30 hari", "Pyground 30-day access pass"),
    orderId: L("Nomor pesanan", "Order number"),
    paidAt: L("Tanggal bayar", "Paid on"),
    method: L("Metode pembayaran", "Payment method"),
    total: L("Total", "Total"),
    accessUntil: L("Akses aktif sampai", "Access active until"),
    button: L("Lanjut belajar", "Continue learning"),
    processedBy: L("Pembayaran diproses oleh Trixync.", "Payments are processed by Trixync."),
  },
};

/** "{name}" placeholders -> values. */
export const fill = (text: string, vars: Record<string, string>) =>
  text.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? `{${k}}`);

export const formatRupiah = (amount: number) =>
  new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    maximumFractionDigits: 0,
  }).format(amount);

/** Dates in emails are shown in WIB (Asia/Jakarta). */
export const formatDate = (date: Date, locale: EmailLocale) =>
  new Intl.DateTimeFormat(locale === "id" ? "id-ID" : "en-GB", {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: "Asia/Jakarta",
  }).format(date) + " WIB";

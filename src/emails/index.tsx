import { ActionEmail } from "./ActionEmail";
import { ExpiryEmail } from "./ExpiryEmail";
import { copy, emailLocale, fill } from "./i18n";
import { PaymentReceipt, type ReceiptProps } from "./PaymentReceipt";
import type { Mail } from "./send";

type Recipient = { email: string; name: string; locale?: unknown };

export function authEmail(
  kind: "verification" | "passwordReset",
  user: Recipient,
  url: string,
): Mail {
  const locale = emailLocale(user);
  return {
    to: user.email,
    locale,
    subject: copy[kind].subject[locale],
    react: <ActionEmail kind={kind} locale={locale} name={user.name} url={url} />,
  };
}

export function receiptEmail(
  user: Recipient,
  order: Omit<ReceiptProps, "locale" | "name" | "lessonsUrl">,
): Mail {
  const locale = emailLocale(user);
  return {
    to: user.email,
    locale,
    subject: fill(copy.receipt.subject[locale], { orderId: order.orderId }),
    react: (
      <PaymentReceipt
        {...order}
        locale={locale}
        name={user.name}
        lessonsUrl={`${process.env.WEB_URL}/lessons`}
      />
    ),
  };
}

export function expiryEmail(
  kind: "expiresSoon" | "expiresToday",
  user: Recipient,
  accessUntil: Date,
): Mail {
  const locale = emailLocale(user);
  return {
    to: user.email,
    locale,
    subject: copy[kind].subject[locale],
    react: (
      <ExpiryEmail
        kind={kind}
        locale={locale}
        name={user.name}
        accessUntil={accessUntil}
        renewUrl={`${process.env.WEB_URL}/pricing`}
      />
    ),
  };
}

import { Button, Column, Row, Section, Text } from "@react-email/components";
import { buttonStyle, colors, Layout } from "./components/Layout";
import { copy, fill, formatDate, formatRupiah, type EmailLocale } from "./i18n";

export type ReceiptProps = {
  locale: EmailLocale;
  name: string;
  orderId: string;
  amount: number;
  paidAt: Date;
  paymentType: string | null;
  accessUntil: Date;
  lessonsUrl: string;
};

const METHODS: Record<string, string> = {
  qris: "QRIS",
  gopay: "GoPay",
  shopeepay: "ShopeePay",
  bank_transfer: "Virtual Account",
  echannel: "Mandiri Bill",
  credit_card: "Credit card",
};

export function PaymentReceipt(p: ReceiptProps) {
  const c = copy.receipt;
  const l = p.locale;
  const rows: [string, string][] = [
    [c.item[l], c.itemName[l]],
    [c.orderId[l], p.orderId],
    [c.paidAt[l], formatDate(p.paidAt, l)],
    [c.method[l], p.paymentType ? (METHODS[p.paymentType] ?? p.paymentType) : "-"],
    [c.total[l], formatRupiah(p.amount)],
    [c.accessUntil[l], formatDate(p.accessUntil, l)],
  ];
  return (
    <Layout locale={l} preview={fill(c.preview[l], { accessUntil: formatDate(p.accessUntil, l) })}>
      <Text>{fill(c.greeting[l], { name: p.name })}</Text>
      <Text>{c.body[l]}</Text>
      <Section
        style={{
          border: "1px solid #e5e7eb",
          borderRadius: 6,
          padding: "8px 16px",
          margin: "16px 0",
        }}
      >
        {rows.map(([label, value]) => (
          <Row key={label}>
            <Column style={{ color: colors.muted, fontSize: 13, padding: "6px 0", width: "45%" }}>
              {label}
            </Column>
            <Column
              style={{
                fontSize: 14,
                padding: "6px 0",
                fontWeight: label === c.total[l] ? 700 : 400,
              }}
            >
              {value}
            </Column>
          </Row>
        ))}
      </Section>
      <Button href={p.lessonsUrl} style={buttonStyle}>
        {c.button[l]}
      </Button>
      <Text style={{ color: colors.muted, fontSize: 13, marginTop: 24 }}>{c.processedBy[l]}</Text>
    </Layout>
  );
}

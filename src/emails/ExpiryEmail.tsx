import { Button, Text } from "@react-email/components";
import { buttonStyle, colors, Layout } from "./components/Layout";
import { copy, fill, formatDate, type EmailLocale } from "./i18n";

export function ExpiryEmail(props: {
  kind: "expiresSoon" | "expiresToday";
  locale: EmailLocale;
  name: string;
  accessUntil: Date;
  renewUrl: string;
}) {
  const c = copy[props.kind];
  const l = props.locale;
  return (
    <Layout locale={l} preview={c.preview[l]}>
      <Text>{fill(c.greeting[l], { name: props.name })}</Text>
      <Text>{fill(c.body[l], { accessUntil: formatDate(props.accessUntil, l) })}</Text>
      <Button href={props.renewUrl} style={buttonStyle}>
        {c.button[l]}
      </Button>
      <Text style={{ color: colors.muted, fontSize: 13 }}>{c.note[l]}</Text>
    </Layout>
  );
}

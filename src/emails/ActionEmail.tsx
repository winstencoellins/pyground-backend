// Verification and password reset share one shape: greeting, text, button, raw link.
import { Button, Link, Text } from "@react-email/components";
import { buttonStyle, colors, Layout } from "./components/Layout";
import { copy, fill, type EmailLocale } from "./i18n";

export function ActionEmail(props: {
  kind: "verification" | "passwordReset";
  locale: EmailLocale;
  name: string;
  url: string;
}) {
  const c = copy[props.kind];
  const l = props.locale;
  return (
    <Layout locale={l} preview={c.preview[l]} ignoreNote>
      <Text>{fill(c.greeting[l], { name: props.name })}</Text>
      <Text>{c.body[l]}</Text>
      <Button href={props.url} style={buttonStyle}>
        {c.button[l]}
      </Button>
      {"signedOut" in c ? (
        <Text style={{ color: colors.muted, fontSize: 13 }}>{c.signedOut[l]}</Text>
      ) : null}
      <Text style={{ color: colors.muted, fontSize: 13 }}>
        {c.fallback[l]}{" "}
        <Link href={props.url} style={{ color: colors.primary, wordBreak: "break-all" }}>
          {props.url}
        </Link>
      </Text>
    </Layout>
  );
}

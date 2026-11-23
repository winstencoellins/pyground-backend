import { Body, Container, Head, Hr, Html, Preview, Section, Text } from "@react-email/components";
import type { ReactNode } from "react";
import { copy, type EmailLocale } from "../i18n";

export const colors = { primary: "#3776AB", accent: "#FFD43B", text: "#1f2937", muted: "#6b7280" };

export function Layout(props: {
  locale: EmailLocale;
  preview: string;
  children: ReactNode;
  ignoreNote?: boolean;
}) {
  const { locale } = props;
  return (
    <Html lang={locale}>
      <Head />
      <Preview>{props.preview}</Preview>
      <Body
        style={{
          backgroundColor: "#f3f4f6",
          fontFamily: "Helvetica, Arial, sans-serif",
          margin: 0,
        }}
      >
        <Container
          style={{
            maxWidth: 560,
            margin: "24px auto",
            backgroundColor: "#ffffff",
            borderRadius: 8,
          }}
        >
          <Section
            style={{
              backgroundColor: colors.primary,
              borderRadius: "8px 8px 0 0",
              padding: "20px 32px",
            }}
          >
            <Text style={{ color: colors.accent, fontSize: 24, fontWeight: 700, margin: 0 }}>
              Pyground
            </Text>
            <Text style={{ color: "#ffffff", fontSize: 13, margin: "4px 0 0" }}>
              {copy.layout.tagline[locale]}
            </Text>
          </Section>
          <Section
            style={{ padding: "24px 32px", color: colors.text, fontSize: 15, lineHeight: "24px" }}
          >
            {props.children}
          </Section>
          <Hr style={{ borderColor: "#e5e7eb", margin: 0 }} />
          <Section style={{ padding: "16px 32px" }}>
            {props.ignoreNote ? (
              <Text style={{ color: colors.muted, fontSize: 12, margin: "0 0 8px" }}>
                {copy.layout.ignore[locale]}
              </Text>
            ) : null}
            <Text style={{ color: colors.muted, fontSize: 12, margin: 0 }}>
              Pyground · {copy.layout.supportedBy[locale]}
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

export const buttonStyle = {
  backgroundColor: colors.primary,
  color: "#ffffff",
  borderRadius: 6,
  padding: "12px 20px",
  fontWeight: 600,
  textDecoration: "none",
};

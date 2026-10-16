import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SQL Studio — TCE-CE",
  description:
    "Plataforma de Auditoria Fiscal TCE-CE — Editor SQL com guardrails",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
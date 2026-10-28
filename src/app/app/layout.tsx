import type { Metadata } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans, Instrument_Serif } from "next/font/google";
import "./globals.css";

/**
 * Tipografia do painel Assistente.
 * IBM Plex Sans/Mono para leitura de dados e SQL, Instrument Serif para o
 * título — combinação editorial/técnica coerente com o tom de auditoria.
 */
const plexSans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-plex-sans",
  display: "swap",
});

const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-plex-mono",
  display: "swap",
});

const display = Instrument_Serif({
  subsets: ["latin"],
  weight: ["400"],
  style: ["normal", "italic"],
  variable: "--font-display",
  display: "swap",
});

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
    <html
      lang="pt-BR"
      className={`${plexSans.variable} ${plexMono.variable} ${display.variable}`}
    >
      <body className="font-panel">{children}</body>
    </html>
  );
}

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./hooks/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        /* Tokens semânticos: superfícies, texto, bordas e acento. */
        canvas: "var(--color-canvas)",
        surface: "var(--color-surface)",
        raised: "var(--color-raised)",
        line: {
          DEFAULT: "var(--color-line)",
          strong: "var(--color-line-strong)",
        },
        ink: {
          DEFAULT: "var(--color-ink)",
          soft: "var(--color-ink-soft)",
          muted: "var(--color-ink-muted)",
        },
        accent: {
          DEFAULT: "var(--color-accent)",
          strong: "var(--color-accent-strong)",
        },
      },
      fontFamily: {
        sans: [
          "var(--font-plex-sans)",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "sans-serif",
        ],
        /* Tipografia do painel Assistente (carregada via next/font em layout.tsx) */
        panel: [
          "var(--font-plex-sans)",
          "ui-sans-serif",
          "system-ui",
          "sans-serif",
        ],
        panelmono: [
          "var(--font-plex-mono)",
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "monospace",
        ],
        display: ["var(--font-display)", "ui-serif", "Georgia", "serif"],
      },
      keyframes: {
        "fade-up": {
          "0%": { opacity: "0", transform: "translateY(10px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        shimmer: {
          "0%": { transform: "translateX(-120%)" },
          "100%": { transform: "translateX(420%)" },
        },
        "dot-bounce": {
          "0%, 80%, 100%": { transform: "scale(0.55)", opacity: "0.35" },
          "40%": { transform: "scale(1)", opacity: "1" },
        },
      },
      animation: {
        "fade-up": "fade-up 0.4s cubic-bezier(0.22, 0.61, 0.36, 1) both",
        shimmer: "shimmer 1.9s cubic-bezier(0.4, 0, 0.2, 1) infinite",
        "dot-bounce": "dot-bounce 1.25s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};

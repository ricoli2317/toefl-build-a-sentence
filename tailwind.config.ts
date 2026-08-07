import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./lib/**/*.{js,ts,jsx,tsx,mdx}"
  ],
  theme: {
    extend: {
      colors: {
        ink: "#18212f",
        line: "#d8dee8",
        paper: "#f7f4ee",
        ocean: "#0d9488",
        coral: "#e85d4f",
        gold: "#d99b2b",
        student: {
          bg: "var(--student-bg)",
          surface: "var(--student-surface)",
          text: "var(--student-text)",
          muted: "var(--student-muted)",
          border: "var(--student-border)",
          primary: "var(--student-primary)",
          "primary-hover": "var(--student-primary-hover)",
          "primary-soft": "var(--student-primary-soft)",
          "primary-border": "var(--student-primary-border)",
          error: "var(--student-error)",
          "error-hover": "var(--student-error-hover)",
          "error-soft": "var(--student-error-soft)",
          "error-border": "var(--student-error-border)"
        }
      }
    }
  },
  plugins: []
};

export default config;
